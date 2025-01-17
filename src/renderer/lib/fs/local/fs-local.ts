import ipc from "../../ipc"
import memoryCache from "../../memoryCache"
import { isFileOrFolderNameIgnoredByDefault, convertTimestampToMs, Semaphore } from "../../helpers"
import { downloadChunk } from "../../api"
import { decryptData } from "../../crypto"
import { v4 as uuidv4 } from "uuid"
import { maxDownloadThreads } from "../../constants"
import db from "../../db"

const fs = window.require("fs-extra")
const pathModule = window.require("path")
const readdirp = window.require("readdirp")
const log = window.require("electron-log")
const is = window.require("electron-is")

const downloadThreadsSemaphore = new Semaphore(maxDownloadThreads)
const localFSSemaphore = new Semaphore(1)

export const normalizePath = (path: string): string => {
    return pathModule.normalize(path)
}

export const checkLastModified = (path: string): Promise<{ changed: boolean, mtimeMs?: number }> => {
    return new Promise((resolve, reject) => {
        localFSSemaphore.acquire().then(() => {
            path = normalizePath(path)

            fs.lstat(path).then((stat: any) => {
                if(stat.mtimeMs > 0){
                    localFSSemaphore.release()

                    return resolve({
                        changed: false
                    })
                }

                const lastModified = new Date()
                const mtimeMs = lastModified.getTime()
                
                fs.utimes(path, lastModified, lastModified).then(() => {
                    localFSSemaphore.release()

                    return resolve({
                        changed: true,
                        mtimeMs 
                    })
                }).catch((err: any) => {
                    localFSSemaphore.release()

                    return reject(err)
                })
            }).catch((err: any) => {
                localFSSemaphore.release()

                return reject(err)
            })
        })
    })
}

export const getTempDir = (): Promise<string> => {
    return new Promise((resolve, reject) => {
        if(memoryCache.has("tmpDir")){
            return resolve(memoryCache.get("tmpDir"))
        }

        ipc.getAppPath("temp").then((tmpDir) => {
            tmpDir = normalizePath(tmpDir)

            memoryCache.set("tmpDir", tmpDir)

            return resolve(tmpDir)
        }).catch(reject)
    })
}

export const smokeTest = (path: string): Promise<boolean> => {
    return new Promise(async (resolve, reject) => {
        path = normalizePath(path)

        try{
            await localFSSemaphore.acquire()

            const tmpDir = await getTempDir()

            await Promise.all([
                fs.lstat(path),
                fs.lstat(tmpDir)
            ])
        }
        catch(e){
            localFSSemaphore.release()

            return reject(e)
        }

        localFSSemaphore.release()

        return resolve(true)
    })
}

export const directoryTree = (path: string, skipCache: boolean = false, location?: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        const cacheKey = "directoryTreeLocal:" + location.uuid

        Promise.all([
            db.get("localDataChanged:" + location.uuid),
            db.get(cacheKey),
            db.get("excludeDot")
        ]).then(([localDataChanged, cachedLocalTree, excludeDot]) => {
            if(!localDataChanged && cachedLocalTree !== null && !skipCache){
                return resolve({
                    changed: false,
                    data: cachedLocalTree
                })
            }

            path = normalizePath(path)

            const files: any = {}
            const folders: any = {}
            const ino: any = {}
            const windows: boolean = is.windows()

            readdirp(path, {
                alwaysStat: true,
                lstat: true,
                type: "all",
                depth: 2147483648,
                directoryFilter: ["!.filen.trash.local"]
            }).on("data", (item: any) => {
                if(windows){
                    item.path = item.path.split("\\").join("/") // Convert windows \ style path seperators to / for internal database, we only use UNIX style path seperators internally
                }

                let include = true

                if(excludeDot && item.basename.startsWith(".")){
                    include = false
                }

                if(include && !isFileOrFolderNameIgnoredByDefault(item.basename)){
                    if(item.stats.isDirectory()){
                        folders[item.path] = {
                            name: item.basename,
                            lastModified: convertTimestampToMs(parseInt(item.stats.mtimeMs.toString())) //.toString() because of BigInt
                        }

                        ino[item.stats.ino] = {
                            type: "folder",
                            path: item.path
                        }
                    }
                    else{
                        if(item.stats.size > 0){
                            files[item.path] = {
                                name: item.basename,
                                size: parseInt(item.stats.size.toString()), //.toString() because of BigInt
                                lastModified: convertTimestampToMs(parseInt(item.stats.mtimeMs.toString())) //.toString() because of BigInt
                            }

                            ino[item.stats.ino] = {
                                type: "file",
                                path: item.path
                            }
                        }
                    }
                }
            }).on("warn", (warn: any) => {
                log.error(warn)
            }).on("error", (err: any) => {
                return reject(err)
            }).on("end", async () => {
                const obj = {
                    files,
                    folders,
                    ino
                }

                try{
                    memoryCache.set(cacheKey, obj)

                    await db.set(cacheKey, obj)
                    await db.set("localDataChanged:" + location.uuid, false)
                }
                catch(e){
                    return reject(e)
                }

                return resolve({
                    changed: true,
                    data: obj
                })
            })
        }).catch(reject)
    })
}

export const readChunk = (path: string, offset: number, length: number): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        path = pathModule.normalize(path)

        fs.open(path, "r", (err: any, fd: any) => {
            if(err){
                return reject(err)
            }

            const buffer = Buffer.alloc(length)

            fs.read(fd, buffer, 0, length, offset, (err: any, read: any) => {
                if(err){
                    return reject(err)
                }

                let data: any = undefined

                if(read < length){
                    data = buffer.slice(0, read)
                }
                else{
                    data = buffer
                }

                fs.close(fd, (err: any) => {
                    if(err){
                        return reject(err)
                    }

                    return resolve(data)
                })
            })
        })
    })
}

export const rm = (path: string): Promise<boolean> => {
    return new Promise(async (resolve, reject) => {
        path = normalizePath(path)

        await localFSSemaphore.acquire()

        try{
            var stats = await fs.lstat(path)
        }
        catch(e){
            localFSSemaphore.release()

            return resolve(true)
        }
    
        if(stats.isSymbolicLink()){
            try{
                await fs.unlink(path)
            }
            catch(e){
                localFSSemaphore.release()

                return reject(e)
            }
        }
        else{
            try{
                await fs.remove(path)
            }
            catch(e){
                localFSSemaphore.release()

                return reject(e)
            }
        }

        localFSSemaphore.release()

        return resolve(true)
    })
}

export const mkdir = (path: string, location: any, task: any): Promise<any> => {
    return new Promise((resolve, reject) => {
        localFSSemaphore.acquire().then(() => {
            const absolutePath = normalizePath(location.local + "/" + path)

            fs.ensureDir(absolutePath).then(() => {
                fs.lstat(absolutePath).then((stat: any)  => {
                    localFSSemaphore.release()

                    return resolve(stat)
                }).catch((err: any) => {
                    localFSSemaphore.release()

                    return reject(err)
                })
            }).catch((err: any) => {
                localFSSemaphore.release()

                return reject(err)
            })
        })
    })
}

export const download = (path: string, location: any, task: any): Promise<any> => {
    return new Promise(async (resolve, reject) => {
        await new Promise((resolve) => {
            const getPausedStatus = () => {
                db.get("paused").then((paused) => {
                    if(paused){
                        return setTimeout(getPausedStatus, 1000)
                    }

                    return resolve(true)
                }).catch((err) => {
                    log.error(err)

                    return setTimeout(getPausedStatus, 1000)
                })
            }

            return getPausedStatus()
        })

        try{
            var absolutePath = normalizePath(location.local + "/" + path)
            var parentPath = pathModule.dirname(absolutePath)
            var file = task.item
        }
        catch(e){
            return reject(e)
        }

        Promise.all([
            fs.ensureDir(parentPath),
            getTempDir()
        ]).then(([_, tmpDir]) => {
            try{
                var fileTmpPath = normalizePath(tmpDir + "/" + uuidv4())
            }
            catch(e){
                return reject(e)
            }

            Promise.all([
                rm(absolutePath),
                rm(fileTmpPath)
            ]).then(async () => {
                try{
                    var stream = fs.createWriteStream(fileTmpPath)
                }
                catch(e){
                    return reject(e)
                }

                const fileChunks = file.chunks
                let currentWriteIndex = 0

                const downloadTask = (index: number): Promise<{ index: number, data: Buffer }> => {
                    return new Promise((resolve, reject) => {
                        downloadChunk({ 
                            region: file.region,
                            bucket: file.bucket,
                            uuid: file.uuid,
                            index,
                            from: "sync"
                        }).then((data) => {
                            decryptData(data, file.metadata.key, file.version).then((decrypted) => {
                                return resolve({
                                    index,
                                    data: Buffer.from(decrypted)
                                })
                            }).catch(reject)
                        }).catch(reject)
                    })
                }

                const writeChunk = (index: number, data: Buffer) => {
                    if(index !== currentWriteIndex){
                        return setTimeout(() => {
                            writeChunk(index, data)
                        }, 10)
                    }

                    stream.write(data, (err: any) => {
                        if(err){
                            return reject(err)
                        }

                        currentWriteIndex += 1

                        return true
                    })
                }

                try{
                    await new Promise((resolve, reject) => {
                        let done = 0

                        for(let i = 0; i < fileChunks; i++){
                            downloadThreadsSemaphore.acquire().then(() => {
                                downloadTask(i).then(({ index, data }) => {
                                    writeChunk(index, data)

                                    done += 1

                                    downloadThreadsSemaphore.release()

                                    if(done >= fileChunks){
                                        return resolve(true)
                                    }
                                }).catch((err) => {
                                    downloadThreadsSemaphore.release()

                                    return reject(err)
                                })
                            })
                        }
                    })

                    await new Promise((resolve) => {
                        if(currentWriteIndex >= fileChunks){
                            return resolve(true)
                        }

                        const wait = setInterval(() => {
                            if(currentWriteIndex >= fileChunks){
                                clearInterval(wait)

                                return resolve(true)
                            }
                        }, 10)
                    })

                    await new Promise((resolve, reject) => {
                        stream.close((err: any) => {
                            if(err){
                                return reject(err)
                            }

                            return resolve(true)
                        })
                    })
                }
                catch(e){
                    fs.unlink(fileTmpPath)

                    return reject(e)
                }

                move(fileTmpPath, absolutePath).then(() => {
                    fs.utimes(absolutePath, new Date(convertTimestampToMs(file.metadata.lastModified)), new Date(convertTimestampToMs(file.metadata.lastModified))).then(() => {
                        checkLastModified(absolutePath).then(() => {
                            fs.lstat(absolutePath).then((stat: any) => {
                                if(stat.size <= 0){
                                    rm(absolutePath)
            
                                    return reject(new Error(absolutePath + " size = " + stat.size))
                                }
                                
                                return resolve(stat)
                            }).catch(reject)
                        }).catch(reject)
                    }).catch(reject)
                }).catch(reject)
            }).catch(reject)
        }).catch(reject)
    })
}

export const move = (before: string, after: string, overwrite: boolean = true): Promise<any> => {
    return new Promise((resolve, reject) => {
        localFSSemaphore.acquire().then(() => {
            try{
                before = normalizePath(before)
                after = normalizePath(after)
            }
            catch(e){
                localFSSemaphore.release()

                return reject(e)
            }
    
            fs.move(before, after, {
                overwrite
            }).then((res: any) => {
                localFSSemaphore.release()

                return resolve(res)
            }).catch((err: any) => {
                localFSSemaphore.release()

                return reject(err)
            })
        })
    })
}

export const rename = (before: string, after: string): Promise<any> => {
    return new Promise((resolve, reject) => {
        localFSSemaphore.acquire().then(() => {
            try{
                before = normalizePath(before)
                after = normalizePath(after)
            }
            catch(e){
                localFSSemaphore.release()

                return reject(e)
            }
    
            fs.rename(before, after).then((res: any) => {
                localFSSemaphore.release()

                return resolve(res)
            }).catch((err: any) => {
                localFSSemaphore.release()

                return reject(err)
            })
        })
    })
}