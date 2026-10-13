import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { listSessions } from '../src/core/session-list.js'
import { Session } from '../src/core/session.js'
import { parseOptions } from '../src/cli.js'
import { fixture } from './helpers.js'

// entry locates the real CLI for offline startup and selection checks.
const entry = fileURLToPath(new URL('../bin/loom.js', import.meta.url))

test('session catalog is read-only, excludes children, reports busy roots, and tolerates torn tails', async t => {
  const { cwd, session } = await fixture(t)
  await session.append('inbox.enqueued', { inputId: 'input', text: 'Root task', delivery: 'queue' })
  const child = await Session.open(cwd, 'child')
  await child.append('session.parent', { parentId: session.id })
  await child.close()
  const oldChild = await Session.open(cwd, 'old-child')
  await oldChild.close()
  await session.append('agent.spawned', { childId: 'old-child' })
  const file = path.join(session.directory, 'events.jsonl')
  const before = await readFile(file, 'utf8')
  let catalog = await listSessions(cwd)
  assert.equal(catalog.sessions.length, 1)
  assert.equal(catalog.sessions[0].id, session.id)
  assert.equal(catalog.sessions[0].busy, true)
  assert.equal(catalog.sessions[0].pending, 1)
  assert.equal(await readFile(file, 'utf8'), before)
  await session.close()
  await appendFile(file, '{"torn":')
  catalog = await listSessions(cwd)
  assert.equal(catalog.sessions[0].busy, false)
  assert.equal(await readFile(file, 'utf8'), before + '{"torn":')
  const lock = path.join(session.directory, 'lock')
  await writeFile(lock, JSON.stringify({ pid: 2147483647 }))
  assert.equal((await listSessions(cwd)).sessions[0].busy, false)
  assert.equal(await readFile(lock, 'utf8'), JSON.stringify({ pid: 2147483647 }))
})

test('catalog skips malformed and symlinked logs without following metadata directory links', async t => {
  const { cwd, session } = await fixture(t)
  const root = path.dirname(session.directory)
  await mkdir(path.join(root, 'bad'))
  await writeFile(path.join(root, 'bad', 'events.jsonl'), 'not json\n')
  await mkdir(path.join(root, 'linked-log'))
  await symlink(path.join(session.directory, 'events.jsonl'), path.join(root, 'linked-log', 'events.jsonl'))
  await symlink(session.directory, path.join(root, 'linked-directory'))
  const catalog = await listSessions(cwd)
  assert.equal(catalog.sessions.length, 1)
  assert.equal(catalog.skipped, 2)
})

test('resume CLI lists without credentials or writes and refuses missing or busy selections', async t => {
  const { cwd, session } = await fixture(t)
  const before = await readdir(path.dirname(session.directory))
  const env = { ...process.env, AI_GATEWAY_API_KEY: '', LOOM_PROVIDER: '' }
  const listed = spawnSync(process.execPath, [entry, 'resume', '--list', '--json', '--cwd', cwd], { encoding: 'utf8', env })
  assert.equal(listed.status, 0, listed.stderr)
  assert.equal(JSON.parse(listed.stdout).sessions[0].busy, true)
  assert.deepEqual(await readdir(path.dirname(session.directory)), before)
  const missing = spawnSync(process.execPath, [entry, 'resume', 'missing', '--cwd', cwd], { encoding: 'utf8', env })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /not found/)
  const busy = spawnSync(process.execPath, [entry, 'resume', session.id, '--cwd', cwd], { encoding: 'utf8', env })
  assert.equal(busy.status, 1)
  assert.match(busy.stderr, /already open/)
  await session.close()
  const resumed = spawnSync(process.execPath, [entry, 'resume', '--last', '--demo', '--resume', '--json', '--cwd', cwd], { encoding: 'utf8', env })
  assert.equal(resumed.status, 0, resumed.stderr)
  const events = resumed.stdout.trim().split('\n').map(JSON.parse)
  assert.ok(events.some(event => event.type === 'resume.skipped'))
  assert.ok(!events.some(event => event.type === 'assistant.start'))
  assert.deepEqual(await readdir(path.dirname(session.directory)), before)
})

test('resume argument parsing distinguishes selection from execution and rejects ambiguous combinations', () => {
  assert.equal(parseOptions(['resume'], {}).resume, false)
  assert.equal(parseOptions(['resume', 'saved'], {}).session, 'saved')
  assert.equal(parseOptions(['resume', '--last'], {}).last, true)
  for (const args of [['--last'], ['--resume'], ['resume', 'a', 'b'], ['resume', 'a', '--last'], ['resume', '--list', '--resume'], ['resume', 'a', '--session', 'b']]) {
    assert.throws(() => parseOptions(args, {}))
  }
})

test('opening an existing selection cannot create a missing session', async t => {
  const { cwd, session } = await fixture(t)
  await assert.rejects(Session.open(cwd, 'missing', { existing: true }), { code: 'ENOENT' })
  assert.deepEqual(await readdir(path.dirname(session.directory)), [session.id])
})
