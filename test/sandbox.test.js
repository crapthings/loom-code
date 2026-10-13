import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { ShellExecutor, sandboxStatus } from '../src/execution/executor.js'
import { shellEnvironment } from '../src/execution/policy.js'
import { createTools, Dispatcher } from '../src/tools/dispatcher.js'
import { agentFixture, call, fixture, response } from './helpers.js'

// quote turns test snippets into literal shell arguments without interpreting their contents.
function quote (text) {
  return `'${text.replace(/'/g, "'\\''")}'`
}

// execute sends a real command through the automatic dispatcher and mandatory native sandbox.
async function execute (dispatcher, code) {
  return dispatcher.run(call('shell', { command: `node -e ${quote(code)}` }), new AbortController().signal)
}

test('sandboxed shell permits workspace programming and isolated temporary files', async t => {
  const { cwd, session } = await fixture(t)
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'auto' })
  const result = await execute(dispatcher, "const fs=require('fs'); const os=require('os'); fs.writeFileSync('result.txt','allowed'); fs.writeFileSync(os.tmpdir()+'/scratch','temporary'); console.log('program completed')")
  assert.equal(result.isError, false, result.content[0].text)
  assert.equal(await readFile(path.join(cwd, 'result.txt'), 'utf8'), 'allowed')
})

test('native sandbox denies outside reads, writes, symlink escapes, credentials, and metadata changes', async t => {
  const { cwd, session } = await fixture(t)
  const outside = await mkdtemp(path.join(tmpdir(), 'loom-outside-'))
  t.after(() => rm(outside, { recursive: true, force: true }))
  await writeFile(path.join(outside, 'private.txt'), 'PRIVATE SENTINEL')
  await writeFile(path.join(cwd, '.env'), 'SECRET SENTINEL')
  await symlink(outside, path.join(cwd, 'escape'))
  await mkdir(path.join(cwd, '.git'))
  await writeFile(path.join(cwd, '.git/config'), 'original')
  const journal = path.join(session.directory, 'events.jsonl')
  const probes = [
    `fs.readFileSync(${JSON.stringify(path.join(outside, 'private.txt'))})`,
    `fs.writeFileSync(${JSON.stringify(path.join(outside, 'created'))},'bad')`,
    "fs.readFileSync('escape/private.txt')",
    "fs.writeFileSync('escape/created','bad')",
    "fs.readFileSync('.env')",
    "fs.renameSync('.env','disguised.txt')",
    "fs.writeFileSync('.git/config','bad')",
    `fs.writeFileSync(${JSON.stringify(journal)},'bad')`,
    "fs.renameSync('.loom','renamed-metadata')"
  ]
  const code = `const fs=require('fs'); const probes=${JSON.stringify(probes)}; for(const probe of probes){let denied=false;try{eval(probe)}catch{denied=true}if(!denied){console.error('ESCAPE: '+probe);process.exit(1)}}console.log('all boundaries denied')`
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'auto' })
  const result = await execute(dispatcher, code)
  assert.equal(result.isError, false, result.content[0].text)
  assert.equal(await readFile(path.join(cwd, '.git/config'), 'utf8'), 'original')
  assert.ok(session.events.some(event => event.type === 'tool.finished'))
})

test('sandbox denies direct TCP and workspace Unix socket access without contacting the listeners', async t => {
  const { cwd, session } = await fixture(t)
  let connections = 0
  const tcp = createServer(socket => { connections++; socket.end() })
  const unix = createServer(socket => { connections++; socket.end() })
  const socketPath = path.join(cwd, 'service.sock')
  await new Promise(resolve => tcp.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => unix.listen(socketPath, resolve))
  t.after(() => { tcp.close(); unix.close() })
  const code = `const net=require('net');const targets=[{host:'127.0.0.1',port:${tcp.address().port}},{path:${JSON.stringify(socketPath)}}];(async()=>{for(const target of targets){await new Promise((resolve,reject)=>{const socket=net.connect(target);socket.setTimeout(3000,()=>{socket.destroy();reject(Error('timed out rather than denied'))});socket.on('error',()=>resolve());socket.on('connect',()=>{socket.destroy();reject(Error('network escaped'))})})}console.log('network denied')})().catch(e=>{console.error(e);process.exitCode=1})`
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'auto' })
  const result = await execute(dispatcher, code)
  assert.equal(result.isError, false, result.content[0].text)
  assert.equal(connections, 0)
})

test('sandbox dependency and initialization failures never produce an unsandboxed launch', async t => {
  const { cwd } = await fixture(t)
  const manager = { checkDependencies: () => ({ errors: ['missing isolation'], warnings: [] }) }
  const executor = new ShellExecutor({ cwd, manager })
  await assert.rejects(executor.prepare('touch escaped', new AbortController().signal), /no host fallback/)
  manager.checkDependencies = () => ({ errors: [], warnings: ['missing socket isolation'] })
  await assert.rejects(executor.prepare('touch escaped', new AbortController().signal), /missing socket isolation/)
  let resets = 0
  manager.checkDependencies = () => ({ errors: [], warnings: [] })
  manager.initialize = async () => { throw new Error('native initialization failed') }
  manager.reset = async () => { resets++ }
  await assert.rejects(executor.prepare('touch escaped', new AbortController().signal), /native initialization failed/)
  assert.equal(resets, 1)
})

test('cancelling a queued preparation releases its reservation without resetting another sandbox', async t => {
  const { cwd } = await fixture(t)
  const executor = new ShellExecutor({ cwd, sandbox: 'off' })
  const first = await executor.prepare('true', new AbortController().signal)
  const controller = new AbortController()
  const queued = executor.prepare('false', controller.signal)
  controller.abort(new Error('queued cancellation'))
  await assert.rejects(queued, /queued cancellation/)
  await first.cleanup()
  const next = await executor.prepare('true', new AbortController().signal)
  assert.equal(next.label, 'UNSANDBOXED HOST')
  await next.cleanup()
})

test('shell environment omits credentials and executable startup hooks by construction', () => {
  const env = shellEnvironment('/temporary/example')
  for (const key of ['AI_GATEWAY_API_KEY', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'NODE_OPTIONS', 'BASH_ENV', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) assert.equal(env[key], undefined)
  assert.equal(env.HOME, '/temporary/example')
})

test('repeated sandbox cleanup cannot reset a subsequent active launch', async t => {
  const { cwd } = await fixture(t)
  let resets = 0
  let cleanups = 0
  const manager = {
    updateConfig: () => {},
    checkDependencies: () => ({ errors: [], warnings: [] }),
    initialize: async () => {},
    wrapWithSandboxArgv: async () => ({ argv: ['/bin/bash', '-c', 'true'] }),
    getLinuxGlobPatternWarnings: () => [],
    cleanupAfterCommand: () => { cleanups++ },
    reset: async () => { resets++ }
  }
  const executor = new ShellExecutor({ cwd, manager })
  const first = await executor.prepare('true', new AbortController().signal)
  await Promise.all([first.cleanup(), first.cleanup()])
  assert.equal(resets, 1)
  assert.equal(cleanups, 1)
  const second = await executor.prepare('true', new AbortController().signal)
  try {
    await first.cleanup()
    assert.equal(resets, 1)
    assert.equal(cleanups, 1)
  } finally { await second.cleanup() }
  assert.equal(resets, 2)
  assert.equal(cleanups, 2)
})

test('Linux sandbox preparation never executes helpers from a project-controlled PATH', { skip: process.platform !== 'linux' }, async t => {
  const { cwd, session } = await fixture(t)
  const marker = path.join(cwd, 'helper-executed')
  for (const name of ['bwrap', 'socat', 'rg', 'npm']) {
    const helper = path.join(cwd, name)
    await writeFile(helper, `#!/bin/sh\n/usr/bin/touch ${quote(marker)}\nexit 1\n`)
    await chmod(helper, 0o755)
  }
  const original = process.env.PATH
  process.env.PATH = `${cwd}:${original}`
  t.after(() => { process.env.PATH = original })
  const status = await sandboxStatus()
  assert.deepEqual(status.errors, [])
  assert.deepEqual(status.warnings, [])
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'auto' })
  const result = await execute(dispatcher, "console.log('trusted helpers')")
  assert.equal(result.isError, false, result.content[0].text)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
})

test('file tools also reject credentials instead of relying on the shell sandbox', async t => {
  const { cwd, session } = await fixture(t)
  await writeFile(path.join(cwd, '.env'), 'hidden')
  await writeFile(path.join(cwd, '.env.example'), 'example')
  const dispatcher = new Dispatcher({ session, tools: createTools({ cwd, session }), mode: 'auto' })
  assert.equal((await dispatcher.run(call('read_file', { path: '.env' }), new AbortController().signal)).isError, true)
  assert.equal((await dispatcher.run(call('write_file', { path: '.env.new', content: 'hidden' }), new AbortController().signal)).isError, true)
  const search = await dispatcher.run(call('search', { query: 'hidden' }), new AbortController().signal)
  assert.equal(search.isError, false)
  assert.match(search.content[0].text, /No matches/)
  assert.equal((await dispatcher.run(call('read_file', { path: '.env.example' }), new AbortController().signal)).isError, false)
})

test('agent writes JavaScript then runs its tests inside the sandbox without paid model requests', async t => {
  const script = [response([call('write_file', { path: 'add.js', content: 'exports.add = (a, b) => a + b\n' }), call('write_file', { path: 'add.test.js', content: "const assert = require('node:assert/strict')\nconst { add } = require('./add')\nassert.equal(add(2, 3), 5)\n" }, 'test-file')], 'toolUse'), response([call('shell', { command: 'node --test add.test.js' }, 'run-tests')], 'toolUse'), response('Tests passed')]
  const { agent, model } = await agentFixture(t, script, { mode: 'auto' })
  await agent.enqueue('Implement addition and test it')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests[2].messages.at(-1).isError, false)
  assert.match(model.requests[2].messages.at(-1).content[0].text, /pass 1/)
})
