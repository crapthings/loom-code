import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '../src/core/session.js'
import { taskState } from '../src/core/task-state.js'
import { contextBudget } from '../src/core/context-budget.js'
import { contextMessages, compactContext } from '../src/core/context.js'
import { Budget } from '../src/core/budget.js'
import { fixture, fakeModel, response, agentFixture } from './helpers.js'

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
  await session.append('message', { message: { role: 'user', content: 'x'.repeat(1000), timestamp: 1 } })
  await session.append('message', { message: { role: 'user', content: 'latest', timestamp: 2 } })
  const model = fakeModel([response('y'.repeat(3000))])
  model.contextWindow = 500
  await assert.rejects(compactContext({ session, model, system: '', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {} }), /did not reduce/)
  assert.equal(session.events.some(event => event.type === 'context.compacted'), false)
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
