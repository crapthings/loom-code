import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { readHandleText, readText } from '../io.js'
import { processNotice } from './process-events.js'

// Session stores ordered facts durably before publishing them to observers.
export class Session extends EventEmitter {
  constructor (directory, id, handle, lock) {
    super()
    this.directory = directory
    this.id = id
    this.handle = handle
    this.lock = lock
    this.events = []
    this.tail = Promise.resolve()
    this.projection = { events: this.events, cursor: 0, inbox: new Map(), messages: [], latest: new Map() }
  }

  static async open (cwd, id = randomUUID(), { existing = false } = {}) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid session ID')
    cwd = await realpath(cwd)
    const directory = path.join(cwd, '.loom', 'sessions', id)
    for (const folder of [path.join(cwd, '.loom'), path.join(cwd, '.loom', 'sessions'), directory]) {
      if (!existing) {
        try { await mkdir(folder, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      }
      if (!(await lstat(folder)).isDirectory()) throw new Error('Session metadata must use real directories, not symlinks')
    }
    const lock = path.join(directory, 'lock')
    await acquireLock(lock)
    let handle
    try {
      try {
        if (!(await lstat(path.join(directory, 'events.jsonl'))).isFile()) throw new Error('Session log must be a regular metadata file')
      } catch (error) { if (existing || error.code !== 'ENOENT') throw error }
      handle = await open(path.join(directory, 'events.jsonl'), constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK | (existing ? 0 : constants.O_CREAT), 0o600)
      const session = new Session(directory, id, handle, lock)
      const raw = await readHandleText(handle, 16 * 1024 * 1024)
      const end = raw.lastIndexOf('\n') + 1
      if (end < raw.length) await handle.truncate(Buffer.byteLength(raw.slice(0, end)))
      session.events = raw.slice(0, end).split('\n').filter(Boolean).map(JSON.parse)
      const meta = session.events.find(event => event.type === 'session.created')
      if (meta && meta.cwd !== cwd) throw new Error('Session belongs to a different workspace')
      if (!meta) await session.append('session.created', { cwd })
      return session
    } catch (error) {
      await handle?.close()
      await unlink(lock)
      throw error
    }
  }

  append (type, data = {}) {
    if (this.closed) return Promise.reject(new Error('Session has closed'))
    const operation = this.tail.then(async () => {
      if (this.failure) throw this.failure
      const event = { ...data, type, id: randomUUID(), seq: this.events.length, at: Date.now() }
      await this.handle.writeFile(`${JSON.stringify(event)}\n`)
      await this.handle.sync()
      this.events.push(event)
      this.emit('event', event)
      return event
    })
    this.tail = operation.catch(error => { this.failure = error })
    return operation
  }

  project () {
    if (this.projection.events !== this.events || this.projection.cursor > this.events.length) {
      this.projection = { events: this.events, cursor: 0, inbox: new Map(), messages: [], latest: new Map() }
    }
    const projection = this.projection
    while (projection.cursor < this.events.length) {
      const event = this.events[projection.cursor++]
      if (event.type === 'inbox.enqueued') projection.inbox.set(event.inputId, event)
      if (event.type === 'inbox.delivered' || event.type === 'inbox.cancelled') projection.inbox.delete(event.inputId)
      if (event.message) projection.messages.push(event.message)
      projection.latest.set(event.type, event)
    }
    return projection
  }

  latestEvent (type) {
    return this.project().latest.get(type)
  }

  get pending () {
    return [...this.project().inbox.values()]
  }

  get messages () {
    return this.project().messages.slice()
  }

  get unfinished () {
    return unfinishedRun(this.events)
  }

  async recover () {
    const started = new Map()
    const runs = new Map()
    const steps = new Map()
    const decisions = new Map()
    const processes = new Map()
    const finishedProcesses = new Map()
    const observedProcesses = new Set()
    for (const event of this.events) {
      if (event.type === 'tool.started') started.set(event.call.id, event)
      if (event.type === 'tool.finished') started.delete(event.callId)
      if (event.type === 'run.started') runs.set(event.runId, event)
      if (event.type === 'run.finished') runs.delete(event.runId)
      if (event.type === 'step.started') steps.set(event.stepId, event)
      if (event.type === 'step.finished') steps.delete(event.stepId)
      if (event.type === 'decision.started') decisions.set(event.decisionId, event)
      if (event.type === 'decision.finished') decisions.delete(event.decisionId)
      if (event.type === 'process.started') processes.set(event.process.id, event)
      if (event.type === 'process.finished') { processes.delete(event.process.id); finishedProcesses.set(event.process.id, event) }
      if (event.type === 'process.delivered') observedProcesses.add(event.processId)
      if (event.type === 'tool.finished' && event.process && !['running', 'starting'].includes(event.process.status) && event.source !== 'process-control') observedProcesses.add(event.process.id)
    }
    for (const [decisionId, decision] of decisions) await this.append('decision.finished', { decisionId, mode: decision.mode, status: 'unknown', recovery: true })
    for (const stepId of steps.keys()) await this.append('step.finished', { stepId, stopReason: 'aborted', recovery: true })
    for (const runId of runs.keys()) await this.append('run.finished', { runId, status: 'interrupted', recovery: true })
    for (const { call, source } of started.values()) {
      const text = 'Execution outcome unknown after restart; inspect the workspace before retrying.'
      const message = toolEventMessage(call, toolResult(call, text, true), source)
      await this.append('tool.finished', { callId: call.id, status: 'unknown', source, message })
    }
    const messages = this.messages
    const settled = new Set(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId))
    for (const message of messages.filter(message => message.role === 'assistant')) {
      for (const call of message.content.filter(part => part.type === 'toolCall' && !settled.has(part.id))) {
        await this.append('message', { message: toolResult(call, 'Not executed before restart.', true) })
      }
    }
    for (const [id, event] of processes) {
      const process = { ...event.process, status: 'unknown' }
      const finished = await this.append('process.finished', { process, callId: process.callId, status: 'unknown', recovery: true, text: 'Process outcome unknown after restart. Inspect output artifacts and partial effects before retrying; this command was not replayed.' })
      finishedProcesses.set(id, finished)
    }
    for (const [id, event] of finishedProcesses) {
      if (observedProcesses.has(id)) continue
      await this.append('process.delivered', { processId: id, message: { role: 'user', content: processNotice(event), timestamp: Date.now() }, recovery: true })
    }
    if (started.size || processes.size) await this.append('recovery.required', { count: started.size + processes.size })
    return this.events.findLast(event => event.type === 'recovery.required' || event.type === 'recovery.acknowledged')?.type === 'recovery.required'
  }

  async close () {
    if (this.closed) return
    this.closed = true
    await this.tail
    await this.handle.close()
    await unlink(this.lock)
  }
}

// unfinishedRun distinguishes unfinished execution from observation after a durably completed task.
export function unfinishedRun (events) {
  const run = events.findLast(event => event.type === 'run.started' || event.type === 'run.finished')
  const task = events.findLast(event => ['inbox.delivered', 'step.started', 'task.finished'].includes(event.type))
  if (task?.type === 'task.finished' && ['unverified', 'blocked'].includes(task.outcome)) return true
  if (!run || (run.type === 'run.finished' && !['interrupted', 'failed'].includes(run.status))) return false
  return !(task?.type === 'task.finished' && task.runId === run.runId)
}

// acquireLock excludes other writers and reclaims only locks whose owning process has exited.
async function acquireLock (file) {
  try {
    const lock = await open(file, 'wx', 0o600)
    try { await lock.writeFile(JSON.stringify({ pid: process.pid })) } finally { await lock.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const { pid } = JSON.parse(await readText(file, 4096))
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid session lock owner; refusing to reclaim it')
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      await unlink(file)
      return acquireLock(file)
    }
    throw new Error(`Session is already open by process ${pid}`)
  }
}

// toolResult creates a provider-neutral reply paired with its originating call.
export function toolResult (call, text, isError = false, images = []) {
  return { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }, ...images], isError, timestamp: Date.now() }
}

// toolEventMessage records harness checks and user controls without fabricating unpaired model tool responses.
export function toolEventMessage (call, message, source) {
  if (source === 'process-control') return undefined
  if (!['control', 'preflight'].includes(source)) return message
  const label = source === 'preflight' ? 'Harness readiness check' : 'User-initiated'
  return { role: 'user', content: `${label} ${call.name}: ${message.content[0].text}`, timestamp: message.timestamp }
}
