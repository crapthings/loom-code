import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createModels, createProvider } from '@earendil-works/pi-ai'
import { typesafeSystemOneApi } from '@earendil-works/pi-ai/api/typesafe-system-one.lazy'
import { createDecisionModel, defaultDecisionModel, listDecisionModels } from '../src/model/decision.js'
import { createModel, listModels } from '../src/model/provider.js'
import { Budget } from '../src/core/budget.js'
import { listSessions } from '../src/core/session-list.js'
import { contextMessages } from '../src/core/context.js'
import { verificationQuestions, verificationState, verifyCompletion } from '../src/core/verification.js'
import { parseOptions } from '../src/cli.js'
import { agentFixture, call, deferred, fixture, response } from './helpers.js'

// judgment supplies deterministic classifier answers with explicit uncertainty and reported usage.
function judgment (choice = 'incomplete') {
  return { stopReason: 'stop', answers: { coverage: { type: 'choice', choice, confidence: 0.8, probabilities: { complete: choice === 'complete' ? 0.8 : 0.1, incomplete: choice === 'incomplete' ? 0.8 : 0.1, unknown: choice === 'unknown' ? 0.8 : 0.1 } }, unsupportedClaims: { type: 'bool', probability: 0.8 }, missingVerification: { type: 'bool', probability: 0.7 } }, usage: { totalTokens: 100, cost: { total: 0.00001 } } }
}

test('decision models have separate offline catalogs with automatic supervision and optional completion checks', () => {
  assert.equal(createDecisionModel().label, `vercel-ai-gateway/${defaultDecisionModel}`)
  assert.ok(listDecisionModels().includes(`vercel-ai-gateway/${defaultDecisionModel}`))
  assert.ok(listDecisionModels().includes('vercel-ai-gateway/typesafe-ai/jev'))
  assert.ok(!listModels().includes(`vercel-ai-gateway/${defaultDecisionModel}`))
  assert.throws(() => createModel({ model: defaultDecisionModel }), /Unknown model/)
  assert.throws(() => createDecisionModel({ model: 'openai/gpt-6.1-sol' }), /Unknown decision model/)
  assert.equal(parseOptions([], {}).verify, 'auto')
  assert.equal(parseOptions([], {}).supervise, 'auto')
  assert.equal(parseOptions(['--supervise', 'off'], {}).supervise, 'off')
  assert.throws(() => parseOptions(['--supervise', 'on'], {}), /--supervise/)
  assert.equal(parseOptions(['--verify', 'shadow'], {}).decisionModel, defaultDecisionModel)
  assert.equal(parseOptions(['--decision-model', defaultDecisionModel], { LOOM_DECISION_MODEL: 'typesafe-ai/jev' }).decisionModel, defaultDecisionModel)
  assert.equal(parseOptions([], { LOOM_DECISION_MODEL: 'typesafe-ai/jev' }).decisionModel, 'typesafe-ai/jev')
  assert.throws(() => parseOptions(['--verify', 'invalid'], {}), /--verify/)
})

test('native Pi classifier sends System One questions and never retries a failed HTTP request', async t => {
  const requests = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) })
    res.writeHead(requests.length === 1 ? 200 : 503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(requests.length === 1 ? { answers: { coverage: judgment().answers.coverage, unsupportedClaims: { type: 'noul', noul: 0.8 }, missingVerification: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 100, output_tokens: 0 } } : { error: 'unavailable' }))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const baseUrl = `http://127.0.0.1:${server.address().port}/typesafe/v1`
  const collection = createModels()
  collection.setProvider(createProvider({ id: 'vercel-ai-gateway', name: 'Offline decision transport', baseUrl, auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'offline-decision' } }) } }, models: [{ type: 'classifier', id: defaultDecisionModel, name: 'Offline Luna', provider: 'vercel-ai-gateway', api: 'typesafe-system-one', baseUrl, input: ['text'], contextWindow: 1050000, cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } }], classifiers: { 'typesafe-system-one': typesafeSystemOneApi() } }))
  const model = createDecisionModel({ collection })
  const signal = new AbortController().signal
  const result = await model.classify({ state: { task: 'Inspect' }, questions: verificationQuestions }, { signal })
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(result.answers.unsupportedClaims.probability, 0.8)
  assert.equal(result.usage.totalTokens, 100)
  assert.equal(result.usage.cost.total, 0.00001)
  assert.equal(requests[0].url, '/typesafe/v1/systemone')
  assert.equal(requests[0].auth, 'Bearer offline-decision')
  assert.equal(requests[0].body.model, defaultDecisionModel)
  assert.equal(requests[0].body.questions.unsupportedClaims.type, 'noul')
  assert.deepEqual(requests[0].body.state, { task: 'Inspect' })
  const failed = await model.classify({ state: {}, questions: verificationQuestions }, { signal })
  assert.equal(failed.stopReason, 'error')
  assert.equal(requests.length, 2)
  await assert.rejects(model.classify({ state: { text: 'x'.repeat(65536) }, questions: verificationQuestions }, { signal }), /64 KiB/)
  assert.equal(requests.length, 2)
})

test('shadow judgments observe committed tools without changing execution or model context', async t => {
  const evaluations = []
  const decisionModel = { label: 'fake/decision', classify: async context => { evaluations.push(structuredClone(context)); return judgment() } }
  const { agent, session, model } = await agentFixture(t, [response([call('list_files')], 'toolUse'), response('Completed'), response('Another task')], { decisionModel })
  await agent.enqueue('Inspect files')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 2)
  assert.equal(evaluations.length, 1)
  assert.ok(evaluations[0].state.evidence.some(event => event.type === 'tool.finished' && event.text.includes('toolResult')))
  const started = session.events.find(event => event.type === 'decision.started')
  const finished = session.events.find(event => event.type === 'decision.finished')
  assert.equal(started.mode, 'shadow')
  assert.match(started.inputHash, /^[a-f0-9]{64}$/)
  assert.equal(finished.decisionId, started.decisionId)
  assert.equal(finished.answers.coverage.choice, 'incomplete')
  assert.ok(finished.elapsedMs >= 0)
  assert.equal(agent.budget.calls, 2)
  assert.equal(agent.budget.decisionCalls, 1)
  assert.equal(agent.budget.tokens, 120)
  assert.equal(agent.budget.decisionTokens, 100)
  assert.ok(contextMessages(session).every(message => !JSON.stringify(message).includes('unsupportedClaims')))
  await agent.enqueue('Different task')
  await agent.wait()
  assert.equal(model.requests.length, 3)
  assert.equal(evaluations[1].state.taskInputs.length, 1)
  assert.equal(evaluations[1].state.taskInputs[0].text, 'Different task')
})

test('shadow failures and malformed probabilities preserve completed work and reported usage', async t => {
  const decisionModel = {
    label: 'fake/decision',
    classify: async () => {
      const result = judgment()
      result.answers.unsupportedClaims.probability = 2
      return result
    }
  }
  const { agent, session } = await agentFixture(t, [response('Done'), response('Done')], { decisionModel })
  await agent.enqueue('Task')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(session.events.findLast(event => event.type === 'decision.finished').status, 'failed')
  assert.equal(session.events.findLast(event => event.type === 'decision.finished').usage.totalTokens, 100)
  decisionModel.classify = async () => { throw new Error('Service unavailable') }
  await agent.enqueue('Next task')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(session.events.findLast(event => event.type === 'decision.finished').error, 'Service unavailable')
})

test('shadow calls have a separate per-run cap without consuming chat steps or starving queued tasks', async t => {
  const entered = deferred()
  const release = deferred()
  let decisions = 0
  const decisionModel = { label: 'fake/decision', classify: async () => { decisions++; return judgment() } }
  const { agent, session } = await agentFixture(t, [async () => { entered.resolve(); await release.promise; return response('First') }, response('Second'), response('Third'), response('Fourth')], { decisionModel, steps: 4 })
  await agent.enqueue('First')
  await entered.promise
  for (const text of ['Second', 'Third', 'Fourth']) await agent.enqueue(text, 'queue')
  release.resolve()
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(agent.budget.calls, 4)
  assert.equal(decisions, 3)
  assert.equal(session.pending.length, 0)
  assert.equal(session.events.filter(event => event.type === 'decision.skipped').length, 1)
})

test('cancellation settles a shadow call even when the classifier ignores its abort signal', async t => {
  const entered = deferred()
  const decisionModel = { label: 'fake/decision', classify: () => { entered.resolve(); return new Promise(() => {}) } }
  const { agent, session } = await agentFixture(t, [response('Done')], { decisionModel })
  await agent.enqueue('Task')
  await entered.promise
  agent.interrupt()
  await agent.wait()
  assert.equal(agent.status, 'interrupted')
  assert.equal(session.events.findLast(event => event.type === 'decision.finished').status, 'cancelled')
  assert.equal(session.unfinished, false)
  assert.equal(await agent.resume(), false)
})

test('shadow timeouts settle without late judgments changing the journal', async t => {
  const { session } = await fixture(t)
  await session.append('inbox.delivered', { message: { role: 'user', content: 'Task' } })
  const model = { label: 'fake/slow', classify: async () => { await delay(50); return judgment() } }
  const budget = new Budget()
  await verifyCompletion({ session, model, budget, from: 0, signal: new AbortController().signal, emit: () => {}, timeoutMs: 5 })
  assert.equal(session.events.at(-1).status, 'timeout')
  const length = session.events.length
  await delay(70)
  assert.equal(session.events.length, length)
  assert.equal(budget.decisionTokens, 0)
})

test('verification evidence is bounded and recovered decisions are settled without replay', async t => {
  const { session } = await fixture(t)
  for (let index = 0; index < 40; index++) await session.append('message', { message: response('你'.repeat(12000)) })
  const state = verificationState(session, 0)
  assert.ok(Buffer.byteLength(JSON.stringify({ state, questions: verificationQuestions })) <= 65536)
  assert.ok(state.evidence.some(event => event.truncated))
  assert.equal(state.omitted.evidence, 16)
  await session.append('decision.started', { decisionId: 'crashed', mode: 'shadow' })
  assert.equal(await session.recover(), false)
  assert.equal(await session.recover(), false)
  const records = session.events.filter(event => event.type === 'decision.finished')
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'unknown')
  assert.equal(records[0].recovery, true)
})

test('a crash during shadow evaluation preserves task completion and resumes only queued work', async t => {
  const { agent, session, model, cwd } = await agentFixture(t, [response('Next task')])
  await session.append('run.started', { runId: 'crashed' })
  await session.append('inbox.delivered', { message: { role: 'user', content: 'Completed task' } })
  await session.append('task.finished', { runId: 'crashed', from: 0 })
  await session.append('decision.started', { decisionId: 'crashed-decision', mode: 'shadow' })
  assert.equal(await session.recover(), false)
  assert.equal(session.unfinished, false)
  assert.equal((await listSessions(cwd)).sessions[0].status, 'completed')
  assert.equal(await agent.resume(), false)
  await session.append('inbox.enqueued', { inputId: 'next', delivery: 'queue', text: 'Next task' })
  assert.equal(await agent.resume(), true)
  await agent.wait()
  assert.equal(model.requests.length, 1)
  assert.equal(model.requests[0].messages.at(-1).content, 'Next task')
  assert.ok(session.events.filter(event => event.type === 'inbox.delivered').every(event => !event.message.content.includes('Continue only')))
})

test('resumed completion evaluation retains the original requirement and latest corrections', async t => {
  const evaluations = []
  const decisionModel = { label: 'fake/decision', classify: async context => { evaluations.push(context); return judgment('unknown') } }
  const { agent, session } = await agentFixture(t, [response([call('list_files')], 'toolUse'), () => { throw new Error('Interrupted transport') }, response('Rendering remains unverified')], { decisionModel })
  await agent.enqueue('Fix invisible blocks after landing; verify actual rendering')
  await agent.wait()
  assert.equal(agent.status, 'failed')
  for (let index = 0; index < 9; index++) await session.append('inbox.delivered', { message: { role: 'user', content: `Correction ${index}`, timestamp: Date.now() } })
  await agent.resume()
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(evaluations.length, 1)
  const state = evaluations[0].state
  assert.equal(state.taskInputs[0].text, 'Fix invisible blocks after landing; verify actual rendering')
  assert.ok(state.taskInputs.some(input => input.text === 'Correction 8'))
  assert.equal(state.taskInputs.length, 8)
  assert.equal(state.omitted.inputs, 3)
  assert.ok(state.evidence.some(event => event.type === 'tool.finished'))
})
