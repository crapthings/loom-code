import { WorkerStore } from './worker-store.js'

// MemoryStore selects the authoritative project memory worker independently of the disposable history index.
export class MemoryStore extends WorkerStore {
  constructor (cwd) { super(cwd, new URL('./memory-worker.js', import.meta.url), 'Memory') }
}
