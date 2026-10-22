import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { createTools, Dispatcher } from '../src/tools/dispatcher.js'
import { hashText, resolveFile, saveFile } from '../src/tools/files.js'
import { readText } from '../src/io.js'
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

test('conflicting and cancelled replacements preserve the current file and clean owned temporary files', async t => {
  const { cwd, session } = await fixture(t)
  const file = path.join(cwd, 'a.txt')
  await writeFile(file, 'original')
  const append = session.append.bind(session)
  session.append = async (type, data) => {
    const event = await append(type, data)
    if (type === 'file.checkpoint') await writeFile(file, 'external edit')
    return event
  }
  await assert.rejects(saveFile(session, file, 'a.txt', 'original', 'replacement', new AbortController().signal), /changed during edit/)
  assert.equal(await readFile(file, 'utf8'), 'external edit')
  assert.ok(!(await readdir(cwd)).some(name => name.includes('.loom-')))
  session.append = append
  const controller = new AbortController()
  const signal = {
    throwIfAborted: () => {
      if (readdirSync(cwd).some(name => name.includes('.loom-'))) controller.abort()
      controller.signal.throwIfAborted()
    }
  }
  await assert.rejects(saveFile(session, file, 'a.txt', 'external edit', 'replacement', signal), { name: 'AbortError' })
  assert.equal(await readFile(file, 'utf8'), 'external edit')
  assert.ok(!(await readdir(cwd)).some(name => name.includes('.loom-')))
  assert.equal(session.events.filter(event => event.type === 'file.checkpoint').length, 2)
})

test('bounded text reads refuse special files, symlinks, binary content, and oversize input', async t => {
  const { cwd } = await fixture(t)
  const file = path.join(cwd, 'text.txt')
  await writeFile(file, '你好')
  assert.equal(await readText(file, 6), '你好')
  await assert.rejects(readText(file, 5), { code: 'LOOM_TEXT_LIMIT' })
  await assert.rejects(readText(cwd), /regular file/)
  await symlink(file, path.join(cwd, 'linked'))
  await assert.rejects(readText(path.join(cwd, 'linked')))
  await writeFile(file, 'a\0b')
  await assert.rejects(readText(file), { code: 'LOOM_BINARY_FILE' })
  if (process.platform !== 'win32') {
    const fifo = path.join(cwd, 'fifo')
    execFileSync('/usr/bin/mkfifo', [fifo])
    await assert.rejects(readText(fifo), /regular file/)
  }
})

test('one large directory cannot exceed the file listing cap and reports incomplete coverage', async t => {
  const { cwd, session } = await fixture(t)
  for (let offset = 0; offset < 5010; offset += 100) {
    await Promise.all(Array.from({ length: Math.min(100, 5010 - offset) }, (_, i) => writeFile(path.join(cwd, `file-${offset + i}`), '')))
  }
  const tool = createTools({ cwd, session }).find(tool => tool.name === 'list_files')
  const output = await tool.execute({}, { signal: new AbortController().signal })
  const lines = output.split('\n')
  assert.equal(lines.filter(line => line.startsWith('file-')).length, 5000)
  assert.match(lines.at(-1), /File limit reached/)
})

test('invalid tool contracts and unknown effects become paired errors without bypassing authorization', async t => {
  const { session } = await fixture(t)
  let executions = 0
  const tools = [
    { name: 'unknown', effect: 'network', parameters: Type.Object({}), execute: async () => { executions++; return 'unsafe' } },
    { name: 'invalid', effect: 'read', parameters: Type.Object({}), execute: async () => ({ text: 123 }) },
    { name: 'throws', effect: 'read', parameters: Type.Object({}), execute: async () => { const failure = 'plain failure'; throw failure } }
  ]
  const dispatcher = new Dispatcher({ session, tools, mode: 'auto' })
  const signal = new AbortController().signal
  for (const name of ['unknown', 'invalid', 'throws']) {
    const result = await dispatcher.run(call(name, {}, name), signal)
    assert.equal(result.isError, true)
    assert.equal(typeof result.content[0].text, 'string')
  }
  assert.equal(executions, 0)
  assert.equal(session.events.filter(event => event.type === 'tool.finished').length, 3)
  assert.equal(session.events.find(event => event.callId === 'unknown').executed, false)
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
  const events = []
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), emit: event => events.push(event), mode: 'edit', approve: async () => { approvals++; return true } })
  const result = await dispatcher.run(call('shell', { command: 'node -e "process.stdout.write(\'x\'.repeat(20000))"' }), new AbortController().signal)
  assert.equal(approvals, 1)
  assert.equal(result.isError, false)
  assert.ok(result.content[0].text.length < 14000)
  const artifact = result.content[0].text.match(/artifact: ([a-f0-9-]+\.txt)/)[1]
  assert.equal((await readFile(path.join(session.directory, artifact), 'utf8')).length, 20000)
  assert.equal(session.events.find(event => event.type === 'tool.finished').message.toolCallId, 'call-1')
  const progress = events.find(event => event.kind === 'process.output')
  assert.equal(progress.callId, 'call-1')
  assert.match(progress.text, /^x+$/)
  assert.ok(progress.text.length <= 2000)
  assert.ok(events.indexOf(progress) < events.findIndex(event => event.type === 'tool.end'))
  assert.equal(events.at(-1).status, 'completed')
})

test('session approval covers only that tool and is not restored in another dispatcher or allowed in plan mode', async t => {
  const { cwd, session } = await fixture(t)
  const prompts = []
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), approve: async ({ call }) => { prompts.push(call.name); return call.name === 'shell' ? 'session' : false } })
  const signal = new AbortController().signal
  for (const id of ['first', 'second']) {
    const result = await dispatcher.run(call('shell', { command: 'node -e "console.log(123)"' }, id), signal)
    assert.equal(result.isError, false, result.content[0].text)
  }
  assert.deepEqual(prompts, ['shell'])
  assert.equal((await dispatcher.run(call('write_file', { path: 'denied.txt', content: 'no' }, 'write'), signal)).isError, true)
  assert.deepEqual(prompts, ['shell', 'write_file'])
  const decisions = session.events.filter(event => event.type === 'permission.decided')
  assert.equal(decisions[0].scope, 'session')
  assert.equal(decisions[0].reused, false)
  assert.equal(decisions[1].reused, true)
  dispatcher.mode = 'plan'
  assert.equal((await dispatcher.run(call('shell', { command: 'true' }, 'plan'), signal)).isError, true)
  let reopenedPrompts = 0
  const reopened = new Dispatcher({ session, tools: createTools({ cwd, session }), approve: async () => { reopenedPrompts++; return false } })
  assert.equal((await reopened.run(call('shell', { command: 'true' }, 'reopened'), signal)).isError, true)
  assert.equal(reopenedPrompts, 1)
})

test('a cancelled session approval never installs a remembered grant', async t => {
  const { cwd, session } = await fixture(t)
  const controller = new AbortController()
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), approve: async () => { controller.abort(); return 'session' } })
  const result = await dispatcher.run(call('write_file', { path: 'cancelled.txt', content: 'no' }), controller.signal)
  assert.equal(result.isError, true)
  assert.equal(dispatcher.sessionGrants.size, 0)
  assert.equal(session.events.find(event => event.type === 'permission.decided').allowed, false)
  await assert.rejects(readFile(path.join(cwd, 'cancelled.txt')), { code: 'ENOENT' })
})

test('cancellation settles every call in a sequential batch and kills a running shell', async t => {
  const { cwd, session } = await fixture(t)
  const controller = new AbortController()
  const started = deferred()
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), approve: async () => true, emit: event => { if (event.type === 'tool.progress' && /process \d+ started/.test(event.text)) started.resolve() } })
  const pending = dispatcher.batch([call('shell', { command: 'sleep 60' }), call('list_files', {}, 'second')], controller.signal)
  await Promise.race([started.promise, pending.then(() => { throw new Error('Shell finished before starting a sandboxed process') })])
  controller.abort()
  const results = await pending
  assert.equal(results.length, 2)
  assert.ok(results.every(result => result.isError))
  assert.match(results[0].content[0].text, /status: cancelled/)
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

test('search finds dependency source beyond the old size cap and preserves matches deep in long lines', async t => {
  const { cwd, session } = await fixture(t)
  await mkdir(path.join(cwd, 'node_modules', 'example', 'dist'), { recursive: true })
  await writeFile(path.join(cwd, 'node_modules', 'example', 'dist', 'bundle.js'), `${'padding\n'.repeat(90000)}${'x'.repeat(800)}target.literal[0]\n`)
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'plan' })
  const signal = new AbortController().signal
  const excluded = await dispatcher.run(call('search', { query: 'target.literal[0]' }, 'excluded'), signal)
  assert.match(excluded.content[0].text, /Excluded.*traversal entries/)
  assert.match(excluded.content[0].text, /Coverage: incomplete/)
  assert.match(excluded.content[0].text, /paths omitted.*node_modules/)
  assert.match(excluded.content[0].text, /not evidence of absence/)
  const found = await dispatcher.run(call('search', { query: 'target.literal[0]', path: 'node_modules/example' }, 'found'), signal)
  assert.equal(found.isError, false)
  assert.match(found.content[0].text, /dist\/bundle.js:90001: .*target\.literal\[0\]/)
  assert.match(found.content[0].text, /complete within traversal scope/)
  assert.match(found.content[0].text, /Matching lines shortened/)
})

test('explicit subdirectories include builds while protecting credentials, metadata, and symlinks', async t => {
  const { cwd, session } = await fixture(t)
  const root = path.join(cwd, 'package')
  for (const directory of ['dist', 'coverage', 'vendor', 'node_modules', '.git']) {
    await mkdir(path.join(root, directory), { recursive: true })
    await writeFile(path.join(root, directory, 'data.txt'), directory === '.git' ? 'needle PRIVATE' : 'needle')
  }
  await writeFile(path.join(root, '.env'), 'needle SECRET')
  await symlink(path.join(root, '.env'), path.join(root, 'redirect'))
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'plan' })
  const signal = new AbortController().signal
  const found = await dispatcher.run(call('search', { path: 'package', query: 'needle' }), signal)
  const text = found.content[0].text
  for (const directory of ['dist', 'coverage', 'vendor', 'node_modules']) assert.ok(text.includes(`package/${directory}/data.txt:1: needle`))
  assert.match(text, /0 dependency\/build directories, 2 protected paths, 1 symlinks/)
  assert.match(text, /Coverage: incomplete/)
  assert.doesNotMatch(text, /PRIVATE|SECRET|\.env|\.git/)
  const denied = await dispatcher.run(call('search', { path: 'package/.git', query: 'needle' }, 'protected'), signal)
  assert.equal(denied.isError, true)
})

test('search reports skipped text and binary files instead of claiming complete negative evidence', async t => {
  const { cwd, session } = await fixture(t)
  await writeFile(path.join(cwd, 'large.txt'), `${'x'.repeat(2 * 1024 * 1024)}needle`)
  await writeFile(path.join(cwd, 'binary.bin'), 'needle\0')
  await writeFile(path.join(cwd, 'small.txt'), 'ordinary text')
  await writeFile(path.join(cwd, '.env'), 'needle SECRET')
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'plan' })
  const signal = new AbortController().signal
  const result = await dispatcher.run(call('search', { query: 'needle' }), signal)
  assert.equal(result.isError, false)
  const text = result.content[0].text
  assert.match(text, /coverage is incomplete/)
  assert.match(text, /read 1\/3 enumerated files; skipped 2/)
  assert.match(text, /large.txt: exceeds 2 MiB/)
  assert.match(text, /binary.bin: binary content/)
  assert.doesNotMatch(text, /SECRET|\.env/)
  const explicit = await dispatcher.run(call('search', { query: 'needle', path: 'large.txt' }, 'large'), signal)
  assert.match(explicit.content[0].text, /coverage is incomplete/)
  const complete = await dispatcher.run(call('search', { query: 'needle', path: 'small.txt' }, 'small'), signal)
  assert.match(complete.content[0].text, /No matches in searched files/)
  assert.match(complete.content[0].text, /complete within traversal scope/)
  const missing = await dispatcher.run(call('search', { query: 'needle', path: 'missing.txt' }, 'missing'), signal)
  assert.equal(missing.isError, true)
})

test('search marks result limits while settling cancelled requests', async t => {
  const { cwd, session } = await fixture(t)
  await writeFile(path.join(cwd, 'matches.txt'), 'needle\n'.repeat(201))
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'plan' })
  const result = await dispatcher.run(call('search', { query: 'needle' }), new AbortController().signal)
  assert.equal(result.content[0].text.split('\n').filter(line => line.startsWith('matches.txt:')).length, 200)
  assert.match(result.content[0].text, /Match limit reached/)
  assert.match(result.content[0].text, /Coverage: incomplete/)
  const controller = new AbortController()
  controller.abort()
  const cancelled = await dispatcher.run(call('search', { query: 'needle' }, 'cancelled'), controller.signal)
  assert.equal(cancelled.isError, true)
  assert.equal(session.events.find(event => event.callId === 'cancelled' && event.type === 'tool.finished').status, 'cancelled')
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
