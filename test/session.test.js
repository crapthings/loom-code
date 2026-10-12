import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { Session } from '../src/core/session.js'
import { call, fixture, response } from './helpers.js'

test('inbox delivery and its visible message commit as one durable fact', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('inbox.enqueued', { inputId: 'one', delivery: 'steer', text: 'fix' })
  await session.append('inbox.delivered', { inputId: 'one', message: { role: 'user', content: 'fix', timestamp: 1 } })
  await session.close()
  const resumed = await Session.open(cwd, session.id)
  try {
    assert.equal(resumed.pending.length, 0)
    assert.equal(resumed.messages.length, 1)
  } finally { await resumed.close() }
})

test('another writer cannot open a live session', async t => {
  const { cwd, session } = await fixture(t)
  await assert.rejects(Session.open(cwd, session.id), /already open/)
})

test('a torn final append is removed before adding new records', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('marker', { value: 1 })
  await session.close()
  const file = path.join(session.directory, 'events.jsonl')
  await appendFile(file, '{"type":"torn"')
  const resumed = await Session.open(cwd, session.id)
  await resumed.append('marker', { value: 2 })
  await resumed.close()
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(records.filter(record => record.type === 'marker').map(record => record.value), [1, 2])
})

test('recovery records unknown effects once and waits for explicit acknowledgement', async t => {
  const { session } = await fixture(t)
  const tool = call('shell', { command: 'deploy' })
  await session.append('message', { message: response([tool], 'toolUse') })
  await session.append('tool.started', { call: tool })
  assert.equal(await session.recover(), true)
  assert.equal(await session.recover(), true)
  assert.equal(session.messages.filter(message => message.role === 'toolResult').length, 1)
  assert.equal(session.events.find(event => event.type === 'tool.finished').status, 'unknown')
  await session.append('recovery.acknowledged')
  assert.equal(await session.recover(), false)
})

test('unstarted calls receive a paired result without being replayed', async t => {
  const { session } = await fixture(t)
  await session.append('message', { message: response([call('write_file', { path: 'a' })], 'toolUse') })
  assert.equal(await session.recover(), false)
  assert.match(session.messages.at(-1).content[0].text, /Not executed/)
})

test('session identifiers cannot escape the metadata directory', async t => {
  const { cwd } = await fixture(t)
  await assert.rejects(Session.open(cwd, '../escape'), /Invalid session/)
})

test('metadata directories cannot redirect writes through a workspace symlink', async t => {
  const { cwd } = await fixture(t)
  const nested = path.join(cwd, 'nested')
  await mkdir(nested)
  await symlink(path.join(cwd, '.loom'), path.join(nested, '.loom'))
  await assert.rejects(Session.open(nested), /real directories/)
})

test('a journal write failure prevents all subsequent admissions', async t => {
  const { session } = await fixture(t)
  const sync = session.handle.sync.bind(session.handle)
  session.handle.sync = async () => { throw new Error('Disk sync failed') }
  await assert.rejects(session.append('inbox.enqueued', { inputId: 'one', text: 'Task' }), /Disk sync failed/)
  session.handle.sync = sync
  await assert.rejects(session.append('marker'), /Disk sync failed/)
  assert.equal(session.pending.length, 0)
})
