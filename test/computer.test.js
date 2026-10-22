import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CuaComputer } from '../src/execution/cua.js'
import { Dispatcher, createTools } from '../src/tools/dispatcher.js'
import { Agent } from '../src/core/agent.js'
import { Session } from '../src/core/session.js'
import { storeImages, readImage, projectImages, hydrateImages } from '../src/core/images.js'
import { estimateTokens } from '../src/core/context-budget.js'
import { visibleMessage } from '../src/core/evidence.js'
import { parseOptions } from '../src/cli.js'
import { fixture, fakeModel, response, call } from './helpers.js'

// png supplies stable raster bytes for artifact and provider-boundary tests.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII='

// computerFixture starts a real MCP child that records only deterministic fake desktop actions in a temporary workspace.
async function computerFixture (t, options = {}) {
  const base = await fixture(t)
  const audit = path.join(base.cwd, 'driver.jsonl')
  const computer = new CuaComputer({ command: process.execPath, args: [fileURLToPath(new URL('./fixtures/fake-cua.js', import.meta.url)), audit], ...options })
  t.after(() => computer.close())
  return { ...base, computer, audit, requests: async () => (await readFile(audit, 'utf8')).trim().split('\n').map(JSON.parse) }
}

test('computer access is explicit and executable overrides cannot silently enable it', () => {
  assert.equal(parseOptions([], {}).computer, 'off')
  assert.equal(parseOptions(['--computer', 'cua'], {}).computer, 'cua')
  assert.throws(() => parseOptions(['--computer', 'anything'], {}), /--computer/)
  assert.throws(() => parseOptions(['--cua-driver', '/tmp/driver'], {}), /requires/)
})

test('Cua discovers modern MCP tools, isolates session identity, and journals screenshots before provider delivery', async t => {
  const { cwd, session, computer, requests } = await computerFixture(t)
  const model = fakeModel([response([call('computer_get_window_state', { pid: 42 })], 'toolUse'), response('The screenshot is available; no fix claimed.')])
  model.input = ['text', 'image']
  const agent = new Agent({ cwd, session, model, computer, mode: 'auto' })
  t.after(() => agent.close())
  await agent.initialize()
  assert.ok(!agent.dispatcher.declarations.some(tool => tool.name === 'computer_kill_app'))
  assert.ok(!agent.dispatcher.declarations.find(tool => tool.name === 'computer_get_window_state').parameters.properties.session)
  await agent.enqueue('Observe the application')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  const result = session.latestEvent('tool.finished')
  const image = result.message.content.find(part => part.type === 'image')
  assert.match(image.artifact, /^image-/)
  assert.equal(image.data, undefined)
  assert.ok(!await readFile(path.join(session.directory, 'events.jsonl'), 'utf8').then(text => text.includes(png)))
  const supplied = model.requests[1].messages.find(message => message.role === 'toolResult').content.find(part => part.type === 'image')
  assert.equal(supplied.data, png)
  assert.equal(supplied.mimeType, 'image/png')
  const sent = await requests()
  assert.ok(sent.every(request => request.params?._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'))
  assert.equal(sent.filter(request => request.method === 'tools/call').length, 2)
  assert.equal(sent.find(request => request.method === 'tools/call').params.name, 'check_permissions')
  assert.ok(!agent.dispatcher.declarations.some(tool => tool.name === 'computer_check_permissions'))
  assert.match(sent.find(request => request.method === 'tools/call').params.arguments.session, /^loom-/)
  assert.ok(session.events.find(event => event.type === 'tool.started').seq < result.seq)
  await agent.close()
  const reopened = await Session.open(cwd, session.id, { existing: true })
  try { assert.equal((await hydrateImages(reopened.directory, reopened.messages)).find(message => message.role === 'toolResult').content[1].data, png) } finally { await reopened.close() }
})

test('computer startup checks permissions through the dispatcher before any model call and never requests OS grants', async t => {
  for (const report of [{ accessibility: false, screen_recording: true }, { accessibility: true, screen_recording: false }, { status: 'unknown' }]) {
    const { cwd, session, computer, audit, requests } = await computerFixture(t)
    await writeFile(`${audit}.permissions.json`, JSON.stringify(report))
    const model = fakeModel([])
    model.input = ['text', 'image']
    const agent = new Agent({ cwd, session, model, computer, mode: 'auto' })
    t.after(() => agent.close())
    await assert.rejects(agent.initialize(), /cua-driver permissions grant/)
    assert.equal(model.requests.length, 0)
    const sent = (await requests()).filter(request => request.method === 'tools/call')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].params.name, 'check_permissions')
    assert.equal(sent[0].params.arguments.prompt, false)
    assert.equal(sent[0].params.arguments.probe_direct_capture, false)
    const start = session.latestEvent('tool.started')
    const finish = session.latestEvent('tool.finished')
    assert.equal(start.source, 'preflight')
    assert.equal(finish.status, 'failed')
    assert.ok(start.seq < finish.seq)
    assert.equal(finish.message.role, 'user')
    assert.match(finish.message.content, /Harness readiness check/)
    assert.equal(session.messages.some(message => message.role === 'toolResult'), false)
  }
})

test('models cannot invoke internal permission checks or turn them into prompt-capable requests', async t => {
  const { session, computer, requests } = await computerFixture(t)
  const { tools } = await computer.initialize()
  const dispatcher = new Dispatcher({ session, tools, mode: 'auto' })
  assert.ok(!dispatcher.declarations.some(tool => tool.name === 'computer_check_permissions'))
  const model = await dispatcher.run(call('computer_check_permissions'), new AbortController().signal)
  assert.equal(model.isError, true)
  const malformed = await dispatcher.run(call('computer_check_permissions', { prompt: true }, 'malformed'), new AbortController().signal, false, 'preflight')
  assert.equal(malformed.isError, true)
  assert.equal((await requests()).filter(request => request.method === 'tools/call').length, 0)
})

test('runtime permission loss stops the whole batch and resume rechecks before invoking any model', async t => {
  const { cwd, session, computer, audit, requests } = await computerFixture(t)
  const model = fakeModel([
    response([call('computer_press_key', { key: 'permissions_pending' }, 'gate'), call('write_file', { path: 'must-not-exist.txt', content: 'unverified change' }, 'later-edit'), call('computer_get_window_state', { pid: 42 }, 'later-observe')], 'toolUse'),
    response([call('computer_get_window_state', { pid: 42 }, 'fresh')], 'toolUse'),
    response('Fresh observation returned after the user restored permissions.')
  ])
  model.input = ['text', 'image']
  const agent = new Agent({ cwd, session, model, computer, mode: 'auto' })
  t.after(() => agent.close())
  await agent.initialize()
  await agent.enqueue('Verify the original visual defect')
  await agent.wait()
  assert.equal(agent.status, 'failed')
  assert.equal(model.requests.length, 1)
  assert.equal(session.latestEvent('task.finished').outcome, 'blocked')
  assert.equal(computer.blocker.code, 'permissions_pending')
  assert.deepEqual(session.events.filter(event => event.type === 'tool.finished' && event.source === 'model').map(event => event.status), ['failed', 'cancelled', 'cancelled'])
  await assert.rejects(readFile(path.join(cwd, 'must-not-exist.txt')), { code: 'ENOENT' })
  await writeFile(`${audit}.permissions.json`, JSON.stringify({ accessibility: true, screen_recording: false }))
  await agent.resume()
  await agent.wait()
  assert.equal(model.requests.length, 1)
  assert.equal(agent.status, 'failed')
  await writeFile(`${audit}.permissions.json`, JSON.stringify({ accessibility: true, screen_recording: true }))
  await agent.resume()
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(computer.blocker, null)
  assert.equal(model.requests.length, 3)
  assert.ok(JSON.stringify(model.requests[1]).includes('Verify the original visual defect'))
  const sent = (await requests()).filter(request => request.method === 'tools/call')
  assert.deepEqual(sent.map(request => request.params.name), ['check_permissions', 'press_key', 'check_permissions', 'check_permissions', 'get_window_state'])
  assert.equal(sent.filter(request => request.params.arguments.key === 'permissions_pending').length, 1)
})

test('crashed readiness checks recover as harness evidence without orphan tool responses or replay', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('tool.started', { call: call('computer_check_permissions'), source: 'preflight' })
  await session.close()
  const reopened = await Session.open(cwd, session.id, { existing: true })
  try {
    assert.equal(await reopened.recover(), true)
    assert.equal(reopened.latestEvent('tool.finished').status, 'unknown')
    assert.equal(reopened.messages.at(-1).role, 'user')
    assert.match(reopened.messages.at(-1).content, /Harness readiness check/)
    assert.equal(reopened.events.filter(event => event.type === 'tool.started').length, 1)
  } finally { await reopened.close() }
})

test('computer input is denied in plan mode and needs its own approval in edit mode', async t => {
  const { session, computer, requests } = await computerFixture(t)
  const { tools } = await computer.initialize()
  const decisions = []
  const dispatcher = new Dispatcher({ session, tools, mode: 'plan', approve: async request => { decisions.push(request.effect); return 'session' } })
  assert.ok(!dispatcher.declarations.some(tool => tool.name === 'computer_press_key'))
  assert.equal((await dispatcher.run(call('computer_press_key', { key: 'Space' }), new AbortController().signal)).isError, true)
  assert.equal((await requests()).filter(request => request.method === 'tools/call').length, 0)
  dispatcher.mode = 'edit'
  await dispatcher.run(call('computer_press_key', { key: 'Space' }, 'allowed'), new AbortController().signal)
  await dispatcher.run(call('computer_press_key', { key: 'ArrowLeft' }, 'reused'), new AbortController().signal)
  assert.deepEqual(decisions, ['computer'])
  assert.equal(session.events.filter(event => event.type === 'permission.decided' && event.reused).length, 1)
  assert.equal((await requests()).filter(request => request.method === 'tools/call').length, 2)
})

test('interrupted computer input settles once, closes the connection, and is never retried', async t => {
  const { session, computer, requests } = await computerFixture(t)
  const { tools } = await computer.initialize()
  const controller = new AbortController()
  const dispatcher = new Dispatcher({ session, tools, mode: 'auto', emit: event => { if (event.kind === 'computer.progress') controller.abort() } })
  const result = await dispatcher.run(call('computer_press_key', { key: 'hang' }), controller.signal)
  assert.equal(result.isError, true)
  assert.equal(session.latestEvent('tool.finished').status, 'cancelled')
  assert.equal(computer.closed, true)
  assert.match(result.content[0].text, /unknown/)
  assert.equal((await requests()).filter(request => request.method === 'tools/call').length, 1)
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 1)
})

test('driver disconnect and timeout retain unknown outcomes without replaying the action', async t => {
  for (const key of ['disconnect', 'hang']) {
    const { session, computer, requests } = await computerFixture(t, { timeoutMs: 100 })
    const { tools } = await computer.initialize()
    const dispatcher = new Dispatcher({ session, tools, mode: 'auto' })
    await dispatcher.run(call('computer_press_key', { key }), new AbortController().signal)
    assert.equal(session.latestEvent('tool.finished').status, 'unknown')
    const after = await dispatcher.run(call('computer_get_window_state', { pid: 42 }, 'after-failure'), new AbortController().signal)
    assert.match(after.content[0].text, /connection is closed/)
    assert.equal((await requests()).filter(request => request.method === 'tools/call').length, 1)
  }
})

test('known driver errors permit fresh observations while pre-cancelled input never reaches the driver', async t => {
  const { session, computer, requests } = await computerFixture(t)
  const { tools } = await computer.initialize()
  const dispatcher = new Dispatcher({ session, tools, mode: 'auto' })
  const failed = await dispatcher.run(call('computer_press_key', { key: 'error' }), new AbortController().signal)
  assert.equal(failed.isError, true)
  assert.equal(session.latestEvent('tool.finished').status, 'failed')
  assert.equal(computer.closed, false)
  const observed = await dispatcher.run(call('computer_list_windows', { session: 'foreign-session' }, 'observe'), new AbortController().signal)
  assert.equal(observed.isError, false)
  const cancelled = await dispatcher.run(call('computer_press_key', { key: 'Space' }, 'cancelled'), AbortSignal.abort())
  assert.equal(cancelled.isError, true)
  assert.equal(session.latestEvent('tool.finished').executed, false)
  const sent = (await requests()).filter(request => request.method === 'tools/call')
  assert.equal(sent.length, 2)
  assert.equal(sent[1].params.arguments.session, undefined)
})

test('browser setup rejects existing profiles and computer guides use the dispatcher', async t => {
  const { session, computer, requests } = await computerFixture(t)
  const { tools } = await computer.initialize()
  const dispatcher = new Dispatcher({ session, tools, mode: 'auto' })
  const denied = await dispatcher.run(call('computer_browser_prepare', { profile: { mode: 'existing_profile' } }), new AbortController().signal)
  assert.equal(denied.isError, true)
  assert.equal((await requests()).filter(request => request.method === 'tools/call').length, 0)
  const help = await dispatcher.run(call('computer_help', {}, 'guide'), new AbortController().signal)
  assert.match(help.content[0].text, /Observe the selected window/)
  assert.ok(session.events.some(event => event.type === 'tool.started' && event.call.name === 'computer_help'))
})

test('screenshots are bounded, content addressed, protected from replacement, and recalled through tools', async t => {
  const { cwd, session } = await fixture(t)
  const [image] = await storeImages(session.directory, [{ mimeType: 'image/png', data: png }])
  assert.deepEqual(await storeImages(session.directory, [{ mimeType: 'image/png', data: png }]), [image])
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }) })
  const recalled = await dispatcher.run(call('read_image', { artifact: image.artifact }), new AbortController().signal)
  assert.equal(recalled.content[1].artifact, image.artifact)
  assert.match(visibleMessage(recalled).content[1].text, /does not include pixels/)
  await assert.rejects(readImage(session.directory, '../escape.png'), /Invalid/)
  await assert.rejects(storeImages(session.directory, [{ mimeType: 'image/svg+xml', data: png }]), /Invalid/)
  await writeFile(path.join(session.directory, image.artifact), 'changed')
  await assert.rejects(readImage(session.directory, image.artifact), /changed/)
  const hydrated = await hydrateImages(session.directory, [recalled])
  assert.match(hydrated[0].content[1].text, /Pixels were not supplied/)
  const link = `image-${'a'.repeat(64)}.png`
  await symlink(path.join(session.directory, image.artifact), path.join(session.directory, link))
  await assert.rejects(readImage(session.directory, link))
})

test('image context retains recent pixels, omits them for text models, and does not count base64 as text tokens', () => {
  const messages = Array.from({ length: 7 }, (_, index) => ({ role: 'toolResult', content: [{ type: 'image', artifact: `image-${index}.png`, mimeType: 'image/png' }] }))
  const projected = projectImages(messages)
  assert.equal(projected.flatMap(message => message.content).filter(part => part.type === 'image').length, 4)
  assert.match(projected[0].content[0].text, /read_image/)
  assert.equal(projectImages(messages, false).flatMap(message => message.content).filter(part => part.type === 'image').length, 0)
  assert.equal(estimateTokens({ type: 'image', mimeType: 'image/png', data: 'a'.repeat(1000000) }), estimateTokens({ type: 'image', mimeType: 'image/png', data: 'small' }))
  assert.ok(estimateTokens(messages) >= 7 * 4096)
  assert.equal(messages[0].content[0].type, 'image')
})

test('text-only models fail before a computer connection is opened', async t => {
  const { cwd, session } = await fixture(t)
  let opened = false
  const agent = new Agent({ cwd, session, model: fakeModel([]), computer: { initialize: async () => { opened = true }, close: async () => {} } })
  t.after(() => agent.close())
  await assert.rejects(agent.initialize(), /image input/)
  assert.equal(opened, false)
})
