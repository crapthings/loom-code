import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ProgressMonitor } from '../src/core/progress.js'
import { toolResult } from '../src/core/session.js'
import { agentFixture, call, response } from './helpers.js'

// observe supplies one completed fake tool round to the production progress monitor.
function observe (monitor, { name = 'read_file', args = { path: 'source.js' }, text = 'unchanged source', isError = false, report = '', now = 0, reportedAt = now } = {}) {
  const invocation = call(name, args, `call-${monitor.rounds}`)
  return monitor.observe({ response: response([{ type: 'text', text: report }, invocation], 'toolUse'), calls: [invocation], results: [toolResult(invocation, text, isError)], now, reportedAt })
}

test('repeated evidence triggers a review despite commentary and is throttled across subsequent rounds', () => {
  const monitor = new ProgressMonitor(0)
  assert.equal(observe(monitor, { report: 'Investigating' }), null)
  assert.equal(observe(monitor, { report: 'Still investigating' }), null)
  const notice = observe(monitor, { report: 'Investigating again' })
  assert.deepEqual(notice.reasons, ['repeated_reads'])
  assert.equal(notice.rounds, 3)
  assert.equal(observe(monitor), null)
  assert.equal(observe(monitor), null)
  assert.ok(observe(monitor).reasons.includes('repeated_reads'))
})

test('changing read results and completed writes are not classified as repeated reads', () => {
  const monitor = new ProgressMonitor(0)
  for (let index = 0; index < 35; index++) {
    assert.equal(observe(monitor, { text: `new state ${index}`, report: 'New observation' }), null)
  }
  for (let index = 0; index < 4; index++) assert.equal(observe(monitor, { name: 'write_file', report: 'Saved another change' }), null)
})

test('one parallel batch does not count duplicate reads as multiple investigation rounds', () => {
  const monitor = new ProgressMonitor(0)
  const calls = Array.from({ length: 4 }, (_, index) => call('read_file', { path: 'file' }, `parallel-${index}`))
  assert.equal(monitor.observe({ response: response(calls, 'toolUse'), calls, results: calls.map(invocation => toolResult(invocation, 'same result')), now: 0 }), null)
  assert.equal(monitor.rounds, 1)
})

test('changed keywords do not disguise consecutive empty searches or failing probes', () => {
  const empty = new ProgressMonitor(0)
  const failed = new ProgressMonitor(0)
  for (let index = 0; index < 3; index++) {
    const emptyNotice = observe(empty, { name: 'search', args: { query: `guess-${index}` }, text: 'No matches in successfully searched files; coverage is incomplete.' })
    const failedNotice = observe(failed, { name: 'shell', args: { command: `probe-${index}` }, text: `Mock error ${index}`, isError: true })
    if (index < 2) { assert.equal(emptyNotice, null); assert.equal(failedNotice, null) } else {
      assert.deepEqual(emptyNotice.reasons, ['empty_searches'])
      assert.deepEqual(failedNotice.reasons, ['failed_tools'])
    }
  }
})

test('historical recall triggers reassessment even when each retrieved event is different', () => {
  const monitor = new ProgressMonitor(0)
  let notice
  for (let index = 0; index < 6; index++) notice = observe(monitor, { name: 'read_history', args: { seq: index }, text: `Historical event ${index}`, report: 'Looking through history' })
  assert.deepEqual(notice.reasons, ['history_only'])
  observe(monitor, { name: 'read_file', text: 'Current evidence', report: 'Inspecting current code' })
  assert.equal(monitor.history, 0)
})

test('history scan byte counters cannot disguise repeated results and malformed history stays an ordinary result', () => {
  const monitor = new ProgressMonitor(0)
  let notice
  for (let index = 0; index < 3; index++) notice = observe(monitor, { name: 'search_history', args: { query: 'ghost' }, text: JSON.stringify({ results: [{ seq: 2, excerpt: 'original evidence' }], scannedBytes: 200 * index }) })
  assert.deepEqual(notice.reasons, ['repeated_reads'])
  assert.doesNotThrow(() => observe(monitor, { name: 'search_history', text: 'malformed output' }))
})

test('silence produces a reporting reminder without declaring failure or acting during a live tool', () => {
  const monitor = new ProgressMonitor(0)
  for (let index = 0; index < 5; index++) assert.equal(observe(monitor, { text: `evidence ${index}` }), null)
  assert.deepEqual(observe(monitor, { text: 'new evidence' }).reasons, ['silent'])
  const slow = new ProgressMonitor(0)
  assert.deepEqual(observe(slow, { report: 'Starting a long tool', reportedAt: 0, now: 61000 }).reasons, ['silent'])
  assert.equal(slow.observe({ response: response('Final findings'), calls: [], results: [], now: 90000 }), null)
})

test('review feeds the next model step, preserves tool pairs, and continues without another model or a budget limit', async t => {
  const script = Array.from({ length: 3 }, (_, index) => response([call('search', { query: `missing-${index}` }, `search-${index}`)], 'toolUse'))
  script.push(request => {
    assert.doesNotMatch(request.system, /Harness progress review/)
    assert.match(request.messages.at(-1).content, /Harness progress review/)
    assert.match(request.messages.at(-1).content, /Three consecutive search rounds/)
    assert.match(request.messages.at(-1).content, /actual rendering observation/)
    return response([{ type: 'text', text: 'The searches excluded dependencies; I will inspect the source directly.' }, call('read_file', { path: 'source.js' }, 'inspect')], 'toolUse')
  }, response('Current source inspected; visual behavior remains unverified.'), request => {
    assert.ok(request.messages.every(message => !JSON.stringify(message).includes('Harness progress review')))
    return response('Next task')
  })
  const { cwd, agent, session, model, events } = await agentFixture(t, script)
  await writeFile(path.join(cwd, 'source.js'), 'current source')
  await agent.enqueue('Investigate invisible blocks')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  const review = session.events.find(event => event.type === 'progress.review')
  assert.ok(review.reasons.includes('empty_searches'))
  assert.equal(session.events[review.through].type, 'tool.finished')
  assert.ok(events.some(event => event.type === 'progress.review'))
  assert.equal(session.events.filter(event => event.type === 'inbox.delivered').length, 1)
  assert.ok(session.messages.every(message => !JSON.stringify(message).includes('Harness progress review')))
  assert.equal(model.requests[3].system, model.requests[2].system)
  assert.equal(model.requests[3].messages.at(-1).content, review.instructions)
  assert.equal(session.events.filter(event => event.type === 'tool.started').length, 4)
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 4)
  assert.equal(model.requests.length, 5)
  assert.equal(agent.budget.decisionCalls, 0)
  assert.equal(agent.budget.remaining, Infinity)
  await agent.enqueue('Different task')
  await agent.wait()
  assert.equal(agent.status, 'idle')
})

test('steering replaces a pending review before the next step and cancellation settles before review', async t => {
  const script = [0, 1].map(index => response([call('list_files', {}, `list-${index}`)], 'toolUse'))
  script.push(async () => {
    await agent.enqueue('Change direction and inspect the new requirement')
    return response([call('list_files', {}, 'list-2')], 'toolUse')
  }, request => {
    assert.ok(request.messages.every(message => !JSON.stringify(message).includes('Harness progress review')))
    assert.match(request.messages.at(-1).content, /Change direction/)
    return response('Updated findings')
  })
  const state = await agentFixture(t, script)
  const { agent } = state
  await agent.enqueue('Inspect repeatedly')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(state.session.events.filter(event => event.type === 'progress.review').length, 1)
  const cancelled = await agentFixture(t, [0, 1, 2].map(index => response([call('list_files', {}, `list-${index}`)], 'toolUse')))
  cancelled.agent.emit = event => { if (event.type === 'progress.review') cancelled.agent.interrupt() }
  await cancelled.agent.enqueue('Inspect until interrupted')
  await cancelled.agent.wait()
  assert.equal(cancelled.agent.status, 'interrupted')
  assert.equal(cancelled.model.requests.length, 3)
  assert.equal(cancelled.session.events.filter(event => event.type === 'tool.finished').length, 3)
  assert.equal(cancelled.session.events.some(event => event.type === 'task.finished'), false)
})
