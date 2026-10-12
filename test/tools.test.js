import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { createTools, Dispatcher } from '../src/tools/dispatcher.js'
import { hashText, resolveFile } from '../src/tools/files.js'
import { latestCheckpoint } from '../src/tools/checkpoints.js'
import { call, deferred, fixture } from './helpers.js'

test('file tools reject escapes, outside symlinks, and protected metadata', async t => {
  const { cwd } = await fixture(t)
  await assert.rejects(resolveFile(cwd, '../outside'), /outside/)
  await assert.rejects(resolveFile(cwd, '.loom/sessions'), /Protected/)
  await symlink(path.dirname(cwd), path.join(cwd, 'outside'))
  await assert.rejects(resolveFile(cwd, 'outside'), /outside/)
})

test('version-checked edits preserve literal replacement text and a before-edit checkpoint', async t => {
  const { cwd, session } = await fixture(t)
  const original = 'const count = 1\n'
  await writeFile(path.join(cwd, 'a.js'), original)
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'edit' })
  const result = await dispatcher.run(call('edit_file', { path: 'a.js', oldText: '1', newText: '$&', expectedHash: hashText(original) }), new AbortController().signal)
  assert.equal(result.isError, false)
  assert.equal(await readFile(path.join(cwd, 'a.js'), 'utf8'), 'const count = $&\n')
  const checkpoint = session.events.find(event => event.type === 'file.checkpoint')
  const saved = JSON.parse(await readFile(path.join(session.directory, 'checkpoints', `${checkpoint.checkpoint}.json`), 'utf8'))
  assert.equal(saved.previous, original)
  const stale = await dispatcher.run(call('write_file', { path: 'a.js', content: 'bad', expectedHash: hashText(original) }, 'stale'), new AbortController().signal)
  assert.equal(stale.isError, true)
  assert.match(stale.content[0].text, /changed/)
})

test('plan mode denies mutations even if the provider calls an invisible tool', async t => {
  const { cwd, session } = await fixture(t)
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'plan', approve: async () => true })
  assert.equal(dispatcher.declarations.some(tool => tool.name === 'write_file'), false)
  const result = await dispatcher.run(call('write_file', { path: 'a', content: 'bad' }), new AbortController().signal)
  assert.match(result.content[0].text, /Plan mode/)
  assert.equal(session.events.some(event => event.type === 'tool.started'), false)
})

test('truncated calls and invalid schemas never reach execution', async t => {
  const { session } = await fixture(t)
  let executions = 0
  const tools = [{ name: 'danger', parameters: Type.Object({ number: Type.Integer() }), effect: 'read', parallel: false, execute: async () => { executions++; return 'ok' } }]
  const dispatcher = new Dispatcher({ session, tools })
  const signal = new AbortController().signal
  assert.equal((await dispatcher.run(call('danger', { number: 'bad' }), signal)).isError, true)
  assert.equal((await dispatcher.run(call('danger', { number: 1 }, 'truncated'), signal, true)).isError, true)
  assert.equal(executions, 0)
})

test('shell requires approval even in edit mode and returns bounded output with an artifact', async t => {
  const { cwd, session } = await fixture(t)
  let approvals = 0
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'edit', approve: async () => { approvals++; return true } })
  const result = await dispatcher.run(call('shell', { command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"' }), new AbortController().signal)
  assert.equal(approvals, 1)
  assert.equal(result.isError, false)
  assert.ok(result.content[0].text.length < 14000)
  const artifact = result.content[0].text.match(/artifact: ([a-f0-9-]+\.txt)/)[1]
  assert.equal((await readFile(path.join(session.directory, artifact), 'utf8')).length, 20000)
  assert.equal(session.events.find(event => event.type === 'tool.finished').message.toolCallId, 'call-1')
})

test('cancellation settles every call in a sequential batch and kills a running shell', async t => {
  const { cwd, session } = await fixture(t)
  const controller = new AbortController()
  const started = deferred()
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), approve: async () => true, emit: event => { if (event.type === 'tool.progress') started.resolve() } })
  const pending = dispatcher.batch([call('shell', { command: 'sleep 60' }), call('list_files', {}, 'second')], controller.signal)
  await started.promise
  controller.abort()
  const results = await pending
  assert.equal(results.length, 2)
  assert.ok(results.every(result => result.isError))
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 2)
})

test('literal search works without leaking metadata or following symlinks', async t => {
  const { cwd, session } = await fixture(t)
  await writeFile(path.join(cwd, 'hello.js'), 'first\nneedle\nlast')
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'plan' })
  const result = await dispatcher.run(call('search', { query: 'needle' }), new AbortController().signal)
  assert.equal(result.isError, false)
  assert.match(result.content[0].text, /hello.js:2: needle/)
})

test('restoring checkpoints walks edit history without overwriting later external changes', async t => {
  const { cwd, session } = await fixture(t)
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'edit' })
  const signal = new AbortController().signal
  await dispatcher.run(call('write_file', { path: 'a.txt', content: 'first' }), signal)
  await dispatcher.run(call('write_file', { path: 'a.txt', content: 'second', expectedHash: hashText('first') }, 'second'), signal)
  const checkpoint = latestCheckpoint(session)
  assert.equal((await dispatcher.run(call('restore_checkpoint', { id: checkpoint.checkpoint }, 'restore'), signal)).isError, false)
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'first')
  const first = latestCheckpoint(session)
  assert.notEqual(first.checkpoint, checkpoint.checkpoint)
  await writeFile(path.join(cwd, 'a.txt'), 'external change')
  const refused = await dispatcher.run(call('restore_checkpoint', { id: first.checkpoint }, 'refused'), signal)
  assert.equal(refused.isError, true)
  assert.equal(await readFile(path.join(cwd, 'a.txt'), 'utf8'), 'external change')
})
