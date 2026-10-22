import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/core/session.js'
import { taskState } from '../src/core/task-state.js'
import { contextBudget } from '../src/core/context-budget.js'
import { contextMessages, compactContext } from '../src/core/context.js'
import { Budget } from '../src/core/budget.js'
import { fixture, fakeModel, response, agentFixture, call } from './helpers.js'

test('context reserves output and safety space without confusing estimates with billed usage', () => {
  const pressure = contextBudget({ model: { contextWindow: 32000, maxOutputTokens: 4000 }, system: 'rules', messages: [{ role: 'user', content: '中文 task' }], tools: [] })
  assert.equal(pressure.output, 4000)
  assert.equal(pressure.inputLimit, 24800)
  assert.equal(pressure.compactAt, 20800)
  assert.equal(pressure.estimated, true)
  assert.ok(pressure.components.messages > 0)
  assert.equal(contextBudget({ model: { contextWindow: 1000000, maxOutputTokens: 128000 } }).output, 8192)
})

test('task state preserves corrections and outcome references without inferring verification', async t => {
  const { session } = await fixture(t)
  await session.append('inbox.delivered', { inputId: 'original', message: { role: 'user', content: 'Change login', timestamp: 1 } })
  await session.append('inbox.delivered', { inputId: 'correction', message: { role: 'user', content: 'Keep the public API unchanged', timestamp: 2 } })
  await session.append('tool.finished', { callId: 'write', status: 'unknown' })
  await session.append('message', { message: response('All tests passed') })
  const state = taskState(session)
  assert.equal(state.status, 'unfinished')
  assert.equal(state.inputs[1].text, 'Keep the public API unchanged')
  assert.equal(state.outcomes[0].status, 'unknown')
  assert.equal(Object.hasOwn(state, 'verified'), false)
  await session.append('task.finished', { from: 1, runId: 'run' })
  assert.equal(taskState(session).status, 'execution-finished')
  await session.append('inbox.delivered', { inputId: 'next', message: { role: 'user', content: 'Next task', timestamp: 3 } })
  assert.deepEqual(taskState(session).inputs.map(input => input.text), ['Next task'])
})

test('compacted task inputs survive reopen independently of a lossy summary', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('inbox.delivered', { inputId: 'request', message: { role: 'user', content: 'Never change the login API', timestamp: 1 } })
  await session.append('message', { message: response('Working') })
  await session.append('inbox.delivered', { inputId: 'fix', message: { role: 'user', content: 'Use pnpm', timestamp: 2 } })
  await compactContext({ session, model: fakeModel([response('Objective: update login')]), system: '', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {}, force: true })
  assert.match(contextMessages(session)[0].content, /Never change the login API/)
  assert.equal(session.events.at(-1).task.inputs[0].inputId, 'request')
  await session.close()
  const reopened = await Session.open(cwd, session.id, { existing: true })
  try {
    assert.match(contextMessages(reopened)[0].content, /Never change the login API/)
    assert.equal(contextMessages(reopened).at(-1).content, 'Use pnpm')
  } finally { await reopened.close() }
})

test('task input limits preserve the original and latest corrections with explicit omissions', async t => {
  const { session } = await fixture(t)
  for (let index = 0; index < 10; index++) await session.append('inbox.delivered', { inputId: String(index), message: { role: 'user', content: `${index}: ${'中'.repeat(5000)}`, timestamp: index } })
  const state = taskState(session)
  assert.equal(state.inputs.length, 8)
  assert.equal(state.inputs[0].inputId, '0')
  assert.equal(state.inputs.at(-1).inputId, '9')
  assert.equal(state.omitted.inputs, 2)
  assert.equal(state.inputs[0].truncated, true)
  assert.match(state.inputs[0].text, /source event/)
})

test('automatic compaction that grows history is rejected without committing a checkpoint', async t => {
  const { session } = await fixture(t)
  await session.append('message', { message: { role: 'user', content: 'x'.repeat(9000), timestamp: 1 } })
  await session.append('message', { message: { role: 'user', content: 'latest', timestamp: 2 } })
  const model = fakeModel([response('y'.repeat(30000))])
  model.contextWindow = 4000
  await assert.rejects(compactContext({ session, model, system: '', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {} }), /did not reduce/)
  assert.equal(session.events.some(event => event.type === 'context.compacted'), false)
})

test('one long task compacts complete parallel tool rounds and preserves original requirements across reopen', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('inbox.delivered', { inputId: 'original', message: { role: 'user', content: 'Fix landing; do not change the public API' } })
  for (let round = 0; round < 6; round++) {
    const calls = [call('read_file', { path: 'app.js' }, `${round}-a`), call('read_file', { path: 'view.js' }, `${round}-b`)]
    await session.append('message', { message: response(calls, 'toolUse') })
    for (const item of calls.reverse()) await session.append('tool.finished', { callId: item.id, status: 'completed', executed: true, message: { role: 'toolResult', toolCallId: item.id, toolName: item.name, content: [{ type: 'text', text: 'evidence '.repeat(350) }] } })
  }
  const model = fakeModel([response('Objective: fix landing. Earlier reads remain inconclusive.')])
  model.contextWindow = 7000
  const options = { session, model, system: '', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {} }
  assert.equal(await compactContext(options), true)
  const checkpoint = session.latestEvent('context.compacted')
  assert.ok(checkpoint.inputAfter < checkpoint.inputBefore)
  const sent = contextBudget({ model, ...model.requests[0] })
  assert.ok(sent.input <= sent.inputLimit)
  await session.close()
  const reopened = await Session.open(cwd, session.id, { existing: true })
  try {
    const messages = contextMessages(reopened)
    assert.match(messages[0].content, /do not change the public API/)
    const pending = new Set()
    for (const message of messages) {
      if (message.role === 'assistant') for (const part of message.content) if (part.type === 'toolCall') pending.add(part.id)
      if (message.role === 'toolResult') { assert.ok(pending.has(message.toolCallId)); pending.delete(message.toolCallId) }
    }
    assert.equal(pending.size, 0)
    assert.ok(messages.some(message => message.role === 'toolResult'))
    assert.ok(contextBudget({ model, messages }).input < sent.inputLimit)
  } finally { await reopened.close() }
})

test('compaction refuses unresolved tool exchanges without invoking a model', async t => {
  const { session } = await fixture(t)
  await session.append('message', { message: { role: 'user', content: 'Inspect' } })
  await session.append('message', { message: response([call('read_file', { path: 'a.js' })], 'toolUse') })
  const model = fakeModel([])
  await assert.rejects(compactContext({ session, model, system: '', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {}, force: true }), /unsettled tool calls/)
  assert.equal(model.requests.length, 0)
})

test('agent forwards output allowance and refuses oversized indivisible input before provider execution', async t => {
  const { agent, model } = await agentFixture(t, [(request, options) => { assert.equal(options.maxTokens, 6400); return response('Done') }])
  await agent.enqueue('Explain login')
  await agent.wait()
  assert.equal(model.requests.length, 1)
  await agent.enqueue('x'.repeat(100000))
  await agent.wait()
  assert.equal(agent.status, 'failed')
  assert.equal(model.requests.length, 1)
})

test('runtime review reminders count toward compaction limits without becoming user requirements or summary input', async t => {
  const { session } = await fixture(t)
  await session.append('inbox.delivered', { message: { role: 'user', content: 'Original task' } })
  await session.append('message', { message: response('Previous findings') })
  await session.append('inbox.delivered', { message: { role: 'user', content: 'Latest correction' } })
  const reminders = [{ role: 'user', content: 'Harness progress review', timestamp: 1 }]
  const model = fakeModel([response('Objective: keep the original task')])
  await compactContext({ session, model, system: '', tools: [], reminders, budget: new Budget(), signal: new AbortController().signal, emit: () => {}, force: true })
  const expected = contextBudget({ model, system: '', tools: [], messages: [...contextMessages(session), ...reminders] }).input
  assert.equal(session.latestEvent('context.compacted').inputAfter, expected)
  assert.ok(!JSON.stringify(model.requests[0]).includes('Harness progress review'))
  assert.ok(taskState(session).inputs.every(input => !input.text.includes('Harness progress review')))
  await session.append('message', { message: response('More findings') })
  await session.append('inbox.delivered', { message: { role: 'user', content: 'One more correction' } })
  const budget = new Budget()
  await assert.rejects(compactContext({ session, model, system: '', tools: [], reminders: [{ role: 'user', content: 'x'.repeat(100000) }], budget, signal: new AbortController().signal, emit: () => {}, force: true }), /too large/)
  assert.equal(budget.calls, 0)
})
