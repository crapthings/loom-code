import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/core/session.js'
import { contextMessages, compactContext } from '../src/core/context.js'
import { taskState } from '../src/core/task-state.js'
import { contextBudget, estimateTokens } from '../src/core/context-budget.js'
import { Budget } from '../src/core/budget.js'
import { fakeModel, response, deferred } from './helpers.js'

// observedEvents counts numeric journal accesses without timing-dependent performance assertions.
function observedEvents (events) {
  let reads = 0
  return {
    events: new Proxy(events, { get: (target, key, receiver) => { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver) } }),
    count: () => reads
  }
}

// memorySession uses a no-op durable handle to exercise projection behavior without filesystem overhead.
function memorySession (events = [], handle = { writeFile: async () => {}, sync: async () => {} }) {
  const session = new Session('', 'projection', handle, '')
  session.events = events
  return session
}

test('incremental session views never rescan the projected prefix and publish only after sync', async () => {
  const journal = observedEvents(Array.from({ length: 10000 }, (_, seq) => ({ seq, type: 'noise' })))
  const gate = deferred()
  const writing = deferred()
  const session = memorySession(journal.events, { writeFile: async () => { writing.resolve() }, sync: () => gate.promise })
  assert.deepEqual(session.pending, [])
  const baseline = journal.count()
  const admission = session.append('inbox.enqueued', { inputId: 'one', text: 'Task' })
  await writing.promise
  assert.equal(session.pending.length, 0)
  assert.equal(journal.count(), baseline)
  gate.resolve()
  await admission
  assert.equal(session.pending[0].text, 'Task')
  assert.equal(journal.count() - baseline, 1)
  await session.append('inbox.delivered', { inputId: 'one', message: { role: 'user', content: 'Task' } })
  assert.equal(session.pending.length, 0)
  const snapshot = session.messages
  snapshot.length = 0
  assert.equal(session.messages.length, 1)
  const projected = journal.count()
  for (let index = 0; index < 100; index++) {
    assert.equal(session.pending.length, 0)
    assert.equal(session.messages.length, 1)
    session.latestEvent('noise')
  }
  assert.equal(journal.count(), projected)
  session.events = [{ seq: 0, type: 'inbox.enqueued', inputId: 'replacement', text: 'New log' }]
  assert.equal(session.pending[0].inputId, 'replacement')
  assert.deepEqual(session.messages, [])
})

test('compacted completed context reads only the retained tail after warming its event projection', () => {
  const events = Array.from({ length: 10000 }, (_, seq) => ({ seq, type: 'message', message: { role: 'user', content: 'old' } }))
  events.push({ seq: 10000, type: 'task.finished', from: 0 })
  events.push({ seq: 10001, type: 'context.compacted', through: 10000, summary: 'Handoff', at: 1 })
  events.push({ seq: 10002, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'recent' }] } })
  const journal = observedEvents(events)
  const session = memorySession(journal.events)
  session.project()
  const baseline = journal.count()
  for (let index = 0; index < 20; index++) assert.equal(contextMessages(session).length, 2)
  assert.ok(journal.count() - baseline <= 60)
})

test('bounded task projection preserves first/latest inputs and outcome omission counts without reading prior tasks', () => {
  const events = Array.from({ length: 10000 }, (_, seq) => ({ seq, type: 'noise' }))
  events.push({ seq: events.length, type: 'task.finished', from: 0 })
  for (let index = 0; index < 100; index++) {
    events.push({ seq: events.length, type: 'inbox.delivered', inputId: String(index), message: { role: 'user', content: `Correction ${index}` } })
    events.push({ seq: events.length, type: 'tool.finished', callId: String(index), status: index % 2 ? 'unknown' : 'completed' })
  }
  const journal = observedEvents(events)
  const session = memorySession(journal.events)
  session.project()
  const baseline = journal.count()
  const state = taskState(session)
  assert.deepEqual(state.inputs.map(input => input.inputId), ['0', '93', '94', '95', '96', '97', '98', '99'])
  assert.deepEqual(state.outcomes.map(outcome => outcome.callId), Array.from({ length: 12 }, (_, index) => String(88 + index)))
  assert.deepEqual(state.omitted, { inputs: 92, outcomes: 88 })
  assert.ok(journal.count() - baseline <= 201)
})

test('single-pass compaction chooses the same safe user boundary across varied conversations', async () => {
  for (let seed = 0; seed < 24; seed++) {
    const events = Array.from({ length: 12 }, (_, seq) => ({ seq, type: 'message', message: seq % (seed % 4 + 2) === 0 ? { role: 'user', content: `Request ${seq}` } : response(`Reply ${seq}`) }))
    const users = events.filter(event => event.message.role === 'user')
    const assistants = events.filter(event => event.message.role === 'assistant')
    const candidate = assistants.length > 3 ? assistants.at(-2) : users.at(-1)
    const expected = users.findLast(event => event.seq <= candidate.seq) || candidate
    const session = memorySession(events)
    const model = fakeModel([response('Handoff')])
    await compactContext({ session, model, system: '', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {}, force: true })
    assert.equal(session.latestEvent('context.compacted').through, expected.seq - 1)
    const summarized = JSON.parse(model.requests[0].messages[0].content).conversation
    assert.deepEqual(summarized, events.filter(event => event.message && event.seq < expected.seq).map(event => event.message))
  }
})

test('reused prompt byte counts preserve complete-envelope estimates and serialize each component once', () => {
  let serializations = 0
  const tools = [{ name: 'read_file', parameters: { toJSON: () => { serializations++; return { description: '中文 "quoted" \n tool' } } } }]
  const system = 'Rules: 中文 😀 "quote"'
  const messages = [{ role: 'user', content: '任务\nfollow-up\t' }]
  const expected = estimateTokens({ system, messages, tools })
  serializations = 0
  const budget = contextBudget({ model: { contextWindow: 32000 }, system, messages, tools })
  assert.equal(budget.input, expected)
  assert.equal(serializations, 1)
  assert.equal(budget.components.instructions, estimateTokens(system))
  assert.equal(budget.components.messages, estimateTokens(messages))
  assert.equal(budget.components.tools, estimateTokens(tools))
  assert.equal(contextBudget({ model: { contextWindow: 32000 } }).input, estimateTokens({ system: '', messages: [], tools: [] }))
})
