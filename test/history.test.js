import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile, unlink, symlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { HistoryStore } from '../src/storage/history.js'
import { Session } from '../src/core/session.js'
import { Dispatcher } from '../src/tools/dispatcher.js'
import { historyTools } from '../src/tools/history.js'
import { fixture, response, agentFixture, call } from './helpers.js'

// historyFixture closes the worker before removing its temporary workspace.
async function historyFixture (t) {
  const state = await fixture(t)
  const history = new HistoryStore(state.cwd)
  return { ...state, history }
}

test('SQLite indexes literal Unicode history, reads original evidence, and incrementally follows append', async t => {
  const { cwd, session, history } = await historyFixture(t)
  try {
    await session.append('inbox.delivered', { message: { role: 'user', content: '中文 登录：keep API', timestamp: 1 } })
    const first = await history.request('search', { query: '中文', session: session.id })
    assert.equal(first.results.length, 1)
    assert.equal(first.results[0].seq, 1)
    assert.equal(first.results[0].sessionId, session.id)
    assert.match((await readFile(path.join(cwd, '.loom', 'history.sqlite'))).subarray(0, 16).toString(), /SQLite format/)
    const original = await history.request('read', { session: session.id, seq: first.results[0].seq })
    assert.match(original.text, /keep API/)
    await session.append('message', { message: response('retain API and pnpm') })
    const next = await history.request('search', { query: 'API', session: session.id })
    assert.equal(next.results.length, 2)
    const unchanged = await history.request('search', { query: 'API', session: session.id })
    assert.equal(unchanged.scannedBytes, 0)
    assert.deepEqual(unchanged.results, next.results)
    await session.append('message', { message: response('quote "x" and percent % literal') })
    assert.equal((await history.request('search', { query: '"x"', session: session.id })).results.length, 1)
    assert.equal((await history.request('search', { query: '%', session: session.id })).results.length, 1)
  } finally { await history.close() }
})

test('workspace search excludes child sessions and never reads another project', async t => {
  const { cwd, session, history } = await historyFixture(t)
  const other = await Session.open(cwd, 'other-root')
  const child = await Session.open(cwd, 'child')
  try {
    for (const saved of [session, other, child]) await saved.append('message', { message: response('shared needle') })
    await child.append('session.parent', { parentId: session.id })
    const foreign = path.join(cwd, '.loom', 'sessions', 'foreign')
    await mkdir(foreign)
    const copied = (await readFile(path.join(other.directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    copied[0].cwd = '/other-workspace'
    await writeFile(path.join(foreign, 'events.jsonl'), copied.map(event => JSON.stringify(event)).join('\n') + '\n')
    const result = await history.request('search', { query: 'needle' })
    assert.deepEqual(new Set(result.results.map(row => row.sessionId)), new Set([session.id, other.id]))
    const own = await history.request('search', { query: 'needle', session: child.id })
    assert.equal(own.results.length, 1)
    await assert.rejects(history.request('read', { session: '../escape', seq: 0 }), /Invalid history/)
  } finally { await history.close(); await other.close(); await child.close() }
})

test('edited journals invalidate the indexed prefix and deleting the cache rebuilds it', async t => {
  const { cwd, session, history } = await historyFixture(t)
  try {
    await session.append('message', { message: response('before needle') })
    await history.request('search', { query: 'needle' })
    const file = path.join(session.directory, 'events.jsonl')
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw.replace('before needle', 'after needle'))
    const edited = await history.request('search', { query: 'needle' })
    assert.equal(edited.results.length, 1)
    assert.match(edited.results[0].excerpt, /after needle/)
    await history.close()
    await unlink(path.join(cwd, '.loom', 'history.sqlite'))
    const rebuilt = new HistoryStore(cwd)
    try { assert.equal((await rebuilt.request('search', { query: 'needle' })).results.length, 1) } finally { await rebuilt.close() }
  } finally { await history.close() }
})

test('torn tails stay unrepaired and invalidated sources are removed from search', async t => {
  const { session, history } = await historyFixture(t)
  try {
    await session.append('message', { message: response('durable needle') })
    await history.request('search', { query: 'needle' })
    const file = path.join(session.directory, 'events.jsonl')
    const raw = await readFile(file, 'utf8')
    await writeFile(file, raw + '{torn')
    assert.equal((await history.request('search', { query: 'needle' })).results.length, 1)
    assert.equal(await readFile(file, 'utf8'), raw + '{torn')
    await writeFile(file, raw.replace('"seq":1', '"seq":99'))
    const invalid = await history.request('search', { query: 'needle' })
    assert.equal(invalid.results.length, 0)
    assert.equal(invalid.skipped, 1)
  } finally { await history.close() }
})

test('corrupt or redirected caches fail search while original history remains readable', async t => {
  const { cwd, session, history } = await historyFixture(t)
  try {
    await session.append('message', { message: response('original needle') })
    const file = path.join(cwd, '.loom', 'history.sqlite')
    await writeFile(file, 'corrupt')
    await assert.rejects(history.request('search', { query: 'needle' }), /database/)
    assert.match((await history.request('read', { session: session.id, seq: 1 })).text, /original needle/)
    await unlink(file)
    const target = path.join(cwd, 'untouched.txt')
    await writeFile(target, 'untouched')
    await symlink(target, file)
    await assert.rejects(history.request('search', { query: 'needle' }), /regular/)
    assert.equal(await readFile(target, 'utf8'), 'untouched')
  } finally { await history.close() }
})

test('history tools pass through dispatcher and child recall cannot cross its own session', async t => {
  const { session, history } = await historyFixture(t)
  try {
    await session.append('message', { message: response('original evidence') })
    const dispatcher = new Dispatcher({ session, mode: 'plan', tools: historyTools({ session, history, allowWorkspace: false }) })
    const signal = new AbortController().signal
    const denied = await dispatcher.run(call('search_history', { query: 'evidence', scope: 'workspace' }), signal)
    assert.equal(denied.isError, true)
    const outside = await dispatcher.run(call('read_history', { seq: 0, sessionId: 'other' }, 'outside'), signal)
    assert.equal(outside.isError, true)
    const result = await dispatcher.run(call('read_history', { seq: 1 }, 'recall'), signal)
    assert.equal(result.isError, false)
    assert.match(result.content[0].text, /original evidence/)
    assert.ok(session.events.some(event => event.type === 'tool.finished' && event.callId === 'recall'))
  } finally { await history.close() }
})

test('aborted queries settle and a subsequent query can start a fresh worker', async t => {
  const { cwd, session, history } = await historyFixture(t)
  try {
    const controller = new AbortController()
    const request = history.request('search', { query: 'needle' }, { signal: controller.signal })
    controller.abort(new Error('cancelled'))
    await assert.rejects(request, /cancelled/)
    assert.equal((await history.request('read', { session: session.id, seq: 0 })).seq, 0)
    await history.request('search', { query: 'needle' })
    const { DatabaseSync } = await import('node:sqlite')
    const lock = new DatabaseSync(path.join(cwd, '.loom', 'history.sqlite'))
    lock.exec('BEGIN EXCLUSIVE')
    try {
      await assert.rejects(history.request('search', { query: 'needle' }, { timeoutMs: 30 }), /deadline/)
      await history.stopping
    } finally { lock.exec('ROLLBACK'); lock.close() }
    assert.equal(history.pending.size, 0)
    assert.equal((await history.request('read', { session: session.id, seq: 0 })).seq, 0)
  } finally { await history.close() }
})

test('agent recalls a compacted source without using SQLite as execution authority', async t => {
  const { agent, session, model } = await agentFixture(t, [response([call('read_history', { seq: 1 })], 'toolUse'), response('Recalled')])
  await session.append('inbox.delivered', { message: { role: 'user', content: 'Keep the original API', timestamp: 1 } })
  await session.append('context.compacted', { through: 1, summary: 'Lossy handoff' })
  await agent.enqueue('Recall the original requirement')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.match(model.requests[1].messages.find(message => message.role === 'toolResult').content[0].text, /Keep the original API/)
})

test('metadata session symlinks are skipped without indexing outside evidence', async t => {
  const { cwd, history } = await historyFixture(t)
  try {
    const outside = path.join(cwd, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'events.jsonl'), 'outside needle')
    await symlink(outside, path.join(cwd, '.loom', 'sessions', 'redirect'), 'dir')
    assert.equal((await history.request('search', { query: 'needle' })).results.length, 0)
    await assert.rejects(history.request('read', { session: 'redirect', seq: 0 }), /real directory/)
  } finally { await history.close() }
})

test('paged original records preserve long evidence and search excludes recalled copies', async t => {
  const { session, history } = await historyFixture(t)
  try {
    await session.append('message', { message: response('needle ' + 'x'.repeat(15000)) })
    await session.append('tool.finished', { callId: 'recall', message: { role: 'toolResult', toolName: 'read_history', content: [{ type: 'text', text: 'needle recalled copy' }] } })
    const found = await history.request('search', { query: 'needle', session: session.id })
    assert.equal(found.results.length, 1)
    const first = await history.request('read', { session: session.id, seq: 1 })
    const second = await history.request('read', { session: session.id, seq: 1, offset: first.nextOffset })
    assert.equal(first.truncated, true)
    assert.equal(second.nextOffset, null)
    assert.equal(JSON.parse(first.text + second.text).message.content[0].text.length, 15007)
  } finally { await history.close() }
})

test('history projects visible evidence without private reasoning, provider signatures or nested recall copies', async t => {
  const { session, history } = await historyFixture(t)
  try {
    const source = await session.append('message', { message: response([{ type: 'thinking', thinking: 'PRIVATE_SENTINEL', signature: 'SIGNATURE_SENTINEL' }, { type: 'text', text: 'Public observation' }, call('read_file', { path: 'app.js' })]) })
    const recalled = await history.request('read', { session: session.id, seq: source.seq })
    assert.equal(recalled.projection, 'visible-evidence')
    assert.equal(recalled.historical, true)
    assert.match(recalled.text, /Public observation|read_file/)
    assert.doesNotMatch(recalled.text, /PRIVATE_SENTINEL|SIGNATURE_SENTINEL/)
    const nested = await session.append('tool.finished', { callId: 'recall', message: { role: 'toolResult', toolName: 'read_history', content: [{ type: 'text', text: JSON.stringify({ text: JSON.stringify(source) }) }] } })
    const result = await history.request('read', { session: session.id, seq: nested.seq })
    assert.match(result.text, /Copied recall output omitted/)
    assert.doesNotMatch(result.text, /PRIVATE_SENTINEL|Public observation/)
    assert.equal(session.events[source.seq].message.content[0].thinking, 'PRIVATE_SENTINEL')
  } finally { await history.close() }
})

test('history excludes recall query parameters but retains mixed original text and execution evidence', async t => {
  const { session, history } = await historyFixture(t)
  try {
    for (const name of ['search_history', 'read_history', 'get_memory', 'list_memories', 'remember', 'forget_memory']) {
      await session.append('message', { message: response([call(name, { query: 'recall-only-needle' }, name)], 'toolUse') })
    }
    const original = await session.append('message', {
      message: response([
        { type: 'text', text: 'Original finding: visible blocks' },
        call('search_history', { query: 'recall-only-needle' }, 'recall'),
        call('search', { query: 'catalogue', path: 'node_modules/fiber' }, 'source')
      ], 'toolUse')
    })
    assert.equal((await history.request('search', { query: 'recall-only-needle' })).results.length, 0)
    const found = await history.request('search', { query: 'visible blocks' })
    assert.deepEqual(found.results.map(result => result.seq), [original.seq])
    assert.doesNotMatch(found.results[0].excerpt, /recall-only-needle|search_history/)
    assert.equal((await history.request('search', { query: 'catalogue' })).results[0].seq, original.seq)
    assert.match((await history.request('read', { session: session.id, seq: original.seq })).text, /recall-only-needle/)
  } finally { await history.close() }
})

test('changing extraction rules rebuilds the disposable index without modifying original journals', async t => {
  const { cwd, session, history } = await historyFixture(t)
  await session.append('message', { message: response('original evidence') })
  await session.append('message', { message: response([call('search_history', { query: 'self-reference' })], 'toolUse') })
  await history.request('search', { query: 'evidence' })
  await history.close()
  const journal = await readFile(path.join(session.directory, 'events.jsonl'), 'utf8')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path.join(cwd, '.loom', 'history.sqlite'))
  try {
    db.exec('PRAGMA user_version = 1')
    db.prepare('INSERT INTO history(session, seq, event_id, kind, role, body) VALUES (?, ?, ?, ?, ?, ?)').run(session.id, 2, 'stale', 'message', 'assistant', 'self-reference')
  } finally { db.close() }
  const rebuilt = new HistoryStore(cwd)
  try {
    const first = await rebuilt.request('search', { query: 'self-reference' })
    assert.equal(first.results.length, 0)
    assert.ok(first.scannedBytes > 0)
    assert.equal((await rebuilt.request('search', { query: 'evidence' })).results.length, 1)
    assert.equal(await readFile(path.join(session.directory, 'events.jsonl'), 'utf8'), journal)
  } finally { await rebuilt.close() }
})

test('history can narrow to a discovered session and enforces child isolation for that scope', async t => {
  const { cwd, session, history } = await historyFixture(t)
  const other = await Session.open(cwd, 'earlier-task')
  try {
    await other.append('message', { message: response('target evidence') })
    await session.append('message', { message: response('target evidence in current session') })
    const signal = new AbortController().signal
    const dispatcher = new Dispatcher({ session, mode: 'plan', tools: historyTools({ session, history, allowWorkspace: true }) })
    const result = await dispatcher.run(call('search_history', { query: 'target', sessionId: other.id }), signal)
    const found = JSON.parse(result.content[0].text)
    assert.equal(found.results.length, 1)
    assert.equal(found.results[0].sessionId, other.id)
    const conflicting = await dispatcher.run(call('search_history', { query: 'target', sessionId: other.id, scope: 'workspace' }, 'conflict'), signal)
    assert.equal(conflicting.isError, true)
    const child = new Dispatcher({ session, mode: 'plan', tools: historyTools({ session, history, allowWorkspace: false }) })
    const denied = await child.run(call('search_history', { query: 'target', sessionId: other.id }, 'child'), signal)
    assert.equal(denied.isError, true)
  } finally { await history.close(); await other.close() }
})
