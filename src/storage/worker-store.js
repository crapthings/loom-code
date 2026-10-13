import { Worker } from 'node:worker_threads'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// WorkerStore pairs bounded storage requests and keeps blocking database operations off the terminal thread.
export class WorkerStore {
  constructor (cwd, workerUrl, label) {
    this.cwd = cwd
    this.workerUrl = workerUrl
    this.label = label
    this.pending = new Map()
    this.closed = false
  }

  async request (action, args, { signal, timeoutMs = 10000 } = {}) {
    signal?.throwIfAborted()
    if (this.closed) throw new Error(`${this.label} store has closed`)
    await this.stopping
    const cwd = await realpath(this.cwd)
    signal?.throwIfAborted()
    if (this.closed) throw new Error(`${this.label} store has closed`)
    if (!this.worker) {
      const worker = new Worker(this.workerUrl, { workerData: { cwd } })
      this.worker = worker
      worker.on('message', ({ id, result, error }) => {
        const pending = this.pending.get(id)
        if (pending) pending.finish(error ? new Error(error) : null, result)
      })
      worker.on('error', error => { if (this.worker === worker) this.stop(error) })
      worker.on('exit', () => { if (this.worker === worker) this.stop(new Error(`${this.label} worker exited`)) })
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const cancel = () => this.stop(signal.reason || new Error(`${this.label} query cancelled`))
      const timer = setTimeout(() => this.stop(new Error(`${this.label} query deadline exceeded`)), timeoutMs)
      const finish = (error, result) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        this.pending.delete(id)
        if (error) reject(error)
        else resolve(result)
      }
      this.pending.set(id, { finish })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      else this.worker.postMessage({ id, action, args })
    })
  }

  stop (error) {
    const worker = this.worker
    this.worker = null
    for (const pending of this.pending.values()) pending.finish(error)
    const stopped = worker?.terminate()
    this.stopping = Promise.all([this.stopping, stopped])
    return this.stopping
  }

  async close () {
    this.closed = true
    await this.stop(new Error(`${this.label} store has closed`))
  }
}
