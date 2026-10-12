import { EventEmitter } from 'node:events'
import { lstat, mkdir, open, readFile, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

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
  }

  static async open (cwd, id = randomUUID()) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid session ID')
    cwd = await realpath(cwd)
    const directory = path.join(cwd, '.loom', 'sessions', id)
    for (const folder of [path.join(cwd, '.loom'), path.join(cwd, '.loom', 'sessions'), directory]) {
      try { await mkdir(folder, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
      if (!(await lstat(folder)).isDirectory()) throw new Error('Session metadata must use real directories, not symlinks')
    }
    const lock = path.join(directory, 'lock')
    await acquireLock(lock)
    let handle
    try {
      try {
        if (!(await lstat(path.join(directory, 'events.jsonl'))).isFile()) throw new Error('Session log must be a regular metadata file')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      handle = await open(path.join(directory, 'events.jsonl'), 'a+', 0o600)
      const session = new Session(directory, id, handle, lock)
      const raw = await readFile(path.join(directory, 'events.jsonl'), 'utf8')
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
      await this.handle.write(`${JSON.stringify(event)}\n`)
      await this.handle.sync()
      this.events.push(event)
      this.emit('event', event)
      return event
    })
    this.tail = operation.catch(error => { this.failure = error })
    return operation
  }

  get pending () {
    const inbox = new Map()
    for (const event of this.events) {
      if (event.type === 'inbox.enqueued') inbox.set(event.inputId, event)
      if (event.type === 'inbox.delivered' || event.type === 'inbox.cancelled') inbox.delete(event.inputId)
    }
    return [...inbox.values()]
  }

  get messages () {
    return this.events.flatMap(event => event.message ? [event.message] : [])
  }

  async recover () {
    const started = new Map()
    const runs = new Map()
    const steps = new Map()
    for (const event of this.events) {
      if (event.type === 'tool.started') started.set(event.call.id, event)
      if (event.type === 'tool.finished') started.delete(event.callId)
      if (event.type === 'run.started') runs.set(event.runId, event)
      if (event.type === 'run.finished') runs.delete(event.runId)
      if (event.type === 'step.started') steps.set(event.stepId, event)
      if (event.type === 'step.finished') steps.delete(event.stepId)
    }
    for (const stepId of steps.keys()) await this.append('step.finished', { stepId, stopReason: 'aborted', recovery: true })
    for (const runId of runs.keys()) await this.append('run.finished', { runId, status: 'interrupted', recovery: true })
    for (const { call, source } of started.values()) {
      const text = 'Execution outcome unknown after restart; inspect the workspace before retrying.'
      const message = source === 'control' ? { role: 'user', content: `User-initiated ${call.name}: ${text}`, timestamp: Date.now() } : toolResult(call, text, true)
      await this.append('tool.finished', { callId: call.id, status: 'unknown', source, message })
    }
    const messages = this.messages
    const settled = new Set(messages.filter(message => message.role === 'toolResult').map(message => message.toolCallId))
    for (const message of messages.filter(message => message.role === 'assistant')) {
      for (const call of message.content.filter(part => part.type === 'toolCall' && !settled.has(part.id))) {
        await this.append('message', { message: toolResult(call, 'Not executed before restart.', true) })
      }
    }
    if (started.size) await this.append('recovery.required', { count: started.size })
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

// acquireLock excludes other writers and reclaims only locks whose owning process has exited.
async function acquireLock (file) {
  try {
    const lock = await open(file, 'wx', 0o600)
    await lock.writeFile(JSON.stringify({ pid: process.pid }))
    await lock.close()
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const { pid } = JSON.parse(await readFile(file, 'utf8'))
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
export function toolResult (call, text, isError = false) {
  return { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text }], isError, timestamp: Date.now() }
}
