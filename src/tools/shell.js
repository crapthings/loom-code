import { spawn } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Type } from '@earendil-works/pi-ai'
import { ShellExecutor } from '../execution/executor.js'

// shellTool executes an authorized isolated command with bounded output and process-tree cancellation.
export function shellTool (cwd, session, executor = new ShellExecutor({ cwd })) {
  return {
    name: 'shell',
    description: `Run a shell command through ${executor.label}; permissions are enforced by the dispatcher.`,
    effect: 'shell',
    parallel: false,
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })) }),
    execute: async ({ command, timeout = 30 }, { signal, emit }) => {
      signal.throwIfAborted()
      const artifact = `${randomUUID()}.txt`
      const output = await open(path.join(session.directory, artifact), 'wx', 0o600)
      let launch
      let child
      let timer
      let killTimer
      let bytes = 0
      let stopped = ''
      const terminate = (reason) => {
        if (!child || stopped) return
        stopped = reason
        killProcess(child, 'SIGTERM')
        killTimer = setTimeout(() => killProcess(child, 'SIGKILL'), 500)
      }
      const abort = () => terminate('cancelled')
      try {
        launch = await executor.prepare(command, signal)
        signal.throwIfAborted()
        child = spawn(launch.command, launch.args, { cwd, env: launch.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        timer = setTimeout(() => terminate('timeout'), timeout * 1000)
        let writing = Promise.resolve()
        let writeError
        const capture = chunk => {
          bytes += chunk.length
          if (bytes > 10 * 1024 * 1024) { terminate('output limit'); return }
          writing = writing.then(() => output.write(chunk)).catch(error => { writeError = error; terminate('output write failed') })
        }
        child.stdout.on('data', capture)
        child.stderr.on('data', capture)
        emit({ type: 'tool.progress', kind: 'process.started', boundary: launch.label, pid: child.pid, text: `${launch.label} process ${child.pid} started` })
        const code = await new Promise((resolve, reject) => {
          child.once('error', reject)
          child.once('close', resolve)
        })
        await writing
        if (writeError) throw writeError
        await output.sync()
        const text = await readFile(path.join(session.directory, artifact), 'utf8')
        const preview = text.length > 12000 ? `${text.slice(0, 6000)}\n[... truncated ...]\n${text.slice(-6000)}` : text
        return { text: `exit: ${code}; status: ${stopped || 'completed'}; artifact: ${artifact}\n${preview}`, isError: Boolean(stopped) || code !== 0 }
      } finally {
        if (child?.pid) killProcess(child, 'SIGKILL')
        clearTimeout(timer)
        clearTimeout(killTimer)
        signal.removeEventListener('abort', abort)
        try { await output.close() } finally { await launch?.cleanup() }
      }
    }
  }
}

// killProcess signals the complete Unix process group while tolerating already-exited processes.
function killProcess (child, signal) {
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
