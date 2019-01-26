const express = require('express')
const uuid = require('uuid')
const crypto = require('crypto')
const fs = require('fs')
const util = require('util')
const path = require('path')
const _rimraf = require('rimraf')
const cp = require('child_process')
const zlib = require('zlib')
const Busboy = require('Busboy')

const DATA_DIRECTORY =
  process.env.DATA_DIRECTORY ||
  path.join(__dirname, 'data')

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
      lockfilePath = newLockfile
      packagePath = newPackagePath
      let packageJson = path.join(installDirectory, 'package.json')

      await runInstall(installDirectory)

      tarFile = path.join(DATA_DIRECTORY, `${lockHash}.tar`)
      await createTar(installDirectory, 'node_modules', tarFile)
      await createGzip(tarFile, archiveFile)
    }

    res.status(200)
    await writeFileToResponse(archiveFile, res)
  } catch (err) {
    console.error(`Error in install: ${installId}`)
    console.error(err)

    if (lockfilePath) await unlink(lockfilePath)
    if (packagePath) await unlink(packagePath)

    if (!res.headersSent) {
      res.status(500)
    }

    if (!res.finished) {
      res.end(`Install failed: ${installId}`)
    }
  } finally {
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

const runInstall = (cwd) => new Promise((res, rej) => {
  const process = cp.spawn(
    require.resolve('yarn/bin/yarn'),
    ['install', '--pure-lockfile'],
    { cwd }
  )

  process.on('close', (code) => {
    if (code > 0) {
      rej(new Error('Failed to install'))
    } else {
      res()
    }
  })
})

const createTar = (cwd, src, dst) => new Promise((res, rej) => {
  const process = cp.spawn(
    'tar',
    ['-rf', dst, src],
    { cwd }
  )

  process.on('close', (code) => {
    if (code > 0) {
      rej(new Error('Failed to create tar archive'))
    } else {
      res()
    }
  })
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

app.listen(8080)
