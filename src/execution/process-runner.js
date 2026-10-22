import { spawn } from 'node:child_process'

// child is the sandboxed command owned by this process group and its parent IPC connection.
let child

// finish propagates the command's exit while the owner drains and closes inherited output pipes.
function finish (code) {
  process.exit(code ?? 1)
}

// Losing the harness connection stops the owned group instead of leaving a detached background command alive.
process.on('disconnect', () => {
  if (process.platform === 'win32') { child?.kill('SIGKILL'); finish(1) } else process.kill(-process.pid, 'SIGKILL')
})

// Only the trusted owner supplies the already sandbox-wrapped executable and sanitized environment over IPC.
process.once('message', ({ command, args, env }) => {
  try {
    child = spawn(command, args, { cwd: process.cwd(), env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', error => process.stderr.write(`${error.message}\n`, () => finish(1)))
    child.once('exit', finish)
  } catch (error) { process.stderr.write(`${error.message}\n`, () => finish(1)) }
})
