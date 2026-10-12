import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Type, validateToolArguments } from '@earendil-works/pi-ai'
import { toolResult } from '../core/session.js'
import { fileTools } from './files.js'
import { shellTool } from './shell.js'
import { checkpointTool } from './checkpoints.js'
import { validateMode } from '../core/modes.js'

// createTools assembles built-ins and optional delegation behind one dispatcher-compatible registry.
export function createTools ({ cwd, session, delegate }) {
  const tools = [...fileTools(cwd, session), shellTool(cwd, session), checkpointTool(cwd, session), {
    name: 'read_artifact',
    description: 'Read a stored tool-output artifact by ID with a character offset.',
    effect: 'read',
    parallel: true,
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]+\\.txt$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    execute: async ({ id, offset = 0 }) => (await readFile(path.join(session.directory, id), 'utf8')).slice(offset, offset + 12000)
  }]
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

// Dispatcher validates and authorizes every call before durably recording and executing its intent.
export class Dispatcher {
  constructor ({ session, tools, mode = 'ask', approve = async () => false, emit = () => {} }) {
    this.session = session
    this.tools = tools
    this.mode = validateMode(mode)
    this.approve = approve
    this.emit = emit
  }

  get declarations () {
    return this.tools.filter(tool => this.mode !== 'plan' || tool.effect === 'read').map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  async batch (calls, signal, truncated = false) {
    const run = call => this.run(call, signal, truncated)
    if (calls.every(call => this.tools.find(tool => tool.name === call.name)?.parallel)) return Promise.all(calls.map(run))
    const results = []
    for (const call of calls) results.push(await run(call))
    return results
  }

  async run (call, signal, truncated = false, source = 'model') {
    const tool = this.tools.find(tool => tool.name === call.name)
    let result
    let started = false
    try {
      signal.throwIfAborted()
      if (truncated) throw new Error('Response was truncated; tool arguments were not executed')
      if (!tool) throw new Error(`Unknown tool: ${call.name}`)
      const args = validateToolArguments(tool, call)
      if (this.mode === 'plan' && tool.effect !== 'read') throw new Error('Plan mode denies side effects')
      if ((tool.effect === 'shell' && this.mode !== 'auto') || (tool.effect === 'write' && this.mode === 'ask')) {
        const allowed = await this.approve({ call, effect: tool.effect, args, signal })
        await this.session.append('permission.decided', { callId: call.id, allowed, effect: tool.effect })
        if (!allowed) throw new Error('Permission denied; choose an allowed alternative')
      }
      signal.throwIfAborted()
      await this.session.append('tool.started', { call, source })
      started = true
      this.emit({ type: 'tool.start', call })
      const output = await tool.execute(args, { signal, emit: this.emit })
      result = typeof output === 'string' ? { text: output, isError: false } : output
      if (result.text.length > 14000) {
        const artifact = `${randomUUID()}.txt`
        await writeFile(path.join(this.session.directory, artifact), result.text, { mode: 0o600, flag: 'wx' })
        result = { ...result, text: `${result.text.slice(0, 7000)}\n[... truncated; use read_artifact with id ${artifact} ...]\n${result.text.slice(-5000)}` }
      }
    } catch (error) {
      result = { text: signal.aborted ? 'Operation cancelled; inspect any partial effects before retrying.' : error.message, isError: true }
    }
    const message = toolResult(call, result.text, result.isError)
    const visible = source === 'control' ? { role: 'user', content: `User-initiated ${call.name}: ${result.text}`, timestamp: Date.now() } : message
    await this.session.append('tool.finished', { callId: call.id, source, executed: started, message: visible, status: signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'completed' })
    this.emit({ type: 'tool.end', call, result })
    return message
  }
}
