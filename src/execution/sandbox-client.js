import { Worker } from 'node:worker_threads'
import { tmpdir } from 'node:os'
import { shellEnvironment } from './policy.js'

// prepareIsolated keeps each command's sandbox manager alive in its own worker until cleanup.
export async function prepareIsolated (cwd, command, signal) {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./sandbox-worker.js', import.meta.url), { workerData: { cwd, command }, env: shellEnvironment(tmpdir()), execArgv: [] })
  let exited = false
  let closing
  let failure
  const watchers = new Set()
  const ended = new Promise(resolve => worker.once('exit', () => {
    exited = true
    if (!closing) for (const watcher of watchers) watcher(failure || new Error('Sandbox worker exited while the command was active'))
    resolve()
  }))
  worker.on('error', error => { failure = error })
  const cleanup = () => {
    closing ||= (async () => {
      if (exited) return
      worker.postMessage('close')
      const timer = setTimeout(() => worker.terminate(), 5000)
      try { await ended } finally { clearTimeout(timer) }
    })()
    return closing
  }
  let abort
  let timer
  try {
    const launch = await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new Error('Cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      worker.once('message', message => message.error ? reject(new Error(message.error)) : resolve(message.launch))
      worker.once('error', reject)
      worker.once('exit', () => reject(failure || new Error('Sandbox worker exited during preparation')))
      timer = setTimeout(() => reject(new Error('Sandbox preparation exceeded 10 seconds; no command executed')), 10000)
      if (signal.aborted) abort()
    })
    const onFailure = watcher => {
      watchers.add(watcher)
      if (exited && !closing) watcher(failure || new Error('Sandbox worker exited while the command was active'))
      return () => watchers.delete(watcher)
    }
    return { ...launch, cleanup, onFailure }
  } catch (error) {
    await cleanup()
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
