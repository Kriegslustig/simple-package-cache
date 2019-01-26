const cp = require('child_process')

const spawn = (command, args, options) =>
  new Promise((res, rej) => {
    const process = cp.spawn(
      command,
      args,
      options
    )

    let output = ''
    const appendOutput = (data) => {
      output += data.toString()
    }
    process.stdout.on('data', appendOutput)
    process.stderr.on('data', appendOutput)

    process.on('error', rej)

    process.on('close', (code) => {
      if (code > 0) {
        rej(new Error(output))
      } else {
        res(output)
      }
    })
  })

module.exports = { spawn }
