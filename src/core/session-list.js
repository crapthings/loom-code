import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { readText } from '../io.js'
import { unfinishedRun } from './session.js'

// sessionStatus reports unresolved effects first and distinguishes completed tasks from unfinished runs.
function sessionStatus (events, calls) {
  const recovery = events.findLast(event => event.type === 'recovery.required' || event.type === 'recovery.acknowledged')
  if (calls.size || recovery?.type === 'recovery.required') return 'recovery required'
  const run = events.findLast(event => event.type === 'run.started' || event.type === 'run.finished')
  if (!run || (run.type === 'run.finished' && !['completed', 'interrupted', 'failed'].includes(run.status))) return 'empty'
  if (!unfinishedRun(events)) return 'completed'
  return run.type === 'run.started' ? 'interrupted' : run.status
}

// lockedSession checks whether a lock owner is alive and treats unverifiable locks as busy.
async function lockedSession (directory) {
  try {
    const { pid } = JSON.parse(await readText(path.join(directory, 'lock'), 4096))
    if (!Number.isInteger(pid) || pid <= 0) return true
    try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
  } catch (error) { return error.code !== 'ENOENT' }
}

// listSessions summarizes this workspace's root sessions without opening writers or repairing logs.
export async function listSessions (cwd) {
  cwd = await realpath(cwd)
  const root = path.join(cwd, '.loom', 'sessions')
  for (const directory of [path.join(cwd, '.loom'), root]) {
    try {
      if (!(await lstat(directory)).isDirectory()) throw new Error('Session metadata must use real directories, not symlinks')
    } catch (error) { if (error.code === 'ENOENT') return { sessions: [], skipped: 0 }; throw error }
  }
  const sessions = []
  const children = new Set()
  let skipped = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9-]{1,80}$/.test(entry.name)) continue
    try {
      const directory = path.join(root, entry.name)
      const raw = await readText(path.join(directory, 'events.jsonl'), 16 * 1024 * 1024)
      const events = raw.slice(0, raw.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse)
      const meta = events.find(event => event.type === 'session.created')
      if (!meta || meta.cwd !== cwd) { skipped++; continue }
      for (const event of events) {
        if (event.type === 'agent.spawned') children.add(event.childId)
        if (event.type === 'session.parent') children.add(entry.name)
      }
      const pending = new Set()
      const calls = new Set()
      for (const event of events) {
        if (event.type === 'inbox.enqueued') pending.add(event.inputId)
        if (event.type === 'inbox.delivered' || event.type === 'inbox.cancelled') pending.delete(event.inputId)
        if (event.type === 'tool.started') calls.add(event.call?.id)
        if (event.type === 'tool.finished') calls.delete(event.callId)
      }
      const status = sessionStatus(events, calls)
      const updated = events.at(-1)?.at || meta.at
      if (!Number.isFinite(updated)) throw new Error('Invalid session timestamp')
      const first = events.find(event => event.type === 'inbox.enqueued')
      sessions.push({ id: entry.name, title: String(first?.text || 'Untitled session').replace(/[\r\n\t]/g, ' ').slice(0, 160), updated, status, pending: pending.size, busy: await lockedSession(directory) })
    } catch { skipped++ }
  }
  return { sessions: sessions.filter(session => !children.has(session.id)).sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id)), skipped }
}
