import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Session } from '../src/core/session.js'
import { Agent } from '../src/core/agent.js'

// fixture creates an isolated workspace and closes its session before deleting test artifacts.
export async function fixture (t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'loom-test-'))
  const session = await Session.open(cwd, 'test-session')
  t.after(async () => { await session.close(); await rm(cwd, { recursive: true, force: true }) })
  return { cwd, session }
}

// response constructs a minimal provider-shaped assistant message for deterministic tests.
export function response (content = 'Done', stopReason = 'stop') {
  return { role: 'assistant', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, stopReason, api: 'fake', provider: 'fake', model: 'fake', usage: { totalTokens: 10, cost: { total: 0 } }, timestamp: Date.now() }
}

// call creates a tool call with a caller-chosen identity for protocol and recovery assertions.
export function call (name, args = {}, id = 'call-1') {
  return { type: 'toolCall', id, name, arguments: args }
}

// fakeModel executes a finite response script and retains requests for behavioral assertions.
export function fakeModel (script) {
  const requests = []
  return {
    label: 'fake/model',
    contextWindow: 32000,
    requests,
    complete: async (request, options) => {
      requests.push(structuredClone(request))
      const next = script.shift()
      if (!next) throw new Error('Fake model script exhausted')
      return typeof next === 'function' ? next(request, options) : next
    }
  }
}

// agentFixture attaches a fake model and event recorder to a fresh initialized agent.
export async function agentFixture (t, script, options = {}) {
  const { cwd, session } = await fixture(t)
  const events = []
  const model = fakeModel(script)
  const agent = new Agent({ cwd, session, model, emit: event => events.push(event), ...options })
  await agent.initialize()
  t.after(() => agent.close())
  return { cwd, session, agent, model, events }
}

// deferred exposes a promise gate for deterministic cancellation and concurrent-input tests.
export function deferred () {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, resolve: release }
}
