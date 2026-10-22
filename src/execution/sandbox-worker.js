import { parentPort, workerData } from 'node:worker_threads'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { ShellExecutor } from './executor.js'

// controller cancels preparation before an isolated sandbox launch is handed to its owner.
const controller = new AbortController()

// preparation owns one runtime instance and its cleanup for the lifetime of one command.
const preparation = new ShellExecutor({ cwd: workerData.cwd, manager: SandboxManager }).prepare(workerData.command, controller.signal)

// The owner releases this worker only after its process group has stopped.
parentPort.on('message', async message => {
  if (message !== 'close') return
  controller.abort(new Error('Sandbox preparation cancelled'))
  try { await (await preparation).cleanup() } catch {} finally { parentPort.close() }
})

preparation.then(({ cleanup, ...launch }) => parentPort.postMessage({ launch }), error => parentPort.postMessage({ error: error.message }))
