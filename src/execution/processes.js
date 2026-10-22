import { EventEmitter } from 'node:events'
import { fork } from 'node:child_process'
import { open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import { ShellExecutor } from './executor.js'
import { processNotice } from '../core/process-events.js'

// signalProcess stops the owned process group without accepting arbitrary operating-system process IDs.
function signalProcess (child, signal) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}

// waitForExit drains trailing output but releases quiet pipes inherited by descendants after their parent exits.
function waitForExit (child) {
  return new Promise((resolve, reject) => {
    let timer
    let exited = false
    let code
    const finish = error => {
      clearTimeout(timer)
      child.removeListener('error', finish)
      child.removeListener('exit', exit)
      child.removeListener('close', close)
      child.stdout.removeListener('data', data)
      child.stderr.removeListener('data', data)
      child.stdout.destroy()
      child.stderr.destroy()
      if (error) reject(error)
      else resolve(code)
    }
    const data = () => {
      if (!exited) return
      clearTimeout(timer)
      timer = setTimeout(finish, 100)
    }
    const exit = value => { exited = true; code = value; data() }
    const close = value => { code = value; finish() }
    child.once('error', finish)
    child.once('exit', exit)
    child.once('close', close)
    child.stdout.on('data', data)
    child.stderr.on('data', data)
  })
}

// ProcessManager owns bounded shell sessions, durable completion, output and cancellation independently of model turns.
export class ProcessManager extends EventEmitter {
  constructor ({ cwd, session, executor = new ShellExecutor({ cwd }) }) {
    super()
    this.cwd = cwd
    this.session = session
    this.executor = executor
    this.jobs = new Map()
    this.closed = false
  }

  get active () { return [...this.jobs.values()].filter(job => !job.result) }
  get pending () { return [...this.jobs.values()].filter(job => job.background && job.result && !job.reported) }

  snapshot (job, terminal = false) {
    const status = !terminal && !job.result && job.status !== 'starting' ? 'running' : job.status
    return { id: job.id, callId: job.callId, command: job.command, status, started: job.started, finished: job.finished, lastOutput: job.lastOutput, pid: job.child?.pid, artifact: job.artifact, exitCode: job.code, boundary: this.executor.label }
  }

  get (id) {
    const job = this.jobs.get(id)
    if (!job) throw new Error('Unknown process ID in this session; inspect recorded history rather than replaying the command')
    return job
  }

  async start ({ command, timeout = 0, yield_time_ms: yieldTime = 1000 }, { signal, emit, call, observer }) {
    signal.throwIfAborted()
    if (this.closed) throw new Error('Process manager has closed')
    if (this.active.length >= 4) throw new Error('Four shell processes are already running; wait for or stop an existing process before starting another')
    for (const [id, job] of this.jobs) {
      if (this.jobs.size < 32) break
      if (job.result && job.reported) this.jobs.delete(id)
    }
    if (this.jobs.size >= 32) throw new Error('Process results are awaiting delivery; inspect existing results before starting another command')
    const job = { id: `p-${randomUUID().replaceAll('-', '').slice(0, 12)}`, callId: call.id, command, timeout, started: Date.now(), status: 'starting', artifact: `${randomUUID()}.txt`, head: '', tail: '', characters: 0, reported: false, emit }
    await this.session.append('process.started', { process: this.snapshot(job), callId: call.id })
    this.jobs.set(job.id, job)
    this.publish(job)
    job.done = this.execute(job, signal, observer)
    job.done.catch(error => { this.failure = error; this.emit('settled') })
    let result
    try { result = await this.wait(job.id, yieldTime, signal) } catch (error) {
      if (!signal.aborted) throw error
      this.stop(job.id)
      await job.done
      return this.status(job.id)
    }
    if (result.process.status === 'running' || result.process.status === 'starting') job.background = true
    return result
  }

  publish (job) {
    job.emit({ type: 'process.state', process: this.snapshot(job), text: job.tail.slice(-2000) })
  }

  stop (id, reason = 'cancelled') {
    const job = this.get(id)
    if (job.result || job.stopped) return
    job.stopped = reason
    job.controller?.abort(new Error(reason))
    signalProcess(job.child, 'SIGTERM')
    job.killTimer = setTimeout(() => signalProcess(job.child, 'SIGKILL'), 500)
  }

  async execute (job, signal, observer) {
    let output
    let launch
    let unwatch
    let before
    let changes
    let writing = Promise.resolve()
    let writeError
    let bytes = 0
    let previewAt = 0
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const abort = () => this.stop(job.id)
    job.controller = new AbortController()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const capture = text => {
      job.characters += text.length
      job.head = (job.head + text).slice(0, 6000)
      job.tail = (job.tail + text).slice(-6000)
      job.lastOutput = Date.now()
      if (job.lastOutput - previewAt >= 150) {
        this.publish(job)
        job.emit({ type: 'tool.progress', kind: 'process.output', text: job.tail.slice(-2000) })
        previewAt = job.lastOutput
      }
    }
    try {
      if (observer) { try { before = await observer.capture() } catch { before = null } }
      output = await open(path.join(this.session.directory, job.artifact), 'wx', 0o600)
      launch = await this.executor.prepare(job.command, job.controller.signal)
      unwatch = launch.onFailure?.(error => { job.launchError = error; this.stop(job.id, 'sandbox lost') })
      job.controller.signal.throwIfAborted()
      job.child = fork(new URL('./process-runner.js', import.meta.url), [], { cwd: this.cwd, env: launch.env, execArgv: [], detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      const exited = waitForExit(job.child)
      job.child.send({ command: launch.command, args: launch.args, env: launch.env })
      job.status = 'running'
      if (job.timeout) job.timer = setTimeout(() => this.stop(job.id, 'timeout'), job.timeout * 1000)
      for (const stream of ['stdout', 'stderr']) {
        job.child[stream].on('data', chunk => {
          bytes += chunk.length
          if (bytes > 10 * 1024 * 1024) { this.stop(job.id, 'output limit'); return }
          capture(decoders[stream].write(chunk))
          writing = writing.then(() => output.writeFile(chunk)).catch(error => { writeError = error; this.stop(job.id, 'output write failed') })
        })
      }
      this.publish(job)
      job.emit({ type: 'tool.progress', kind: 'process.started', boundary: launch.label, pid: job.child.pid, text: `${launch.label} process ${job.child.pid} started` })
      job.code = await exited
      for (const decoder of Object.values(decoders)) { const text = decoder.end(); if (text) capture(text) }
      await writing
      if (job.launchError) throw job.launchError
      if (writeError) throw writeError
      await output.sync()
      job.status = job.stopped || (job.code === 0 ? 'completed' : 'failed')
    } catch (error) {
      job.status = job.stopped || 'failed'
      capture(`\n${error.message}`)
    } finally {
      signalProcess(job.child, 'SIGKILL')
      clearTimeout(job.timer)
      clearTimeout(job.killTimer)
      signal.removeEventListener('abort', abort)
      unwatch?.()
      try { await output?.close() } catch (error) { job.status = 'failed'; capture(`\nOutput close failed: ${error.message}`) }
      try { await launch?.cleanup() } catch (error) { job.status = 'failed'; capture(`\nCleanup failed: ${error.message}`) }
    }
    if (before) {
      try { changes = observer.compare(before, await observer.capture()) } catch { changes = { files: [], count: 0, unavailable: true } }
    } else if (before === null) changes = { files: [], count: 0, unavailable: true }
    job.finished = Date.now()
    const state = this.snapshot(job, true)
    const preview = job.characters <= 6000 ? job.head : job.characters <= 12000 ? job.head + job.tail.slice(-(job.characters - 6000)) : `${job.head}\n[... truncated; read the output artifact ...]\n${job.tail}`
    let text = `process: ${job.id}; exit: ${job.code ?? null}; status: ${job.status}; artifact: ${job.artifact}\n${preview}`
    if (/ERR_PNPM_BAD_PM_VERSION/.test(preview)) text += '\nThe available pnpm does not match packageManager. Use an already installed matching toolchain or report this environment blocker; increasing timeouts cannot fix it. Do not silently bypass the version requirement.'
    if (changes?.count) text += `\nObserved workspace changes (not verification): ${changes.files.slice(0, 12).map(file => file.path).join(', ')}`
    const result = { text, isError: job.status !== 'completed', process: state, changes }
    await this.session.append('process.finished', { process: state, callId: job.callId, status: job.status, executed: Boolean(job.child?.pid), changes, text })
    job.result = result
    this.publish(job)
    this.emit('settled')
    return result
  }

  status (id, report = true) {
    if (!id) return { text: JSON.stringify([...this.jobs.values()].map(job => this.snapshot(job))), isError: false }
    const job = this.get(id)
    if (job.result) { if (report) job.reported = true; return job.result }
    const state = this.snapshot(job)
    return { text: `process: ${job.id}; status: ${state.status}; elapsed: ${Math.floor((Date.now() - job.started) / 1000)}s; artifact: ${job.artifact}\n${job.tail.slice(-2000)}\nThis command is still running. Its completion will be delivered automatically. Continue independent work, or end your response to wait without polling; do not use sleep loops or rerun the command.`, isError: false, process: state }
  }

  async wait (id, milliseconds, signal) {
    signal.throwIfAborted()
    const job = this.get(id)
    if (milliseconds && !job.result) {
      let timer
      let abort
      try {
        await Promise.race([job.done, new Promise((resolve, reject) => {
          timer = setTimeout(resolve, milliseconds)
          abort = () => reject(signal.reason || new Error('Cancelled'))
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })])
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
    }
    if (this.failure) throw this.failure
    signal.throwIfAborted()
    return this.status(id)
  }

  async deliver () {
    if (this.failure) throw this.failure
    const jobs = this.pending
    for (const job of jobs) {
      const message = { role: 'user', content: processNotice(job.result), timestamp: Date.now() }
      await this.session.append('process.delivered', { processId: job.id, message })
      job.reported = true
    }
    return jobs.length
  }

  async stopAll () {
    const jobs = this.active
    for (const job of jobs) this.stop(job.id)
    await Promise.all(jobs.map(job => job.done))
  }

  async close () {
    this.closed = true
    await this.stopAll()
  }
}
