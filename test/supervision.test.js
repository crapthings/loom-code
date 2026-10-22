import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Budget } from '../src/core/budget.js'
import { contextMessages } from '../src/core/context.js'
import { ProgressSupervisor, progressQuestions, supervisionState } from '../src/core/supervision.js'
import { hashText } from '../src/tools/files.js'
import { agentFixture, call, deferred, fixture, response } from './helpers.js'

// assessment returns deterministic classifier judgments without invoking a paid provider.
function assessment ({ progress = 'stalled', task = 'change', nextAction = 'implement', adherence = 'unknown', confidence = 0.9 } = {}) {
  const choices = { progress, task, nextAction, adherence }
  const answers = Object.fromEntries(Object.entries(progressQuestions).map(([key, question]) => {
    const alternatives = Object.keys(question.criteria)
    return [key, { type: 'choice', choice: choices[key], confidence, probabilities: Object.fromEntries(alternatives.map(value => [value, value === choices[key] ? 0.9 : 0.1 / (alternatives.length - 1)])) }]
  }))
  return { stopReason: 'stop', answers, usage: { totalTokens: 100, cost: { total: 0.00001 } } }
}

test('supervision escalates sustained investigation independently of commentary and preserves authorized tool execution', async t => {
  const original = Array.from({ length: 12 }, (_, index) => `// Relevant source line ${index}`).join('\n') + '\nexport const visible = false\n'
  const evaluations = []
  const progressModel = { label: 'fake/progress', classify: async context => { evaluations.push(context); return assessment() } }
  const script = Array.from({ length: 12 }, (_, index) => response([{ type: 'text', text: 'Still investigating internals.' }, call('read_file', { path: 'app.js', offset: index + 1, limit: 1 }, `read-${index}`)], 'toolUse'))
  script.push(request => {
    assert.match(request.messages.at(-1).content, /Next action: implement/)
    assert.equal(request.tools.some(tool => tool.name === 'edit_file'), true)
    return response([call('edit_file', { path: 'app.js', oldText: 'visible = false', newText: 'visible = true', expectedHash: hashText(original) }, 'fix')], 'toolUse')
  }, request => {
    assert.match(request.messages.at(-1).content, /If that change has already been made, verify it/)
    return response([call('read_file', { path: 'app.js', offset: 13 }, 'verify')], 'toolUse')
  }, response('Scoped change saved; actual visual behavior still needs rendering verification.'))
  const { cwd, agent, session, model } = await agentFixture(t, script, { progressModel, mode: 'edit' })
  await writeFile(path.join(cwd, 'app.js'), original)
  await agent.enqueue('Fix invisible blocks after landing')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(evaluations.length, 1)
  assert.equal(evaluations[0].state.taskInputs[0].text, 'Fix invisible blocks after landing')
  assert.equal(evaluations[0].state.counts.successfulFileTools, 0)
  assert.equal(evaluations[0].state.counts.currentOutcomes, 12)
  assert.equal(evaluations[0].state.currentEvidence[0].tool, 'read_file')
  assert.match(evaluations[0].state.currentEvidence[0].arguments.text, /app.js/)
  assert.equal(await readFile(path.join(cwd, 'app.js'), 'utf8'), original.replace('visible = false', 'visible = true'))
  assert.equal(session.latestEvent('progress.directed').action, 'implement')
  const followup = session.latestEvent('progress.followup')
  assert.equal(followup.directionId, session.latestEvent('progress.directed').id)
  assert.equal(followup.changedFiles, 1)
  assert.equal(followup.tools, 2)
  assert.equal(session.latestEvent('task.finished').metrics.interventions, 1)
  assert.equal(session.latestEvent('task.finished').metrics.observedChangedFiles, 1)
  assert.equal(session.events.filter(event => event.type === 'tool.started').length, 14)
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 14)
  assert.equal(agent.budget.calls, 15)
  assert.equal(agent.budget.decisionCalls, 1)
  assert.equal(agent.budget.tokens, 250)
  assert.equal(agent.budget.remaining, Infinity)
  assert.equal(model.requests[12].system, model.requests[11].system)
  assert.ok(contextMessages(session).every(message => !JSON.stringify(message).includes('Independent progress assessment')))
})

test('short successful work does not invoke the supervisor or add model calls', async t => {
  let decisions = 0
  const progressModel = { label: 'fake/progress', classify: async () => { decisions++; return assessment() } }
  const { agent } = await agentFixture(t, [response([call('list_files')], 'toolUse'), response('Inspected')], { progressModel })
  await agent.enqueue('Inspect files')
  await agent.wait()
  assert.equal(decisions, 0)
  assert.equal(agent.budget.calls, 2)
})

test('read-only and uncertain requests cannot receive implementation directions and improving evidence clears stale feedback', async t => {
  const { session } = await fixture(t)
  await session.append('inbox.delivered', { message: { role: 'user', content: 'Review the design without changing code' } })
  const supervisor = new ProgressSupervisor()
  const options = { session, budget: new Budget(), from: 0, rounds: 12, mode: 'auto', signal: new AbortController().signal, emit: () => {} }
  for (const task of ['research', 'unknown']) {
    const result = await supervisor.assess({ ...options, model: { label: 'fake', classify: async () => assessment({ task }) } })
    assert.equal(result.action, 'inspect')
    assert.match(supervisor.feedback.content, /Keep research-only requests read-only/)
  }
  const plan = await supervisor.assess({ ...options, mode: 'plan', model: { label: 'fake', classify: async () => assessment() } })
  assert.equal(plan.action, 'inspect')
  const uncertain = await supervisor.assess({ ...options, model: { label: 'fake', classify: async () => assessment({ confidence: 0.5 }) } })
  assert.equal(uncertain.action, null)
  assert.equal(uncertain.verdict, 'unknown')
  assert.equal(supervisor.feedback, null)
  const improving = await supervisor.assess({ ...options, model: { label: 'fake', classify: async () => assessment({ progress: 'advancing', nextAction: 'verify' }) } })
  assert.equal(improving.action, null)
  assert.equal(supervisor.feedback, null)
})

test('supervision snapshots preserve original inputs, show omissions, and exclude private reasoning from recalled records', async t => {
  const { session } = await fixture(t)
  for (let index = 0; index < 10; index++) await session.append('inbox.delivered', { message: { role: 'user', content: `${index}: ${'中'.repeat(6000)}` } })
  for (let index = 0; index < 25; index++) {
    await session.append('tool.started', { call: call('shell', { command: 'inspect'.repeat(3000) }, `probe-${index}`) })
    await session.append('tool.finished', { callId: `probe-${index}`, status: 'completed', executed: true, message: { role: 'toolResult', toolName: 'shell', content: [{ type: 'text', text: 'output'.repeat(3000) }] } })
  }
  const history = { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING_SENTINEL' }, { type: 'text', text: 'Historical claim, not current proof' }] }, type: 'message' }
  await session.append('tool.finished', { callId: 'recall', status: 'completed', message: { role: 'toolResult', toolName: 'read_history', content: [{ type: 'text', text: JSON.stringify({ text: JSON.stringify(history) }) }] } })
  const state = supervisionState(session, { from: 0, after: 20, mode: 'ask' })
  const text = JSON.stringify({ state, questions: progressQuestions })
  assert.ok(Buffer.byteLength(text) <= 32768)
  assert.ok(state.taskInputs[0].text.startsWith('0:'))
  assert.ok(state.taskInputs.at(-1).text.startsWith('9:'))
  assert.equal(state.omitted.inputs, 2)
  assert.ok(state.omitted.current > 0)
  assert.equal(state.counts.successfulFileTools, 0)
  assert.match(text, /Historical claim/)
  assert.doesNotMatch(text, /PRIVATE_REASONING_SENTINEL/)
  assert.ok(state.currentEvidence.some(event => event.result.truncated))
})

test('unavailable or malformed progress judgments fail open with bounded backoff and recorded usage', async t => {
  const { session } = await fixture(t)
  const supervisor = new ProgressSupervisor()
  assert.equal(supervisor.due(2, { reasons: ['failed_tools'] }), false)
  assert.equal(supervisor.due(3, { reasons: ['failed_tools'] }), true)
  const budget = new Budget()
  const result = await supervisor.assess({ session, budget, from: 0, rounds: 3, mode: 'ask', signal: new AbortController().signal, emit: () => {}, model: { label: 'fake', classify: async () => { const result = assessment(); result.answers.progress.probabilities.stalled = 2; return result } } })
  assert.equal(result.status, 'failed')
  assert.equal(supervisor.feedback, null)
  assert.equal(budget.decisionTokens, 100)
  assert.equal(supervisor.due(15, { reasons: ['failed_tools'] }), false)
  assert.equal(supervisor.due(27, null), true)
  const failing = { label: 'fake', classify: async () => { throw new Error('Unavailable') } }
  await supervisor.assess({ session, budget, from: 0, rounds: 27, mode: 'ask', signal: new AbortController().signal, emit: () => {}, model: failing })
  assert.equal(supervisor.due(51, null), false)
  assert.equal(supervisor.due(75, null), true)
  assert.equal(session.events.filter(event => event.type === 'decision.started').length, 2)
  assert.equal(session.events.filter(event => event.type === 'decision.finished').length, 2)
})

test('progress assessments neither consume chat steps nor exhaust the separate completion evaluation allowance', () => {
  const budget = new Budget({ steps: 1 })
  for (let index = 0; index < 5; index++) assert.equal(budget.takeDecision('progress'), true)
  for (let index = 0; index < 3; index++) assert.equal(budget.takeDecision('shadow'), true)
  assert.equal(budget.takeDecision('shadow'), false)
  assert.equal(budget.remaining, 1)
  assert.equal(budget.decisionCalls, 8)
  budget.take()
  assert.equal(budget.calls, 1)
  assert.equal(budget.takeDecision('progress'), false)
})

test('cancellation settles an in-flight progress judgment and never dispatches another tool or completion', async t => {
  const entered = deferred()
  const progressModel = { label: 'fake/progress', classify: () => { entered.resolve(); return new Promise(() => {}) } }
  const { agent, session, model } = await agentFixture(t, [0, 1, 2].map(index => response([call('list_files', {}, `list-${index}`)], 'toolUse')), { progressModel })
  await agent.enqueue('Investigate')
  await entered.promise
  agent.interrupt()
  await agent.wait()
  assert.equal(agent.status, 'interrupted')
  assert.equal(model.requests.length, 3)
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 3)
  assert.equal(session.latestEvent('decision.finished').mode, 'progress')
  assert.equal(session.latestEvent('decision.finished').status, 'cancelled')
  assert.equal(session.events.some(event => event.type === 'task.finished'), false)
  assert.equal(session.events.some(event => event.type === 'progress.directed'), false)
})

test('new steering during a progress judgment clears its direction before the next model request', async t => {
  const entered = deferred()
  const release = deferred()
  const progressModel = { label: 'fake/progress', classify: async () => { entered.resolve(); await release.promise; return assessment() } }
  const script = [0, 1, 2].map(index => response([call('list_files', {}, `list-${index}`)], 'toolUse'))
  script.push(request => {
    assert.ok(request.messages.every(message => !JSON.stringify(message).includes('Independent progress assessment')))
    assert.match(request.messages.at(-1).content, /Only explain/)
    return response('Explanation')
  })
  const { agent } = await agentFixture(t, script, { progressModel })
  await agent.enqueue('Fix the issue')
  await entered.promise
  await agent.enqueue('Only explain the findings; do not change code')
  release.resolve()
  await agent.wait()
  assert.equal(agent.status, 'idle')
})

test('recovery preserves progress decision identity without retrying classification or reopening completed work', async t => {
  const { session } = await fixture(t)
  await session.append('decision.started', { decisionId: 'in-flight-progress', mode: 'progress' })
  assert.equal(await session.recover(), false)
  assert.equal(session.latestEvent('decision.finished').mode, 'progress')
  assert.equal(session.latestEvent('decision.finished').status, 'unknown')
  await session.recover()
  assert.equal(session.events.filter(event => event.type === 'decision.finished').length, 1)
})
