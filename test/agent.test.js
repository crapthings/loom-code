import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Agent } from '../src/core/agent.js'
import { Session } from '../src/core/session.js'
import { Budget } from '../src/core/budget.js'
import { discoverSkills, skillTool } from '../src/core/skills.js'
import { compactContext, contextMessages } from '../src/core/context.js'
import { agentFixture, call, deferred, fakeModel, fixture, response } from './helpers.js'

test('agent executes tools and feeds paired results into the next model step', async t => {
  const { agent, session, model } = await agentFixture(t, [response([call('list_files')], 'toolUse'), response('Verified')])
  await agent.enqueue('Inspect workspace')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 2)
  assert.equal(model.requests[1].messages.at(-1).toolCallId, 'call-1')
  assert.equal(session.pending.length, 0)
  assert.equal(session.events.filter(event => event.type === 'run.finished').length, 1)
})

test('continue on fresh or reopened completed sessions never starts a model call or adds input', async t => {
  const { cwd, session, agent, model, events } = await agentFixture(t, [response('Completed')])
  const before = session.events.length
  assert.equal(await agent.resume(), false)
  assert.equal(session.events.length, before)
  assert.equal(model.requests.length, 0)
  assert.equal(events.at(-1).type, 'resume.skipped')
  await agent.enqueue('Original task')
  await agent.wait()
  await agent.close()
  const reopened = await Session.open(cwd, session.id)
  const nextModel = fakeModel([])
  const next = new Agent({ cwd, session: reopened, model: nextModel })
  t.after(() => next.close())
  await next.initialize()
  const count = reopened.events.length
  assert.equal(reopened.unfinished, false)
  assert.equal(await next.resume(), false)
  assert.equal(reopened.events.length, count)
  assert.equal(nextModel.requests.length, 0)
  await next.close()
})

test('restart resumes failed work once with prior tool evidence before queued tasks', async t => {
  const { cwd, session, agent, model } = await agentFixture(t, [response([call('list_files')], 'toolUse'), () => { throw new Error('Disconnected') }])
  await agent.enqueue('Inspect original task')
  await agent.wait()
  assert.equal(session.unfinished, true)
  assert.equal(model.requests.length, 2)
  await session.append('inbox.enqueued', { inputId: 'future', text: 'Next task', delivery: 'queue' })
  await agent.close()
  const reopened = await Session.open(cwd, session.id)
  const nextModel = fakeModel([response('Original finished'), response('Next finished')])
  const next = new Agent({ cwd, session: reopened, model: nextModel })
  t.after(() => next.close())
  await next.initialize()
  assert.equal(nextModel.requests.length, 0)
  await Promise.all([next.resume(), next.resume()])
  await next.wait()
  assert.equal(nextModel.requests.length, 2)
  assert.ok(nextModel.requests[0].messages.some(message => message.role === 'toolResult' && message.toolCallId === 'call-1'))
  assert.ok(!nextModel.requests[0].messages.some(message => message.content === 'Next task'))
  assert.ok(nextModel.requests[1].messages.some(message => message.content === 'Next task'))
  assert.equal(reopened.events.filter(event => event.type === 'inbox.enqueued' && event.text.startsWith('Continue only')).length, 1)
  assert.equal(reopened.events.filter(event => event.type === 'tool.started').length, 1)
  assert.equal(reopened.unfinished, false)
  assert.equal(await next.resume(), false)
  await next.close()
})

test('continue delivers saved inputs without fabricating an original task', async t => {
  const { agent, session, model } = await agentFixture(t, [response('Saved task completed')])
  await session.append('inbox.enqueued', { inputId: 'saved', text: 'Saved task', delivery: 'queue' })
  assert.equal(await agent.resume(), true)
  await agent.wait()
  assert.equal(model.requests.length, 1)
  assert.deepEqual(model.requests[0].messages.map(message => message.content), ['Saved task'])
  assert.equal(session.pending.length, 0)
})

test('crashed runs remain resumable after recovery without replaying their delivered input', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('run.started', { runId: 'crashed' })
  await session.append('inbox.enqueued', { inputId: 'original', text: 'Original task', delivery: 'steer' })
  await session.append('inbox.delivered', { inputId: 'original', message: { role: 'user', content: 'Original task', timestamp: 1 } })
  await session.close()
  const reopened = await Session.open(cwd, session.id)
  const model = fakeModel([response('Finished remaining work')])
  const agent = new Agent({ cwd, session: reopened, model })
  t.after(() => agent.close())
  await agent.initialize()
  assert.equal(reopened.unfinished, true)
  assert.equal(model.requests.length, 0)
  await agent.resume()
  await agent.wait()
  assert.equal(model.requests[0].messages.filter(message => message.content === 'Original task').length, 1)
  assert.match(model.requests[0].messages.at(-1).content, /do not repeat successful tool calls/)
  assert.equal(reopened.unfinished, false)
  await agent.close()
})

test('ask mode exposes file writing and completes an approved artifact request through the agent', async t => {
  let approvals = 0
  const content = '霓虹灯照着雨夜。\n'
  const { agent, cwd, model } = await agentFixture(t, [response([call('write_file', { path: 'cyberpunk.txt', content })], 'toolUse'), response('Saved cyberpunk.txt')], {
    mode: 'ask',
    approve: async request => { approvals++; assert.equal(request.effect, 'write'); assert.equal(request.call.name, 'write_file'); return true }
  })
  await agent.enqueue('写一个故事，保存为 txt')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(approvals, 1)
  assert.equal(await readFile(path.join(cwd, 'cyberpunk.txt'), 'utf8'), content)
  assert.ok(model.requests[0].tools.some(tool => tool.name === 'write_file'))
  assert.match(model.requests[0].system, /call the appropriate tool to request approval/)
  assert.match(model.requests[1].messages.at(-1).content[0].text, /Saved cyberpunk.txt/)
})

test('ask mode preserves an approval denial without creating the requested file', async t => {
  const { agent, cwd, model, session } = await agentFixture(t, [response([call('write_file', { path: 'denied.txt', content: 'Story' })], 'toolUse'), response('Write denied')], { mode: 'ask', approve: async () => false })
  await agent.enqueue('Save a story')
  await agent.wait()
  await assert.rejects(readFile(path.join(cwd, 'denied.txt')), { code: 'ENOENT' })
  assert.equal(model.requests[1].messages.at(-1).isError, true)
  assert.equal(session.events.some(event => event.type === 'tool.started'), false)
})

test('auto mode executes file and shell tools without approval and still confines file paths', async t => {
  const { agent, cwd, session } = await agentFixture(t, [response([call('write_file', { path: 'automatic.txt', content: 'done' }), call('shell', { command: 'node -e "console.log(123)"' }, 'shell-auto')], 'toolUse'), response('Done')], {
    mode: 'auto', approve: async () => { throw new Error('Auto mode must not prompt') }
  })
  await agent.enqueue('Create and verify a file')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(await readFile(path.join(cwd, 'automatic.txt'), 'utf8'), 'done')
  assert.equal(session.events.some(event => event.type === 'permission.decided'), false)
  const shellResult = session.events.find(event => event.type === 'tool.finished' && event.message?.toolCallId === 'shell-auto')
  assert.equal(shellResult.message.isError, false, JSON.stringify(shellResult.message.content))
  assert.match(shellResult.message.content[0].text, /123/)
  const denied = await agent.dispatcher.run(call('write_file', { path: '../escape.txt', content: 'bad' }), new AbortController().signal)
  assert.equal(denied.isError, true)
})

test('permission switches refuse active work and delegated agents cannot raise permissions', async t => {
  const gate = deferred()
  const entered = deferred()
  const { agent } = await agentFixture(t, [async () => { entered.resolve(); await gate.promise; return response('Done') }])
  await agent.enqueue('Wait')
  await entered.promise
  try { await assert.rejects(agent.setMode('auto'), /Interrupt or wait/) } finally { gate.resolve() }
  await agent.wait()
  assert.equal(agent.mode, 'ask')
  const child = await agentFixture(t, [], { depth: 1, mode: 'plan' })
  await assert.rejects(child.agent.setMode('auto'), /Delegated agents/)
  assert.equal(child.agent.mode, 'plan')
})

test('steering input reaches the next safe boundary while queued work waits until idle', async t => {
  const gate = deferred()
  const entered = deferred()
  const { agent, model } = await agentFixture(t, [
    async () => { entered.resolve(); await gate.promise; return response([call('list_files')], 'toolUse') },
    response('First task done'), response('Queued task done')
  ])
  await agent.enqueue('First task')
  await entered.promise
  await agent.enqueue('Second task', 'queue')
  await agent.enqueue('Correction to first task', 'steer')
  gate.resolve()
  await agent.wait()
  const second = model.requests[1].messages.filter(message => message.role === 'user').map(message => message.content)
  assert.deepEqual(second, ['First task', 'Correction to first task'])
  assert.equal(model.requests[2].messages.at(-1).content, 'Second task')
})

test('late input admitted during settlement starts a successor rather than getting stranded', async t => {
  const { agent, session, model } = await agentFixture(t, [response('One'), response('Two')])
  let late
  session.on('event', event => {
    if (event.type === 'run.finished' && !late) late = agent.enqueue('Late input')
  })
  await agent.enqueue('First input')
  await agent.wait()
  await late
  await agent.wait()
  assert.equal(model.requests.length, 2)
  assert.equal(session.pending.length, 0)
})

test('budget exhaustion stops a tool loop instead of resetting after every step', async t => {
  const { agent, session } = await agentFixture(t, [response([call('list_files')], 'toolUse')], { steps: 1 })
  await agent.enqueue('Keep investigating')
  await agent.wait()
  assert.equal(agent.status, 'failed')
  assert.match(session.events.findLast(event => event.type === 'run.finished').error, /budget exhausted/)
})

test('interruption cancels model work and preserves queued next-task input', async t => {
  const started = deferred()
  const { agent, session } = await agentFixture(t, [async (_, { signal }) => {
    started.resolve()
    await delay(60000, undefined, { signal })
    return response()
  }])
  await agent.enqueue('Active')
  await started.promise
  await agent.enqueue('Future task', 'queue')
  agent.interrupt()
  await agent.wait()
  assert.equal(agent.status, 'interrupted')
  assert.deepEqual(session.pending.map(input => input.text), ['Future task'])
})

test('delegated research has its own session, read-only tools, no recursion, and a shared budget', async t => {
  const { agent, session, model } = await agentFixture(t, [
    response([call('delegate', { role: 'review', task: 'Inspect the design' })], 'toolUse'),
    response('Child findings'), response('Parent conclusion')
  ])
  await agent.enqueue('Review')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(agent.budget.calls, 3)
  assert.ok(model.requests[1].tools.every(tool => !['shell', 'write_file', 'edit_file', 'delegate'].includes(tool.name)))
  assert.equal(session.events.filter(event => event.type === 'agent.spawned').length, 1)
  assert.match(model.requests[2].messages.at(-1).content[0].text, /Child findings/)
})

test('manual compaction preserves raw history and complete recent call-result pairs', async t => {
  const { session } = await fixture(t)
  for (let index = 0; index < 5; index++) {
    await session.append('message', { message: { role: 'user', content: `Task ${index}`, timestamp: 1 } })
    await session.append('message', { message: response([call('list_files', {}, `tool-${index}`)], 'toolUse') })
    await session.append('message', { message: { role: 'toolResult', toolCallId: `tool-${index}`, toolName: 'list_files', content: [{ type: 'text', text: 'evidence' }], timestamp: 1 } })
  }
  const count = session.messages.length
  const model = fakeModel([response('Objective: preserve corrections; evidence: file listing')])
  const compacted = await compactContext({ session, model, system: 'test', tools: [], budget: new Budget(), signal: new AbortController().signal, emit: () => {}, force: true })
  assert.equal(compacted, true)
  assert.equal(session.messages.length, count)
  const context = contextMessages(session)
  assert.ok(context.length < count)
  const calls = new Set(context.filter(message => message.role === 'assistant').flatMap(message => message.content.filter(part => part.type === 'toolCall').map(part => part.id)))
  assert.ok(context.filter(message => message.role === 'toolResult').every(message => calls.has(message.toolCallId)))
  assert.match(context[0].content, /preserve corrections/)
})

test('failed compaction never replaces the original context', async t => {
  const { session } = await fixture(t)
  for (const content of ['old', 'new']) await session.append('message', { message: { role: 'user', content, timestamp: 1 } })
  const model = fakeModel([response('incomplete', 'length')])
  const budget = new Budget()
  await assert.rejects(compactContext({ session, model, system: '', tools: [], budget, signal: new AbortController().signal, emit: () => {}, force: true }), /did not complete/)
  assert.equal(budget.calls, 1)
  assert.equal(budget.tokens, 10)
  assert.equal(contextMessages(session).length, 2)
})

test('manual synchronous failures settle ownership and allow subsequent work', async t => {
  const { agent, model, events } = await agentFixture(t, [response('Recovered')])
  const failure = 'Synchronous operation failed'
  await assert.rejects(agent.manual('testing', () => { throw failure }), error => error === failure)
  await agent.wait()
  assert.equal(agent.status, 'failed')
  assert.equal(agent.controller, null)
  assert.equal(agent.running, null)
  assert.ok(events.some(event => event.type === 'error' && event.text === failure))
  await agent.enqueue('New task')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 1)
})

test('immediate close cancels an admitted manual action before its effects start', async t => {
  const { agent } = await agentFixture(t, [])
  let executed = false
  const operation = agent.manual('testing', () => { executed = true })
  const rejected = assert.rejects(operation, /Interrupted/)
  await agent.close()
  await rejected
  assert.equal(executed, false)
  assert.equal(agent.status, 'interrupted')
  assert.equal(agent.controller, null)
  assert.equal(agent.running, null)
})

test('cancelled compaction discards a late successful response but accounts for its usage', async t => {
  const entered = deferred()
  const release = deferred()
  const { agent, session } = await agentFixture(t, [async () => {
    entered.resolve()
    await release.promise
    return response('Late summary')
  }])
  for (const content of ['older', 'recent']) await session.append('message', { message: { role: 'user', content, timestamp: 1 } })
  const before = contextMessages(session)
  const operation = agent.compact()
  await entered.promise
  agent.interrupt()
  release.resolve()
  await assert.rejects(operation, /Interrupted/)
  await agent.wait()
  assert.equal(agent.status, 'interrupted')
  assert.equal(agent.budget.tokens, 10)
  assert.deepEqual(contextMessages(session), before)
  assert.equal(session.events.some(event => event.type === 'context.compacted'), false)
})

test('truncated provider output fails calls even when their arguments parse', async t => {
  const { agent, session } = await agentFixture(t, [response([call('list_files')], 'length')])
  await agent.enqueue('Inspect')
  await agent.wait()
  assert.equal(agent.status, 'failed')
  assert.equal(session.events.some(event => event.type === 'tool.started'), false)
  assert.match(session.messages.at(-1).content[0].text, /truncated/)
})

test('unknown recovered effects block execution until an explicit resume', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('message', { message: response([call('shell', { command: 'deploy' })], 'toolUse') })
  await session.append('tool.started', { call: call('shell', { command: 'deploy' }) })
  const model = fakeModel([response('Inspected unknown outcome')])
  const agent = new Agent({ cwd, session, model })
  await agent.initialize()
  await agent.enqueue('Inspect, then continue')
  assert.equal(agent.running, null)
  assert.equal(model.requests.length, 0)
  await agent.resume()
  await agent.wait()
  assert.equal(model.requests.length, 1)
  assert.equal(agent.blocked, false)
})

test('skills load descriptions first and full instructions only through an authorized read tool', async t => {
  const { cwd, session } = await fixture(t)
  const directory = path.join(cwd, '.agents', 'skills', 'review')
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, 'SKILL.md'), '---\nname: review\ndescription: Review code quality\n---\nDetailed private workflow instructions')
  const model = fakeModel([response([call('load_skill', { name: 'review' })], 'toolUse'), response('Reviewed')])
  const agent = new Agent({ cwd, session, model })
  await agent.initialize()
  assert.match(agent.system, /Review code quality/)
  assert.doesNotMatch(agent.system, /Detailed private/)
  await agent.enqueue('Review')
  await agent.wait()
  assert.match(model.requests[1].messages.at(-1).content[0].text, /Detailed private/)
})

test('skill discovery skips oversized instructions and loading enforces the same byte limit', async t => {
  const { cwd } = await fixture(t)
  const root = path.join(cwd, '.agents', 'skills')
  for (const name of ['valid', 'oversized']) await mkdir(path.join(root, name), { recursive: true })
  await writeFile(path.join(root, 'valid', 'SKILL.md'), '---\ndescription: Valid workflow\n---\nInstructions')
  await writeFile(path.join(root, 'oversized', 'SKILL.md'), 'x'.repeat(32001))
  const skills = await discoverSkills(cwd)
  assert.deepEqual(skills.map(skill => skill.name), ['valid'])
  await writeFile(skills[0].file, '你'.repeat(11000))
  await assert.rejects(skillTool(skills).execute({ name: 'valid' }), { code: 'LOOM_TEXT_LIMIT' })
})

test('manual compaction participates in cancellation and session ownership', async t => {
  const entered = deferred()
  const { agent, session } = await agentFixture(t, [async (_, { signal }) => {
    entered.resolve()
    await delay(60000, undefined, { signal })
    return response('Summary')
  }])
  for (const content of ['older', 'recent']) await session.append('message', { message: { role: 'user', content, timestamp: 1 } })
  const operation = agent.compact()
  await entered.promise
  assert.ok(agent.running)
  agent.interrupt()
  await assert.rejects(operation, /abort/i)
  await agent.wait()
  assert.equal(agent.status, 'interrupted')
  assert.equal(session.events.some(event => event.type === 'context.compacted'), false)
})

test('manual undo updates model context without introducing an orphan tool result', async t => {
  const { agent, session, cwd } = await agentFixture(t, [], { mode: 'edit' })
  await agent.dispatcher.run(call('write_file', { path: 'a.txt', content: 'created' }), new AbortController().signal, false, 'control')
  await agent.undo()
  await agent.wait()
  await assert.rejects(readFile(path.join(cwd, 'a.txt')), /ENOENT/)
  assert.ok(session.messages.every(message => message.role === 'user'))
  assert.match(session.messages.at(-1).content, /Restored/)
})
