'use strict'

// Synthetic verifier only. It deliberately leaves both this process and a
// descendant alive so RuntimeMaxSec/TERM/KILL must clear the whole cgroup.
const { spawn } = require('node:child_process')
spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
  stdio: 'ignore',
  detached: false,
})
setInterval(() => {}, 60_000)
