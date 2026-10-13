import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { readText } from '../io.js'

// sessionId rejects identifiers that could escape the workspace's session directory.
export function sessionId (id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid history session ID')
  return id
}

// historyRoot validates real metadata directories without creating a session or repairing its journal.
export async function historyRoot (cwd) {
  cwd = await realpath(cwd)
  const root = path.join(cwd, '.loom', 'sessions')
  for (const directory of [path.join(cwd, '.loom'), root]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error('History metadata must use real directories')
  }
  return { cwd, root }
}

// historyFile validates a bounded regular journal and returns its change fingerprint.
export async function historyFile (cwd, id) {
  const { root } = await historyRoot(cwd)
  const directory = path.join(root, sessionId(id))
  if (!(await lstat(directory)).isDirectory()) throw new Error('History session must use a real directory')
  const file = path.join(directory, 'events.jsonl')
  const info = await lstat(file)
  if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024) throw new Error('History journal must be a bounded regular file')
  return { file, size: info.size, signature: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` }
}

// readHistorySource loads only complete canonical events and validates their workspace and sequence.
export async function readHistorySource (cwd, id) {
  const source = await historyFile(cwd, id)
  const raw = await readText(source.file, 16 * 1024 * 1024)
  const events = raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse)
  if (events.some((event, index) => event.seq !== index || typeof event.id !== 'string' || typeof event.type !== 'string')) throw new Error('Invalid history event sequence')
  const meta = events.find(event => event.type === 'session.created')
  if (meta?.cwd !== cwd) throw new Error('History belongs to a different workspace')
  return { ...source, events }
}

// historySessions enumerates a bounded set of real session directories for explicit index refreshes.
export async function historySessions (cwd) {
  const { root } = await historyRoot(cwd)
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-zA-Z0-9-]{1,80}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))
  return { ids: entries.slice(0, 1000).map(entry => entry.name), omitted: Math.max(0, entries.length - 1000) }
}
