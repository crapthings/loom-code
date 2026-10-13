import { DatabaseSync } from 'node:sqlite'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import { historyRoot, historyFile, historySessions, readHistorySource, sessionId } from './history-source.js'

// eventText indexes model-visible evidence while excluding nested history responses and evaluation payloads.
function eventText (event) {
  if (event.type === 'context.compacted') return event.summary
  if (['search_history', 'read_history', 'list_memories', 'get_memory', 'remember', 'forget_memory'].includes(event.message?.toolName)) return ''
  const content = event.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => part.type === 'text' ? part.text : part.type === 'toolCall' ? `${part.name} ${JSON.stringify(part.arguments)}` : '').join('\n')
}

// eventDigest detects edits to any previously indexed event before accepting an append-only update.
function eventDigest (events) {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex')
}

// HistoryIndex owns a rebuildable workspace cache and keeps every SQLite operation off the terminal thread.
class HistoryIndex {
  async open () {
    if (this.db) return this.db
    await historyRoot(workerData.cwd)
    const file = path.join(workerData.cwd, '.loom', 'history.sqlite')
    for (const candidate of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
      try {
        const info = await lstat(candidate)
        if (!info.isFile() || info.nlink !== 1) throw new Error('History database paths must be regular, unlinked files')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try {
      const handle = await open(file, 'wx', 0o600)
      await handle.close()
    } catch (error) { if (error.code !== 'EEXIST') throw error }
    const db = new DatabaseSync(file, { timeout: 250, allowExtension: false })
    try {
      db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA max_page_count = 65536;')
      const version = db.prepare('PRAGMA user_version').get().user_version
      if (version !== 0 && version !== 1) throw new Error('Unsupported history index version; preserve it before rebuilding')
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, signature TEXT NOT NULL, watermark INTEGER NOT NULL, digest TEXT NOT NULL, title TEXT NOT NULL, parent TEXT, updated INTEGER NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(session UNINDEXED, seq UNINDEXED, event_id UNINDEXED, kind UNINDEXED, role UNINDEXED, body, tokenize = 'trigram');
        PRAGMA user_version = 1;`)
      this.db = db
      return db
    } catch (error) { db.close(); throw error }
  }

  async refresh ({ session } = {}) {
    const db = await this.open()
    const { ids, omitted } = session ? { ids: [sessionId(session)], omitted: 0 } : await historySessions(workerData.cwd)
    const visible = new Set()
    let skipped = omitted
    let bytes = 0
    for (const id of ids) {
      try {
        const source = await historyFile(workerData.cwd, id)
        const cached = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)
        if (cached?.signature === source.signature) { visible.add(id); continue }
        bytes += source.size
        if (bytes > 64 * 1024 * 1024) { skipped++; continue }
        const { events } = await readHistorySource(workerData.cwd, id)
        const parent = events.find(event => event.type === 'session.parent')?.parentId || null
        const title = String(events.find(event => event.type === 'inbox.enqueued')?.text || 'Untitled session').slice(0, 160)
        const watermark = events.at(-1)?.seq ?? -1
        const appendOnly = cached && watermark >= cached.watermark && eventDigest(events.slice(0, cached.watermark + 1)) === cached.digest
        db.exec('BEGIN IMMEDIATE')
        try {
          if (!appendOnly) db.prepare('DELETE FROM history WHERE session = ?').run(id)
          const insert = db.prepare('INSERT INTO history(session, seq, event_id, kind, role, body) VALUES (?, ?, ?, ?, ?, ?)')
          for (const event of events) {
            if (appendOnly && event.seq <= cached.watermark) continue
            const body = eventText(event)
            if (body) insert.run(id, event.seq, event.id, event.type, event.message?.role || 'summary', body)
          }
          db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, source.signature, watermark, eventDigest(events), title, parent, events.at(-1)?.at || 0)
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
        visible.add(id)
      } catch { skipped++ }
    }
    const cachedSessions = session ? db.prepare('SELECT id FROM sessions WHERE id = ?').all(session) : db.prepare('SELECT id FROM sessions').all()
    for (const { id } of cachedSessions) {
      if (visible.has(id)) continue
      db.exec('BEGIN IMMEDIATE')
      try { db.prepare('DELETE FROM history WHERE session = ?').run(id); db.prepare('DELETE FROM sessions WHERE id = ?').run(id); db.exec('COMMIT') } catch (error) { db.exec('ROLLBACK'); throw error }
    }
    return { skipped, scannedBytes: bytes }
  }

  async search ({ query, session, limit = 8 }) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('History query must contain 1–200 characters')
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('History limit must be from 1 to 20')
    if (session) sessionId(session)
    const refresh = await this.refresh({ session })
    const db = this.db
    const scope = session ? 'AND h.session = ?' : 'AND s.parent IS NULL'
    const args = session ? [query, session, limit] : [query, limit]
    const long = [...query].length >= 3
    const matching = long ? 'history MATCH ?' : 'instr(lower(h.body), lower(?)) > 0'
    args[0] = long ? `"${query.replaceAll('"', '""')}"` : query
    const rows = db.prepare(`SELECT h.session AS sessionId, CAST(h.seq AS INTEGER) AS seq, h.event_id AS eventId, h.kind, h.role, h.body, s.title FROM history h JOIN sessions s ON s.id = h.session WHERE ${matching} ${scope} ORDER BY ${long ? 'rank,' : ''} s.updated DESC, CAST(h.seq AS INTEGER) DESC LIMIT ?`).all(...args)
    const needle = query.toLowerCase()
    return { ...refresh, results: rows.map(({ body, ...row }) => { const offset = Math.max(0, body.toLowerCase().indexOf(needle) - 160); return { ...row, excerptOffset: offset, excerpt: body.slice(offset, offset + 700), truncated: offset > 0 || body.length > offset + 700 } }) }
  }

  async read ({ session, seq, offset = 0 }) {
    sessionId(session)
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(offset) || offset < 0) throw new Error('History sequence and offset must be nonnegative integers')
    const { events } = await readHistorySource(workerData.cwd, session)
    const event = events[seq]
    if (!event) throw new Error('History event not found')
    const text = JSON.stringify(event)
    const truncated = text.length > offset + 12000
    return { sessionId: session, seq, eventId: event.id, offset, nextOffset: truncated ? offset + 12000 : null, text: text.slice(offset, offset + 12000), truncated }
  }
}

// index lazily opens the optional SQLite cache only when search needs it.
const index = new HistoryIndex()

// tail serializes worker requests so asynchronous source reads cannot interleave database transactions.
let tail = Promise.resolve()

// The worker accepts fixed operations and returns paired replies without exposing arbitrary SQL.
parentPort.on('message', ({ id, action, args }) => {
  tail = tail.then(async () => {
    try {
      if (!['search', 'read', 'refresh'].includes(action)) throw new Error('Unknown history operation')
      const result = await index[action](args)
      parentPort.postMessage({ id, result })
    } catch (error) { parentPort.postMessage({ id, error: error.message }) }
  })
})
