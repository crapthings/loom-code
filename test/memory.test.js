import test from 'node:test'
import assert from 'node:assert/strict'
import { access, writeFile, readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MemoryStore } from '../src/storage/memory.js'
import { memoryTools } from '../src/tools/memory.js'
import { Dispatcher } from '../src/tools/dispatcher.js'
import { fixture, call, response, agentFixture } from './helpers.js'

// memoryFixture creates durable user evidence and an independently closable memory worker.
async function memoryFixture (t) {
  const state = await fixture(t)
  await state.session.append('inbox.delivered', { message: { role: 'user', content: 'Remember: use pnpm and Standard Style', timestamp: 1 } })
  return { ...state, memory: new MemoryStore(state.cwd), args: { operationId: 'save-1', text: 'Use pnpm and Standard Style', kind: 'convention', sources: [{ sessionId: state.session.id, seq: 1 }] } }
}

test('memory persists independently, preserves revisions, and deduplicates exact mutation receipts', async t => {
  const { cwd, memory, args } = await memoryFixture(t)
  let reopened
  try {
    const saved = await memory.request('save', args)
    assert.equal(saved.revision, 1)
    const retry = await memory.request('save', args)
    assert.equal(retry.id, saved.id)
    assert.equal(retry.reused, true)
    await assert.rejects(memory.request('save', { ...args, text: 'different' }), /different arguments/)
    await memory.close()
    reopened = new MemoryStore(cwd)
    assert.equal((await reopened.request('get', { id: saved.id })).sources[0].state, 'available')
    const next = await reopened.request('save', { ...args, operationId: 'update-1', id: saved.id, expectedRevision: 1, text: 'Use pnpm' })
    assert.equal(next.revision, 2)
    await assert.rejects(reopened.request('save', { ...args, operationId: 'conflict', id: saved.id, expectedRevision: 1 }), /revision conflict/)
    assert.equal((await reopened.request('get', { id: saved.id, revision: 1 })).text, args.text)
    await reopened.request('invalidate', { operationId: 'archive', id: saved.id, expectedRevision: 2, status: 'archived', reason: 'User removed this convention' })
    assert.equal((await reopened.request('list', {})).records.length, 0)
    assert.equal((await reopened.request('list', { includeInactive: true })).records[0].revision, 3)
  } finally { await memory.close(); await reopened?.close() }
})

test('path scope, expiration, and changed original evidence limit applicability', async t => {
  const { memory, session, args } = await memoryFixture(t)
  try {
    const saved = await memory.request('save', { ...args, scope: 'path', path: 'src/tools', expiresAt: Date.now() + 60000 })
    assert.equal((await memory.request('list', { file: 'src/tools/memory.js' })).records.length, 1)
    assert.equal((await memory.request('list', { file: 'src/core/agent.js' })).records.length, 0)
    await assert.rejects(memory.request('save', { ...args, operationId: 'escape', scope: 'path', path: '../other' }), /normalized relative/)
    const file = path.join(session.directory, 'events.jsonl')
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
    lines[1].message.content = 'Changed instruction'
    await writeFile(file, lines.map(JSON.stringify).join('\n') + '\n')
    const recalled = await memory.request('get', { id: saved.id })
    assert.equal(recalled.sources[0].state, 'changed')
    assert.equal(recalled.status, 'stale')
    assert.equal(recalled.storedStatus, 'active')
  } finally { await memory.close() }
})

test('memory rejects model claims, recalled copies, cancelled effects and foreign source paths', async t => {
  const { memory, session, args } = await memoryFixture(t)
  try {
    await session.append('message', { message: response('Invented fact') })
    await session.append('tool.finished', { status: 'completed', message: { role: 'toolResult', toolName: 'read_history', content: 'copy', isError: false } })
    await session.append('tool.finished', { status: 'cancelled', message: { role: 'toolResult', toolName: 'read_file', content: 'partial', isError: false } })
    for (const seq of [2, 3, 4]) await assert.rejects(memory.request('save', { ...args, operationId: `bad-${seq}`, sources: [{ sessionId: session.id, seq }] }), /original user input/)
    await assert.rejects(memory.request('save', { ...args, operationId: 'foreign', sources: [{ sessionId: '../escape', seq: 1 }] }), /Invalid history/)
  } finally { await memory.close() }
})

test('dispatcher controls memory writes, journals intent, and child agents have no memory access', async t => {
  const { cwd, session, memory, args } = await memoryFixture(t)
  try {
    const tools = memoryTools({ session, memory })
    const dispatcher = new Dispatcher({ session, tools, mode: 'ask' })
    const input = { text: args.text, sources: [{ seq: 1 }] }
    assert.equal((await dispatcher.run(call('remember', input, 'denied'), new AbortController().signal)).isError, true)
    await assert.rejects(access(path.join(cwd, '.loom', 'memory.sqlite')), /ENOENT/)
    dispatcher.mode = 'edit'
    const result = await dispatcher.run(call('remember', input, 'allowed'), new AbortController().signal)
    assert.equal(result.isError, false)
    const saved = JSON.parse(result.content[0].text)
    assert.equal(saved.revision, 1)
    assert.equal(session.events.find(event => event.type === 'tool.started').call.id, 'allowed')
    dispatcher.mode = 'plan'
    assert.equal(dispatcher.declarations.some(tool => tool.name === 'remember'), false)
    assert.equal((await dispatcher.run(call('forget_memory', { id: saved.id, expectedRevision: 1, status: 'archived', reason: 'test' }, 'plan-denied'), new AbortController().signal)).isError, true)
  } finally { await memory.close() }
  const { agent } = await agentFixture(t, [], { depth: 1 })
  assert.equal(agent.memory, null)
  assert.equal(agent.dispatcher.tools.some(tool => tool.name === 'get_memory'), false)
})

test('empty reads do not create memory and corrupt or redirected databases are never rebuilt', async t => {
  const { cwd, memory } = await memoryFixture(t)
  try {
    assert.deepEqual((await memory.request('list', {})).records, [])
    const file = path.join(cwd, '.loom', 'memory.sqlite')
    await assert.rejects(access(file), /ENOENT/)
    await writeFile(file, 'authoritative corrupt bytes')
    await assert.rejects(memory.request('list', {}), /database/)
    assert.equal(await readFile(file, 'utf8'), 'authoritative corrupt bytes')
  } finally { await memory.close() }
  const other = await memoryFixture(t)
  try {
    await symlink(path.join(other.cwd, 'outside'), path.join(other.cwd, '.loom', 'memory.sqlite'))
    await assert.rejects(other.memory.request('save', other.args), /regular/)
  } finally { await other.memory.close() }
})

test('manual memory inspection uses the dispatcher without a model request', async t => {
  const { agent, model, session } = await agentFixture(t, [])
  try {
    assert.deepEqual(JSON.parse(await agent.inspectMemories()).records, [])
    assert.equal(model.requests.length, 0)
    assert.equal(session.events.findLast(event => event.type === 'tool.finished').source, 'control')
  } finally { await agent.close() }
})

test('expiration hides active memories and concurrent updates cannot overwrite each other', async t => {
  const { cwd, memory, args } = await memoryFixture(t)
  const other = new MemoryStore(cwd)
  try {
    const expiresAt = Date.now() + 1000
    const saved = await memory.request('save', { ...args, expiresAt })
    await delay(Math.max(1, expiresAt - Date.now() + 10))
    assert.equal((await memory.request('list', {})).records.length, 0)
    assert.equal((await memory.request('get', { id: saved.id })).status, 'stale')
    assert.equal((await memory.request('list', { includeInactive: true })).records.length, 1)
    const updates = await Promise.allSettled([memory, other].map((store, index) => store.request('save', { ...args, operationId: `concurrent-${index}`, id: saved.id, expectedRevision: 1, text: `Replacement ${index}` })))
    assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1)
    assert.match(updates.find(result => result.status === 'rejected').reason.message, /revision conflict|locked/)
    assert.equal((await memory.request('get', { id: saved.id })).revisionCount, 2)
  } finally { await memory.close(); await other.close() }
})

test('successful tool evidence can source memory while pre-aborted requests make no database', async t => {
  const { cwd, memory, session, args } = await memoryFixture(t)
  try {
    const controller = new AbortController()
    controller.abort(new Error('Cancelled before effect'))
    await assert.rejects(memory.request('save', args, { signal: controller.signal }), /Cancelled before effect/)
    await assert.rejects(access(path.join(cwd, '.loom', 'memory.sqlite')), /ENOENT/)
    await session.append('tool.finished', { status: 'completed', executed: true, message: { role: 'toolResult', toolName: 'read_file', content: [{ type: 'text', text: 'packageManager: pnpm' }], isError: false } })
    const saved = await memory.request('save', { ...args, sources: [{ sessionId: session.id, seq: 2 }] })
    assert.equal(saved.sources[0].role, 'toolResult')
  } finally { await memory.close() }
})
