import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { completionQuestions, TurnBoundary } from '../src/core/turn-boundary.js'
import { Budget } from '../src/core/budget.js'
import { contextMessages } from '../src/core/context.js'
import { taskState } from '../src/core/task-state.js'
import { listSessions } from '../src/core/session-list.js'
import { Session } from '../src/core/session.js'
import { agentFixture, call, deferred, response, fixture } from './helpers.js'

// completion supplies schema-valid offline assessments for explicit boundary outcomes.
function completion (next, coverage = next === 'complete' ? 'complete' : 'incomplete') {
  const answers = { unsupportedClaims: { type: 'bool', probability: 0.05 }, missingVerification: { type: 'bool', probability: next === 'complete' ? 0.05 : 0.9 } }
  for (const [key, choice] of Object.entries({ coverage, next })) {
    const alternatives = Object.keys(completionQuestions[key].criteria)
    answers[key] = { type: 'choice', choice, confidence: 0.95, probabilities: Object.fromEntries(alternatives.map(value => [value, value === choice ? 0.94 : 0.06 / (alternatives.length - 1)])) }
  }
  return { stopReason: 'stop', answers, usage: { totalTokens: 100, cost: { total: 0.00001 } } }
}

test('completion review continues unfinished work through the dispatcher and settles only after supported evidence', async t => {
  const judgments = ['continue', 'complete']
  const decisionModel = { label: 'fake/completion', classify: async () => completion(judgments.shift()) }
  const { cwd, agent, session, model, events } = await agentFixture(t, [response('I will create it.'), request => {
    assert.match(request.messages.at(-1).content, /unmet original requirement/)
    return response([call('write_file', { path: 'result.txt', content: 'created' }, 'write')], 'toolUse')
  }, response('Created result.txt.')], { decisionModel, verification: 'auto', mode: 'edit' })
  await agent.enqueue('Create result.txt containing created')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), 'created')
  assert.equal(session.events.filter(event => event.type === 'task.finished').length, 1)
  assert.equal(session.latestEvent('task.finished').outcome, 'completed')
  assert.equal(session.unfinished, false)
  assert.equal(model.requests.length, 3)
  assert.equal(agent.budget.decisionCalls, 2)
  assert.equal(agent.budget.decisionTokens, 200)
  const execution = session.latestEvent('tool.finished')
  assert.equal(execution.changes.count, 1)
  assert.match(execution.changes.files[0].after, /^[a-f0-9]{64}$/)
  assert.equal(session.latestEvent('task.finished').metrics.observedChangedFiles, 1)
  assert.ok(events.some(event => event.type === 'completion.assessment.end' && event.outcome === 'continue'))
  assert.ok(contextMessages(session).every(message => !JSON.stringify(message).includes('completion review found')))
})

test('a repeated proposed ending without new execution settles unverified without an infinite stop loop', async t => {
  const decisionModel = { label: 'fake/completion', classify: async () => completion('continue') }
  const { cwd, agent, session, model } = await agentFixture(t, [response('Done'), response('Done again')], { decisionModel, verification: 'auto' })
  await agent.enqueue('Fix the current symptom')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 2)
  assert.equal(session.latestEvent('completion.reviewed').reason, 'no_new_execution')
  assert.equal(session.latestEvent('task.finished').outcome, 'unverified')
  assert.equal(session.unfinished, true)
  assert.equal((await listSessions(cwd)).sessions[0].status, 'unverified')
})

test('correction rounds are bounded even when the model keeps issuing irrelevant tools', async t => {
  const decisionModel = { label: 'fake/completion', classify: async () => completion('continue') }
  const { agent, session, model } = await agentFixture(t, [response('Done'), response([call('list_files', {}, 'a')], 'toolUse'), response('Done'), response([call('list_files', {}, 'b')], 'toolUse'), response('Done')], { decisionModel, verification: 'auto' })
  await agent.enqueue('Implement the requested change')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 5)
  assert.equal(session.latestEvent('completion.reviewed').reason, 'correction_limit')
  assert.equal(session.latestEvent('task.finished').outcome, 'unverified')
})

test('research can complete without writes and blocked work retains its original task for explicit resume', async t => {
  const judgments = ['complete', 'blocked', 'complete']
  const contexts = []
  const decisionModel = { label: 'fake/completion', classify: async context => { contexts.push(context); return completion(judgments.shift()) } }
  const { agent, session } = await agentFixture(t, [response('This file exports a function.'), response('The required input is missing.'), response('Finished after receiving input.')], { decisionModel, verification: 'auto', mode: 'plan' })
  await agent.enqueue('Explain the function; do not edit')
  await agent.wait()
  assert.equal(session.latestEvent('task.finished').outcome, 'completed')
  assert.ok(contexts[0].execution.tools.every(tool => !['write_file', 'shell'].includes(tool)))
  await agent.enqueue('Analyze the missing sample after it becomes available')
  await agent.wait()
  assert.equal(session.latestEvent('task.finished').outcome, 'blocked')
  const original = session.latestEvent('task.finished').from
  await agent.resume()
  await agent.wait()
  assert.equal(session.latestEvent('task.finished').from, original)
  assert.match(contexts[2].state.taskInputs[0].text, /missing sample/)
  assert.equal(session.events.filter(event => event.type === 'tool.started').length, 0)
})

test('new input during completion review supersedes the old ending and preserves task scope', async t => {
  const entered = deferred()
  const release = deferred()
  let decisions = 0
  const decisionModel = { label: 'fake/completion', classify: async () => { if (++decisions === 1) { entered.resolve(); await release.promise } return completion('complete') } }
  const { agent, session, model } = await agentFixture(t, [response('First answer'), response('Corrected answer')], { decisionModel, verification: 'auto' })
  await agent.enqueue('Explain the function')
  await entered.promise
  await agent.enqueue('Include edge cases')
  release.resolve()
  await agent.wait()
  assert.equal(model.requests.length, 2)
  assert.equal(session.events.filter(event => event.type === 'task.finished').length, 1)
  assert.deepEqual(taskState(session).inputs.map(input => input.text), ['Explain the function', 'Include edge cases'])
})

test('cancellation and classifier failure never create a verified completion or replay tools', async t => {
  const entered = deferred()
  const decisionModel = { label: 'fake/completion', classify: async () => { entered.resolve(); return new Promise(() => {}) } }
  const { agent, session } = await agentFixture(t, [response('Candidate answer'), response('Candidate after resume')], { decisionModel, verification: 'auto' })
  await agent.enqueue('Inspect this project')
  await entered.promise
  agent.interrupt()
  await agent.wait()
  assert.equal(session.latestEvent('decision.finished').status, 'cancelled')
  assert.equal(session.latestEvent('task.finished'), undefined)
  assert.equal(session.unfinished, true)
  decisionModel.classify = async () => { throw new Error('Unavailable') }
  await agent.resume()
  await agent.wait()
  assert.equal(session.latestEvent('task.finished').outcome, 'unverified')
  assert.equal(session.events.filter(event => event.type === 'tool.started').length, 0)
})

test('completion uncertainty survives reopening without automatically scheduling execution', async t => {
  const decisionModel = { label: 'fake/completion', classify: async () => completion('unverified', 'unknown') }
  const { cwd, agent, session } = await agentFixture(t, [response('The visual result still needs observation')], { decisionModel, verification: 'auto' })
  await agent.enqueue('Verify the visual behavior')
  await agent.wait()
  await agent.close()
  const reopened = await Session.open(cwd, session.id, { existing: true })
  try {
    await reopened.recover()
    assert.equal(reopened.unfinished, true)
    assert.equal(reopened.pending.length, 0)
    assert.equal(reopened.latestEvent('task.finished').outcome, 'unverified')
  } finally { await reopened.close() }
})

test('bounded completion evidence cannot certify success when original requirements are omitted', async t => {
  const { session } = await fixture(t)
  for (let index = 0; index < 10; index++) await session.append('inbox.delivered', { message: { role: 'user', content: `${index}: ${'要求'.repeat(3000)}` } })
  await session.append('message', { message: response([{ type: 'thinking', thinking: 'PRIVATE_SENTINEL' }, { type: 'text', text: 'Done' }]) })
  const model = {
    label: 'fake/completion',
    classify: async context => {
      const serialized = JSON.stringify(context)
      assert.ok(Buffer.byteLength(serialized) <= 65536)
      assert.doesNotMatch(serialized, /PRIVATE_SENTINEL/)
      assert.equal(context.state.omitted.inputs, 2)
      return completion('complete')
    }
  }
  const result = await new TurnBoundary().finish({ session, model, budget: new Budget(), from: 0, mode: 'edit', instructions: '规则'.repeat(9000), signal: new AbortController().signal, emit: () => {} })
  assert.equal(result.outcome, 'unverified')
})

test('an interrupted resume preserves the original unverified task through a second resume', async t => {
  const contexts = []
  const decisionModel = { label: 'fake/completion', classify: async context => { contexts.push(context); return completion('unverified', 'unknown') } }
  const { agent, session } = await agentFixture(t, [response('Unverified'), () => { throw new Error('Interrupted transport') }, response('Still unverified')], { decisionModel, verification: 'auto' })
  await agent.enqueue('Fix the original rendering symptom')
  await agent.wait()
  await agent.resume()
  await agent.wait()
  assert.equal(agent.status, 'failed')
  await agent.resume()
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(contexts[1].state.taskInputs[0].text, 'Fix the original rendering symptom')
  assert.equal(session.latestEvent('task.finished').outcome, 'unverified')
})
