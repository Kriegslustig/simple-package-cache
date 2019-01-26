const express = require('express')
const uuid = require('uuid')
const crypto = require('crypto')
const fs = require('fs')
const util = require('util')
const path = require('path')
const _rimraf = require('rimraf')
const cp = require('child_process')
const zlib = require('zlib')
const Busboy = require('busboy')

const { spawn } = require('./utils/process')

const DATA_DIRECTORY =
  process.env.DATA_DIRECTORY ||
  path.join(__dirname, 'data')
const PORT =
  process.env.PORT ||
  8080

const app = express()

const mkdir = util.promisify(fs.mkdir)
const rename = util.promisify(fs.rename)
const stat = util.promisify(fs.stat)
const unlink = util.promisify(fs.unlink)
const writeFile = util.promisify(fs.writeFile)
const rimraf = util.promisify(_rimraf)

app.post('/-/install', async (req, res) => {
  const installId = uuid()
  let installDirectory
  let tarFile
  let lockfilePath
  let packagePath
  try {
    try {
      await mkdir(DATA_DIRECTORY)
    } catch(e) {}
    lockfilePath = path.join(DATA_DIRECTORY, `${installId}.yarn.lock`)
    packagePath = path.join(DATA_DIRECTORY, `${installId}.package.json`)
    await writeRequestFiles(req, {
      'package.json': packagePath,
      'yarn.lock': lockfilePath,
    })

    const lockHash = await createFileHash(lockfilePath)
    const archiveFile = path.join(DATA_DIRECTORY, `${lockHash}.tar.gz`)
    const hasCache = await isFile(archiveFile)

    if (!hasCache) {
      installDirectory = path.join(DATA_DIRECTORY, lockHash)
      await rimraf(installDirectory)
      await mkdir(installDirectory, { recursive: true })

      const newLockfile = path.join(installDirectory, 'yarn.lock')
      const newPackagePath = path.join(installDirectory, 'package.json')
      await rename(lockfilePath, newLockfile)
      await rename(packagePath, newPackagePath)
      lockfilePath = null
      packagePath = null
      let packageJson = path.join(installDirectory, 'package.json')

      await spawn(
        require.resolve('yarn/bin/yarn'),
        ['install', '--pure-lockfile'],
        { cwd: installDirectory }
      )

      tarFile = path.join(DATA_DIRECTORY, `${lockHash}.tar`)

      await spawn(
        'tar',
        ['-rf', tarFile, 'node_modules'],
        { cwd: installDirectory }
      )

      await createGzip(tarFile, archiveFile)
    }

    res.status(200)
    await writeFileToResponse(archiveFile, res)
  } catch (err) {
    console.error(`Error in install: ${installId}`)
    console.error(err)

    if (!res.headersSent) {
      res.status(500)
    }

    if (!res.finished) {
      res.end(`Install failed: ${installId}\n${err.message}`)
    }
  } finally {
    if (packagePath) await unlink(packagePath)
    if (lockfilePath) await unlink(lockfilePath)
    if (installDirectory) await rimraf(installDirectory)
    if (tarFile) await unlink(tarFile)
  }
})

const isFile = async (filePath) => {
  try {
    const stats = await stat(filePath)
    return stats.isFile()
  } catch (e) {
    return false
  }
}

const createFileHash = (filePath) => new Promise((res, rej) => {
  const hash = crypto.createHash('sha256')
  const input = fs.createReadStream(filePath)

  input.pipe(hash)
    .on('readable', () => {
      const data = hash.read()
      if (data) {
        res(data.toString('hex'))
      }
    })
    .on('error', rej)
})

const writeRequestFiles = (request, files) => new Promise((res, rej) => {
  const busboy = new Busboy({ headers: request.headers })
  const filesToBeWritten = new Set(Object.keys(files))

  const done = () => {
    if (!filesToBeWritten.length) {
      res()
    }
  }

  busboy.on('file', (fieldname, file) => {
    const dst = files[fieldname]
    if (!dst) return
    delete files[fieldname]
    const writeStream = fs.createWriteStream(dst)
    file.pipe(writeStream)
      .on('close', () => {
        filesToBeWritten.delete(fieldname)
        done()
      })
  })

  busboy
    .on('finish', () => {
      const missingFiles = Object.keys(files)
      if (missingFiles.length) {
        rej(new Error(`Missing files: ${missingFiles.join(', ')}`))
      }
    })
    .on('error', rej)

  request.pipe(busboy)
})

const createGzip = (src, dst) => new Promise((res, rej) => {
  const gzip = zlib.createGzip()
  const srcStream = fs.createReadStream(src)
  const dstStream = fs.createWriteStream(dst)

  srcStream.pipe(gzip).pipe(dstStream)
    .on('close', () => { res() })
    .on('error', rej)
})

const writeFileToResponse = (archiveFile, response) => new Promise((res, rej) => {
  const input = fs.createReadStream(archiveFile)

  input.pipe(response)
    .on('finish', () => { res() })
    .on('error', rej)
})

app.listen(PORT)
