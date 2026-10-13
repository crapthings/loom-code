import { DatabaseSync } from 'node:sqlite'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parentPort, workerData } from 'node:worker_threads'
import { historyRoot, historyFile, readHistorySource } from './history-source.js'

// digest ties a memory source or mutation receipt to its exact serialized content.
function digest (value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

// boundedText rejects empty or oversized fields within the memory input limits.
function boundedText (value, limit, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Error(`Invalid memory ${name}`)
  return value.trim()
}

// memoryScope confines path-specific applicability to normalized relative workspace paths.
function memoryScope (scope, file) {
  if (!['project', 'path'].includes(scope)) throw new Error('Invalid memory scope')
  if (scope === 'project') {
    if (file) throw new Error('Project memories cannot specify a path')
    return null
  }
  file = boundedText(file, 512, 'path')
  if (path.isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || ['.', '..'].includes(part))) throw new Error('Memory path must be a normalized relative path')
  return file
}

// MemoryDatabase stores immutable revisions and atomic mutation receipts separately from the history cache.
class MemoryDatabase {
  async open ({ create = false } = {}) {
    if (this.db) return this.db
    await historyRoot(workerData.cwd)
    const file = path.join(workerData.cwd, '.loom', 'memory.sqlite')
    let exists = false
    for (const candidate of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
      try {
        const info = await lstat(candidate)
        if (!info.isFile() || info.nlink !== 1) throw new Error('Memory database paths must be regular, unlinked files')
        if (candidate === file) exists = true
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!exists && !create) return null
    if (!exists) {
      try {
        const handle = await open(file, 'wx', 0o600)
        await handle.close()
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const info = await lstat(file)
        if (!info.isFile() || info.nlink !== 1) throw new Error('Memory database must be a regular, unlinked file')
      }
    }
    const db = new DatabaseSync(file, { timeout: 250, allowExtension: false })
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (![0, 1].includes(version)) throw new Error('Unsupported memory schema; do not delete authoritative memory to rebuild an index')
      db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA; PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS revisions (id TEXT NOT NULL, revision INTEGER NOT NULL, scope TEXT NOT NULL, path TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, sources TEXT NOT NULL, updated INTEGER NOT NULL, expires INTEGER, PRIMARY KEY(id, revision));
        CREATE TABLE IF NOT EXISTS heads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, FOREIGN KEY(id, revision) REFERENCES revisions(id, revision));
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT NOT NULL);
        PRAGMA user_version = 1;`)
      this.db = db
      return db
    } catch (error) { db.close(); throw error }
  }

  async source (cache, id) {
    if (!cache.has(id)) {
      const { size } = await historyFile(workerData.cwd, id)
      const bytes = [...cache.values()].reduce((total, source) => total + source.size, 0)
      if (bytes + size > 64 * 1024 * 1024) throw new Error('Memory source read limit exceeded')
      cache.set(id, await readHistorySource(workerData.cwd, id))
    }
    return cache.get(id)
  }

  async sources (references) {
    if (!Array.isArray(references) || references.length < 1 || references.length > 8) throw new Error('Memory requires 1–8 source events')
    const result = []
    const cache = new Map()
    for (const reference of references) {
      if (!Number.isInteger(reference.seq) || reference.seq < 0) throw new Error('Invalid memory source sequence')
      const source = await this.source(cache, reference.sessionId)
      const event = source.events[reference.seq]
      if (!event || !((event.type === 'inbox.delivered' && event.message?.role === 'user') || (event.type === 'tool.finished' && event.message?.role === 'toolResult' && event.status === 'completed' && event.executed !== false && !event.message.isError && !['search_history', 'read_history', 'list_memories', 'get_memory', 'remember', 'forget_memory'].includes(event.message.toolName)))) throw new Error('Memory sources must be original user input or successful tool evidence, not model claims or recalled copies')
      result.push({ sessionId: reference.sessionId, seq: reference.seq, eventId: event.id, digest: digest(event), role: event.message.role })
    }
    return result
  }

  row (row) {
    if (!row) return null
    const { expires, ...record } = row
    return { ...record, sources: JSON.parse(row.sources), expiresAt: expires, storedStatus: row.status, status: row.status === 'active' && expires !== null && expires <= Date.now() ? 'stale' : row.status }
  }

  async list ({ query = '', file, includeInactive = false, limit = 10, offset = 0 } = {}) {
    if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw new Error('Invalid memory query or pagination')
    if (file) memoryScope('path', file)
    const db = await this.open()
    if (!db) return { records: [], nextOffset: null }
    const rows = db.prepare(`SELECT r.* FROM revisions r JOIN heads h ON h.id = r.id AND h.revision = r.revision WHERE instr(lower(r.text), lower(?)) > 0 ${includeInactive ? '' : "AND r.status = 'active' AND (r.expires IS NULL OR r.expires > ?)"} ${file ? "AND (r.scope = 'project' OR r.path = ? OR substr(?, 1, length(r.path) + 1) = r.path || '/')" : ''} ORDER BY r.updated DESC, r.id LIMIT ? OFFSET ?`).all(query, ...(!includeInactive ? [Date.now()] : []), ...(file ? [file, file] : []), limit + 1, offset)
    return { records: rows.slice(0, limit).map(row => this.row(row)), nextOffset: rows.length > limit ? offset + limit : null, sourceValidation: 'unchecked; use get_memory before relying on recalled evidence' }
  }

  async get ({ id, revision }) {
    boundedText(id, 80, 'ID')
    const db = await this.open()
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new Error('Invalid memory revision')
    const row = revision === undefined
      ? db?.prepare('SELECT r.* FROM revisions r JOIN heads h ON h.id = r.id AND h.revision = r.revision WHERE r.id = ?').get(id)
      : db?.prepare('SELECT * FROM revisions WHERE id = ? AND revision = ?').get(id, revision)
    if (!row) throw new Error('Memory not found')
    const record = this.row(row)
    const checks = []
    const cache = new Map()
    for (const source of record.sources) {
      try {
        const evidence = await this.source(cache, source.sessionId)
        const event = evidence.events[source.seq]
        checks.push({ ...source, state: event?.id === source.eventId && digest(event) === source.digest ? 'available' : 'changed' })
      } catch { checks.push({ ...source, state: 'unavailable' }) }
    }
    if (record.status === 'active' && checks.some(source => source.state !== 'available')) record.status = 'stale'
    return { ...record, isCurrentRevision: record.revision === db.prepare('SELECT revision FROM heads WHERE id = ?').get(id).revision, sources: checks, revisionCount: db.prepare('SELECT count(*) AS count FROM revisions WHERE id = ?').get(id).count, caution: 'Source availability does not prove current code or tests still agree; revalidate applicable facts.' }
  }

  async mutate (action, args) {
    const operationId = boundedText(args.operationId, 200, 'operation ID')
    const hash = digest({ action, args })
    const db = await this.open({ create: true })
    const receipt = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId)
    if (receipt) {
      if (receipt.digest !== hash) throw new Error('Memory operation ID reused with different arguments')
      return { ...JSON.parse(receipt.result), reused: true }
    }
    let record
    if (action === 'save') {
      const text = boundedText(args.text, 4000, 'text')
      const scope = args.scope || 'project'
      const file = memoryScope(scope, args.path)
      const kind = args.kind || 'fact'
      if (!['preference', 'convention', 'fact'].includes(kind)) throw new Error('Invalid memory kind')
      if (args.expiresAt !== undefined && (!Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now())) throw new Error('Memory expiration must be a future timestamp')
      record = { id: args.id || randomUUID(), scope, path: file, kind, text, status: 'active', reason: null, sources: await this.sources(args.sources), expires: args.expiresAt ?? null }
    } else {
      if (!['stale', 'archived'].includes(args.status)) throw new Error('Memory invalidation must be stale or archived')
      record = { id: args.id, status: args.status, reason: boundedText(args.reason, 500, 'reason') }
    }
    boundedText(record.id, 80, 'ID')
    db.exec('BEGIN IMMEDIATE')
    try {
      const committed = db.prepare('SELECT * FROM operations WHERE id = ?').get(operationId)
      if (committed) {
        if (committed.digest !== hash) throw new Error('Memory operation ID reused with different arguments')
        db.exec('COMMIT')
        return { ...JSON.parse(committed.result), reused: true }
      }
      const previous = db.prepare('SELECT r.* FROM revisions r JOIN heads h ON h.id = r.id AND h.revision = r.revision WHERE r.id = ?').get(record.id)
      if (args.id) {
        if (!previous || args.expectedRevision !== previous.revision) throw new Error('Memory revision conflict; read the current record before changing it')
      } else if (args.expectedRevision !== undefined) throw new Error('New memory cannot specify an expected revision')
      if (!previous && db.prepare('SELECT count(*) AS count FROM heads').get().count >= 10000) throw new Error('Project memory limit reached')
      if (action === 'invalidate') record = { ...this.row(previous), ...record, expires: previous.expires }
      record.revision = (previous?.revision || 0) + 1
      record.updated = Date.now()
      db.prepare('INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(record.id, record.revision, record.scope, record.path, record.kind, record.text, record.status, record.reason, JSON.stringify(record.sources), record.updated, record.expires)
      db.prepare('INSERT OR REPLACE INTO heads VALUES (?, ?)').run(record.id, record.revision)
      const result = this.row(db.prepare('SELECT * FROM revisions WHERE id = ? AND revision = ?').get(record.id, record.revision))
      db.prepare('INSERT INTO operations VALUES (?, ?, ?)').run(operationId, hash, JSON.stringify(result))
      db.exec('COMMIT')
      return result
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
}

// memory lazily owns the authoritative database without affecting normal agent startup.
const memory = new MemoryDatabase()

// tail serializes reads and mutations while source validation performs asynchronous file IO.
let tail = Promise.resolve()

// The memory worker exposes fixed operations with paired responses and no arbitrary SQL interface.
parentPort.on('message', ({ id, action, args }) => {
  tail = tail.then(async () => {
    try {
      if (!['list', 'get', 'save', 'invalidate'].includes(action)) throw new Error('Unknown memory operation')
      const result = ['save', 'invalidate'].includes(action) ? await memory.mutate(action, args) : await memory[action](args)
      parentPort.postMessage({ id, result })
    } catch (error) { parentPort.postMessage({ id, error: error.message }) }
  })
})
