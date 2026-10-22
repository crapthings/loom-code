import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { WorkspaceObserver } from '../src/tools/workspace.js'
import { Dispatcher } from '../src/tools/dispatcher.js'
import { fixture, call } from './helpers.js'

test('workspace observations detect shell changes and deletion without reading protected or linked files', async t => {
  const { cwd } = await fixture(t)
  await writeFile(path.join(cwd, 'app.js'), 'before')
  await writeFile(path.join(cwd, 'remove.js'), 'delete me')
  await writeFile(path.join(cwd, '.env'), 'secret')
  await symlink(path.join(cwd, '.env'), path.join(cwd, 'linked.js'))
  await mkdir(path.join(cwd, 'node_modules'))
  await writeFile(path.join(cwd, 'node_modules', 'large.js'), 'ignored')
  const observer = new WorkspaceObserver(cwd, { milliseconds: 5000 })
  const before = await observer.capture()
  assert.deepEqual([...before.files.keys()].sort(), ['app.js', 'remove.js'])
  await writeFile(path.join(cwd, 'app.js'), 'after')
  await writeFile(path.join(cwd, 'new.js'), 'created')
  await unlink(path.join(cwd, 'remove.js'))
  const changes = observer.compare(before, await observer.capture())
  assert.equal(changes.count, 3)
  assert.equal(changes.files.find(file => file.path === 'remove.js').after, null)
  assert.equal(changes.files.find(file => file.path === 'new.js').before, null)
  assert.match(changes.attribution, /do not prove correctness/)
  const limited = await new WorkspaceObserver(cwd, { files: 0 }).capture()
  assert.equal(limited.omitted.limited, true)
  assert.equal(observer.compare(limited, before).count, 0)
})

test('dispatcher observes partial mutations after failure and never snapshots a denied call', async t => {
  const { cwd, session } = await fixture(t)
  let captures = 0
  const observer = new WorkspaceObserver(cwd, { milliseconds: 5000 })
  const capture = observer.capture.bind(observer)
  observer.capture = () => { captures++; return capture() }
  const tool = { name: 'shell', description: 'Fake shell', effect: 'shell', parameters: Type.Object({}), execute: async () => { await writeFile(path.join(cwd, 'partial.js'), 'partial'); throw new Error('Failed after write') } }
  const dispatcher = new Dispatcher({ session, tools: [tool], mode: 'ask', observer })
  await dispatcher.run(call('shell', {}, 'denied'), new AbortController().signal)
  assert.equal(captures, 0)
  dispatcher.mode = 'auto'
  const result = await dispatcher.run(call('shell', {}, 'failed'), new AbortController().signal)
  assert.equal(result.isError, true)
  const finished = session.latestEvent('tool.finished')
  assert.equal(finished.status, 'failed')
  assert.equal(finished.changes.count, 1)
  assert.equal(finished.changes.files[0].path, 'partial.js')
  assert.equal(session.events.filter(event => event.type === 'tool.started').length, 1)
})

test('observation failure cannot prevent execution or leave a dispatched call unsettled', async t => {
  const { cwd, session } = await fixture(t)
  const tool = { name: 'shell', description: 'Fake shell', effect: 'shell', parameters: Type.Object({}), execute: async () => { await writeFile(path.join(cwd, 'result.js'), 'saved'); return 'Saved' } }
  const dispatcher = new Dispatcher({ session, tools: [tool], mode: 'auto', observer: { capture: async () => { throw new Error('Observation unavailable') } } })
  await dispatcher.run(call('shell'), new AbortController().signal)
  const finished = session.latestEvent('tool.finished')
  assert.equal(finished.status, 'completed')
  assert.equal(finished.changes.unavailable, true)
  assert.equal(session.events.filter(event => event.type === 'tool.started').length, 1)
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 1)
})
