import { randomUUID } from 'node:crypto'
import { Session } from './session.js'
import { Budget } from './budget.js'
import { buildInstructions, compactContext, contextMessages, estimateTokens } from './context.js'
import { createTools, Dispatcher } from '../tools/dispatcher.js'
import { discoverSkills, skillTool } from './skills.js'
import { latestCheckpoint } from '../tools/checkpoints.js'
import { validateMode } from './modes.js'

// Agent coordinates durable input, model steps, tools, and read-only child sessions.
export class Agent {
  constructor ({ cwd, session, model, mode = 'ask', approve, emit = () => {}, steps = 30, depth = 0, budget }) {
    this.cwd = cwd
    this.session = session
    this.model = model
    this.mode = validateMode(mode)
    this.emit = emit
    this.steps = steps
    this.depth = depth
    this.sharedBudget = budget
    this.running = null
    this.controller = null
    this.blocked = false
    this.closed = false
    this.status = 'idle'
    const delegate = depth === 0 ? (args, context) => this.delegate(args, context) : undefined
    this.dispatcher = new Dispatcher({ session, mode, approve, emit, tools: createTools({ cwd, session, delegate }) })
  }

  async initialize () {
    this.blocked = await this.session.recover()
    this.status = this.blocked ? 'recovery required' : 'idle'
    this.system = await buildInstructions(this.cwd, this.mode)
    const skills = await discoverSkills(this.cwd)
    this.dispatcher.tools.push(skillTool(skills))
    this.skillInstructions = skills.length ? `\nAvailable project skills (use load_skill to read instructions):\n${skills.map(skill => `${skill.name}: ${skill.description}`).join('\n')}` : ''
    this.system += this.skillInstructions
    this.emit({ type: 'status', text: this.status })
  }

  async enqueue (text, delivery = 'steer') {
    if (this.closed) throw new Error('Agent has closed')
    if (!text.trim()) return
    const inputId = randomUUID()
    await this.session.append('inbox.enqueued', { inputId, text, delivery })
    this.emit({ type: 'queued', text, delivery, inputId })
    if (!this.blocked) this.wake()
    return inputId
  }

  wake () {
    if (this.running || this.blocked || this.closed) return
    this.controller = new AbortController()
    this.budget = this.sharedBudget || new Budget({ steps: this.steps })
    const controller = this.controller
    const timer = setTimeout(() => controller.abort(new Error('Run time budget exhausted')), Math.max(1, this.budget.deadline - Date.now()))
    this.running = this.drain(controller.signal).catch(error => {
      this.status = controller.signal.aborted ? 'interrupted' : 'failed'
      this.emit({ type: 'error', text: error.message })
    }).finally(() => {
      clearTimeout(timer)
      this.running = null
      this.controller = null
      this.emit({ type: 'status', text: this.status, budget: this.budget })
      if (this.status === 'idle' && this.session.pending.length) this.wake()
    })
  }

  async drain (signal) {
    this.status = 'running'
    const runId = randomUUID()
    await this.session.append('run.started', { runId, model: this.model.label, mode: this.mode })
    this.emit({ type: 'status', text: this.status })
    try {
      let continuing = false
      while (true) {
        signal.throwIfAborted()
        const pending = this.session.pending
        const steers = pending.filter(input => input.delivery === 'steer')
        const selected = steers.length ? steers : continuing ? [] : pending.slice(0, 1)
        for (const input of selected) {
          await this.session.append('inbox.delivered', { message: { role: 'user', content: input.text, timestamp: Date.now() }, inputId: input.inputId })
          this.emit({ type: 'user', text: input.text, inputId: input.inputId })
        }
        if (!continuing && !selected.length) break
        await compactContext({ session: this.session, model: this.model, system: this.system, tools: this.dispatcher.declarations, budget: this.budget, signal, emit: this.emit })
        const response = await this.step(signal)
        const calls = response.content.filter(part => part.type === 'toolCall')
        await this.dispatcher.batch(calls, signal, ['length', 'error', 'aborted'].includes(response.stopReason))
        signal.throwIfAborted()
        if (['error', 'aborted'].includes(response.stopReason)) throw new Error(response.errorMessage || 'Model response failed')
        if (response.stopReason === 'length') throw new Error('Model response exceeded output limit; incomplete tools were not executed')
        continuing = calls.length > 0
      }
      this.status = 'idle'
      await this.session.append('run.finished', { runId, status: 'completed', calls: this.budget.calls, tokens: this.budget.tokens, cost: this.budget.cost })
    } catch (error) {
      this.status = signal.aborted ? 'interrupted' : 'failed'
      await this.session.append('run.finished', { runId, status: this.status, error: error.message, calls: this.budget.calls, tokens: this.budget.tokens, cost: this.budget.cost })
      throw error
    }
  }

  async step (signal) {
    this.budget.take()
    const stepId = randomUUID()
    const messages = contextMessages(this.session)
    if (estimateTokens({ system: this.system, messages, tools: this.dispatcher.declarations }) > this.model.contextWindow * 0.9) throw new Error('Context too large after compaction; shorten the current input')
    await this.session.append('step.started', { stepId })
    this.emit({ type: 'assistant.start', stepId })
    const response = await this.model.complete({ system: this.system, messages, tools: this.dispatcher.declarations }, { signal, onDelta: text => this.emit({ type: 'assistant.delta', text, stepId }), onRetry: () => this.budget.take() })
    this.budget.account(response.usage)
    await this.session.append('message', { message: response, stepId })
    await this.session.append('step.finished', { stepId, stopReason: response.stopReason, usage: response.usage })
    this.emit({ type: 'assistant.end', response, stepId, budget: this.budget })
    return response
  }

  async delegate ({ role, task }, { signal }) {
    const session = await Session.open(this.cwd)
    const emit = event => this.emit({ ...event, child: session.id, role })
    const child = new Agent({ cwd: this.cwd, session, model: this.model, mode: 'plan', emit, depth: this.depth + 1, budget: this.budget })
    const abort = () => child.interrupt()
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      await this.session.append('agent.spawned', { childId: session.id, role, task })
      await child.initialize()
      child.system += `\nYour role is ${role}; return concise findings with file references and evidence. Do not modify files.`
      await child.enqueue(task)
      if (signal.aborted) child.interrupt()
      await child.wait()
      const response = session.messages.findLast(message => message.role === 'assistant')
      const text = response?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') || 'No findings'
      await this.session.append('agent.finished', { childId: session.id, status: child.status })
      return { text: `Child session: ${session.id}\nStatus: ${child.status}\n${text}`, isError: child.status !== 'idle' }
    } finally {
      signal.removeEventListener('abort', abort)
      await child.close()
    }
  }

  interrupt () {
    this.controller?.abort(new Error('Interrupted by user'))
  }

  async setMode (mode) {
    validateMode(mode)
    if (this.depth) throw new Error('Delegated agents cannot change permissions')
    return this.manual('changing permissions', async signal => {
      const system = await buildInstructions(this.cwd, mode)
      signal.throwIfAborted()
      await this.session.append('permission.mode', { previous: this.mode, mode })
      this.mode = mode
      this.dispatcher.mode = mode
      this.system = system + this.skillInstructions
      this.emit({ type: 'mode.changed', mode })
    })
  }

  async resume () {
    if (this.running) return
    if (this.blocked) await this.session.append('recovery.acknowledged')
    this.blocked = false
    if (!this.session.pending.length) await this.session.append('inbox.enqueued', { inputId: randomUUID(), delivery: 'steer', text: 'Continue the original task from recorded evidence; inspect unknown or partial outcomes before retrying.' })
    this.wake()
  }

  async compact () {
    return this.manual('compacting', signal => compactContext({ session: this.session, model: this.model, system: this.system, tools: this.dispatcher.declarations, budget: this.budget, signal, emit: this.emit, force: true }))
  }

  async undo () {
    const checkpoint = latestCheckpoint(this.session)
    if (!checkpoint) throw new Error('No file checkpoint to restore')
    return this.manual('restoring', async signal => {
      const result = await this.dispatcher.run({ type: 'toolCall', id: randomUUID(), name: 'restore_checkpoint', arguments: { id: checkpoint.checkpoint } }, signal, false, 'control')
      if (result.isError) throw new Error(result.content[0].text)
      return result
    })
  }

  manual (status, action) {
    if (this.running) throw new Error('Interrupt or wait for the agent before this operation')
    if (this.closed) throw new Error('Agent has closed')
    this.status = status
    this.controller = new AbortController()
    this.budget = new Budget({ steps: 3 })
    const controller = this.controller
    const timer = setTimeout(() => controller.abort(), this.budget.deadline - Date.now())
    const task = action(controller.signal)
    this.running = task.then(() => { this.status = 'idle' }).catch(error => {
      this.status = controller.signal.aborted ? 'interrupted' : 'failed'
      this.emit({ type: 'error', text: error.message })
    }).finally(() => {
      clearTimeout(timer)
      this.controller = null
      this.running = null
      this.emit({ type: 'status', text: this.status, budget: this.budget })
      if (this.status === 'idle' && this.session.pending.length) this.wake()
    })
    this.emit({ type: 'status', text: status })
    return task
  }

  async wait () {
    while (this.running) await this.running
  }

  async close () {
    this.closed = true
    this.interrupt()
    await this.wait()
    await this.session.close()
  }
}
