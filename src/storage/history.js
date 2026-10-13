import { WorkerStore } from './worker-store.js'

// HistoryStore selects the rebuildable history worker behind the bounded storage interface.
export class HistoryStore extends WorkerStore {
  constructor (cwd) { super(cwd, new URL('./history-worker.js', import.meta.url), 'History') }
}
