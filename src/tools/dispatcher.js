import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Type, validateToolArguments } from '@earendil-works/pi-ai'
import { toolResult, toolEventMessage } from '../core/session.js'
import { readText } from '../io.js'
import { fileTools } from './files.js'
import { shellTools } from './shell.js'
import { checkpointTool } from './checkpoints.js'
import { validateMode } from '../core/modes.js'
import { memoryTools } from './memory.js'
import { historyTools } from './history.js'
import { WorkspaceObserver } from './workspace.js'
import { storeImages, readImage } from '../core/images.js'

// createTools assembles built-ins and optional delegation behind one dispatcher-compatible registry.
export function createTools ({ cwd, session, delegate, executor, processes, history, memory, allowWorkspace = false }) {
  const tools = [...fileTools(cwd, session), ...shellTools(cwd, session, executor, processes), checkpointTool(cwd, session), {
    name: 'read_artifact',
    description: 'Read a stored tool-output artifact by ID with a character offset.',
    effect: 'read',
    parallel: true,
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]+\\.txt$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    execute: async ({ id, offset = 0 }) => (await readText(path.join(session.directory, id), 10 * 1024 * 1024)).slice(offset, offset + 12000)
  }, {
    name: 'read_image',
    description: 'Recall a saved screenshot by its image artifact ID; this is historical evidence, not a fresh observation.',
    effect: 'read',
    parallel: true,
    parameters: Type.Object({ artifact: Type.String({ pattern: '^image-[a-f0-9]{64}\\.(png|jpg|webp)$' }) }),
    execute: async ({ artifact }) => ({ text: `Historical screenshot: ${artifact}`, isError: false, images: [await readImage(session.directory, artifact)] })
  }]
  if (history) tools.push(...historyTools({ session, history, allowWorkspace }))
  if (memory && allowWorkspace) tools.push(...memoryTools({ session, memory }))
  if (delegate) {
    tools.push({
      name: 'delegate',
      description: 'Delegate independent research or review to an isolated read-only agent sharing the run budget.',
      effect: 'read',
      parallel: true,
      parameters: Type.Object({ role: Type.Union([Type.Literal('explore'), Type.Literal('review')]), task: Type.String({ minLength: 1 }) }),
      execute: delegate
    })
  }
  return tools
}

// normalizeResult accepts the supported tool output contract before persistence and model feedback.
function normalizeResult (output) {
  if (typeof output === 'string') return { text: output, isError: false }
  if (!output || typeof output.text !== 'string' || typeof output.isError !== 'boolean') throw new Error('Tool must return text or { text, isError }')
  return { ...output }
}

// Dispatcher validates and authorizes every call before durably recording and executing its intent.
export class Dispatcher {
  constructor ({ session, tools, mode = 'ask', approve = async () => false, emit = () => {}, observer }) {
    this.session = session
    this.tools = tools
    this.mode = validateMode(mode)
    this.approve = approve
    this.emit = emit
    this.sessionGrants = new Set()
    this.observer = observer
  }

  get declarations () {
    return this.tools.filter(tool => !tool.internal && (this.mode !== 'plan' || tool.effect === 'read')).map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  async batch (calls, signal, truncated = false, stopped = () => false) {
    const run = call => this.run(call, stopped() ? AbortSignal.abort() : signal, truncated)
    if (calls.every(call => this.tools.find(tool => tool.name === call.name)?.parallel)) return Promise.all(calls.map(run))
    const results = []
    for (const call of calls) results.push(await run(call))
    return results
  }

  async authorize (tool, call, args, signal) {
    if (!['read', 'write', 'shell', 'computer', 'cancel'].includes(tool.effect)) throw new Error('Unknown tool effect; execution denied')
    if (this.mode === 'plan' && tool.effect !== 'read') throw new Error('Plan mode denies side effects')
    const requiresApproval = (['shell', 'computer'].includes(tool.effect) && this.mode !== 'auto') || (tool.effect === 'write' && this.mode === 'ask')
    if (!requiresApproval) return
    const reused = this.sessionGrants.has(tool.name)
    const decision = reused ? 'session' : await this.approve({ call, effect: tool.effect, args, signal })
    const allowed = !signal.aborted && (decision === true || decision === 'session')
    const scope = decision === 'session' ? 'session' : 'once'
    await this.session.append('permission.decided', { callId: call.id, allowed, effect: tool.effect, tool: tool.name, scope, reused })
    if (!allowed) throw new Error('Permission denied; choose an allowed alternative')
    signal.throwIfAborted()
    if (scope === 'session' && !reused) {
      this.sessionGrants.add(tool.name)
      this.emit({ type: 'permission.granted', tool: tool.name })
    }
  }

  async run (call, signal, truncated = false, source = 'model') {
    const tool = this.tools.find(tool => tool.name === call.name)
    let result
    let started = false
    let before
    try {
      signal.throwIfAborted()
      if (truncated) throw new Error('Response was truncated; tool arguments were not executed')
      if (!tool) throw new Error(`Unknown tool: ${call.name}`)
      if (tool.internal && source === 'model') throw new Error('This tool is reserved for harness readiness checks')
      const args = validateToolArguments(tool, call)
      await this.authorize(tool, call, args, signal)
      signal.throwIfAborted()
      await this.session.append('tool.started', { call, source })
      started = true
      this.emit({ type: 'tool.start', call, source })
      if (this.observer && !tool.tracksWorkspace && ['write', 'shell'].includes(tool.effect)) {
        try { before = await this.observer.capture() } catch { before = null }
      }
      signal.throwIfAborted()
      const output = await tool.execute(args, { signal, emit: event => this.emit({ ...event, callId: call.id }), call, observer: this.observer, source })
      result = normalizeResult(output)
      const images = await storeImages(this.session.directory, result.images)
      result = { ...result, images }
      if (images.length) result.text += `\nScreenshots: ${images.map(image => image.artifact).join(', ')}`
      if (result.text.length > 14000) {
        const artifact = `${randomUUID()}.txt`
        await writeFile(path.join(this.session.directory, artifact), result.text, { mode: 0o600, flag: 'wx' })
        result = { ...result, text: `${result.text.slice(0, 7000)}\n[... truncated; use read_artifact with id ${artifact} ...]\n${result.text.slice(-5000)}` }
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      result = { text: signal.aborted ? 'Operation cancelled; inspect any partial effects before retrying.' : text, isError: true }
    }
    let changes = result.changes
    if (before) {
      try { changes = this.observer.compare(before, await this.observer.capture()) } catch { changes = { files: [], count: 0, unavailable: true } }
    } else if (before === null) changes = { files: [], count: 0, unavailable: true }
    if (changes?.count) result.text += `\nObserved workspace changes (not verification): ${changes.files.slice(0, 12).map(file => file.path.length > 160 ? `${file.path.slice(0, 157)}...` : file.path).join(', ')}${changes.count > 12 ? `; ${changes.count - 12} more` : ''}`
    const message = toolResult(call, result.text, result.isError, result.images)
    const visible = toolEventMessage(call, message, source)
    const status = signal.aborted ? 'cancelled' : result.outcomeUnknown ? 'unknown' : result.isError ? 'failed' : ['running', 'starting'].includes(result.process?.status) ? 'running' : 'completed'
    await this.session.append('tool.finished', { callId: call.id, source, executed: started, changes, process: result.process, message: visible, text: visible ? undefined : result.text, status })
    this.emit({ type: 'tool.end', call, result, status, source })
    return message
  }
}

// workspaceObserver supplies the optional dispatcher instrumentation through an explicit workspace interface.
export function workspaceObserver (cwd) {
  return new WorkspaceObserver(cwd)
}
