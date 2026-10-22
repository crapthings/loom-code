import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ProcessManager } from '../src/execution/processes.js'
import { ShellExecutor } from '../src/execution/executor.js'
import { Dispatcher, createTools, workspaceObserver } from '../src/tools/dispatcher.js'
import { Agent } from '../src/core/agent.js'
import { fixture, call, response, fakeModel, deferred } from './helpers.js'

// command quotes a local fixture program without interpreting its contents in the shell.
function command (source) {
  return `node -e '${source.replaceAll("'", "'\\''")}'`
}

// gatedCommand waits for a test-owned file before producing a visible artifact and exiting.
const gatedCommand = command('const fs=require("node:fs");console.log("READY");const timer=setInterval(()=>{if(fs.existsSync("release")){clearInterval(timer);fs.writeFileSync("built.txt","built");console.log("BUILD FINISHED")}},10)')

// processFixture closes every owned process before releasing its temporary journal and workspace.
async function processFixture (t, options = {}) {
  const cleanups = []
  const { cwd, session } = await fixture({ after: fn => cleanups.push(fn) })
  const executor = new ShellExecutor({ cwd, sandbox: options.sandbox || 'off' })
  const processes = new ProcessManager({ cwd, session, executor })
  const ready = deferred()
  const events = []
  const dispatcher = new Dispatcher({
    session,
    tools: createTools({ cwd, session, executor, processes }),
    mode: options.mode || 'auto',
    approve: options.approve,
    observer: workspaceObserver(cwd),
    emit: event => {
      events.push(event)
      if (event.kind === 'process.output' && event.text.includes('READY')) ready.resolve()
    }
  })
  t.after(async () => { await processes.close(); for (const cleanup of cleanups.reverse()) await cleanup() })
  return { cwd, session, processes, dispatcher, ready, events }
}

test('yielded shell commands retain output and full-lifetime workspace evidence behind dispatcher controls', { timeout: 10000 }, async t => {
  let approvals = 0
  const { cwd, session, processes, dispatcher, ready } = await processFixture(t, { mode: 'edit', approve: async () => { approvals++; return true } })
  const signal = new AbortController().signal
  const launch = await dispatcher.run(call('shell', { command: gatedCommand, yield_time_ms: 0 }), signal)
  assert.equal(launch.isError, false)
  const started = session.latestEvent('process.started')
  const id = started.process.id
  assert.equal(session.latestEvent('tool.finished').status, 'running')
  assert.ok(session.latestEvent('tool.started').seq < started.seq)
  await ready.promise
  const status = await dispatcher.run(call('process_status', { id }, 'status'), signal)
  assert.match(status.content[0].text, /READY/)
  assert.equal(approvals, 1)
  await writeFile(path.join(cwd, 'release'), 'go')
  const finished = await dispatcher.run(call('process_wait', { id, yield_time_ms: 10000 }, 'wait'), signal)
  assert.equal(finished.isError, false, finished.content[0].text)
  assert.match(finished.content[0].text, /BUILD FINISHED/)
  assert.equal(await readFile(path.join(cwd, 'built.txt'), 'utf8'), 'built')
  assert.ok(session.latestEvent('process.finished').changes.files.some(file => file.path === 'built.txt'))
  assert.match(await readFile(path.join(session.directory, started.process.artifact), 'utf8'), /BUILD FINISHED/)
  assert.equal(processes.active.length, 0)
  assert.equal(await processes.deliver(), 0)
  assert.equal(approvals, 1)
})

test('a parent that exits with inherited output pipes settles without waiting for the execution deadline', { timeout: 10000 }, async t => {
  const { session, dispatcher } = await processFixture(t)
  const start = Date.now()
  const result = await dispatcher.run(call('shell', { command: "sleep 60 & printf 'parent exited\\n'", timeout: 5, yield_time_ms: 10000 }), new AbortController().signal)
  assert.equal(result.isError, false, result.content[0].text)
  assert.match(result.content[0].text, /parent exited/)
  assert.equal(session.latestEvent('process.finished').status, 'completed')
  assert.ok(Date.now() - start < 4000, 'inherited pipe kept the tool waiting')
})

test('stopping one owned process requires no second approval and cannot address arbitrary PIDs', { timeout: 10000 }, async t => {
  let approvals = 0
  const { session, dispatcher, ready, processes } = await processFixture(t, { mode: 'edit', approve: async () => { approvals++; return true } })
  const signal = new AbortController().signal
  await dispatcher.run(call('shell', { command: gatedCommand, yield_time_ms: 0 }), signal)
  await ready.promise
  const id = session.latestEvent('process.started').process.id
  const foreign = await dispatcher.run(call('process_stop', { id: '123' }, 'foreign'), signal)
  assert.equal(foreign.isError, true)
  assert.equal(processes.active.length, 1)
  const result = await dispatcher.run(call('process_stop', { id }, 'stop'), signal)
  assert.equal(result.isError, true)
  assert.equal(session.latestEvent('process.finished').status, 'cancelled')
  assert.equal(approvals, 1)
  assert.equal(session.events.filter(event => event.type === 'process.finished').length, 1)
})

test('explicit execution deadlines survive an early tool return and settle exactly once', { timeout: 10000 }, async t => {
  const { session, processes, dispatcher, ready } = await processFixture(t)
  await dispatcher.run(call('shell', { command: gatedCommand, timeout: 1, yield_time_ms: 0 }), new AbortController().signal)
  await ready.promise
  const job = processes.get(session.latestEvent('process.started').process.id)
  await job.done
  assert.equal(job.result.process.status, 'timeout')
  assert.equal(job.result.isError, true)
  assert.equal(session.events.filter(event => event.type === 'process.finished').length, 1)
})

test('native sandbox managers allow independent commands while preserving the first command isolation', { timeout: 15000 }, async t => {
  const { cwd, session, dispatcher, processes, ready } = await processFixture(t, { sandbox: 'required' })
  const signal = new AbortController().signal
  await dispatcher.run(call('shell', { command: gatedCommand, yield_time_ms: 0 }, 'first'), signal)
  const id = session.latestEvent('process.started').process.id
  await ready.promise
  const second = await dispatcher.run(call('shell', { command: command('console.log(process.env.pnpm_config_pm_on_fail);require("node:fs").writeFileSync(process.env.TMPDIR+"/probe","ok")'), yield_time_ms: 10000 }, 'second'), signal)
  assert.equal(second.isError, false, second.content[0].text)
  assert.match(second.content[0].text, /\nerror\n/)
  assert.equal(processes.get(id).result, undefined)
  await writeFile(path.join(cwd, 'release'), 'go')
  const result = await dispatcher.run(call('process_wait', { id, yield_time_ms: 10000 }, 'wait'), signal)
  assert.equal(result.isError, false, result.content[0].text)
  assert.equal(await readFile(path.join(cwd, 'built.txt'), 'utf8'), 'built')
})

// backgroundAgent starts a fake-provider run that yields one gated command and then waits for its result.
async function backgroundAgent (t, final = request => {
  assert.ok(request.messages.some(message => typeof message.content === 'string' && message.content.includes('BUILD FINISHED')))
  return response('Verified the completed command')
}) {
  const cleanups = []
  const { cwd, session } = await fixture({ after: fn => cleanups.push(fn) })
  const waiting = deferred()
  const events = []
  const model = fakeModel([response([call('shell', { command: gatedCommand, yield_time_ms: 0 })], 'toolUse'), response('Waiting for the build result'), final])
  const agent = new Agent({
    cwd,
    session,
    model,
    mode: 'auto',
    sandbox: 'off',
    emit: event => {
      events.push(event)
      if (event.type === 'status' && event.text === 'waiting for processes') waiting.resolve()
    }
  })
  t.after(async () => { await agent.close(); for (const cleanup of cleanups.reverse()) await cleanup() })
  await agent.initialize()
  await agent.enqueue('Build the temporary fixture')
  await waiting.promise
  return { cwd, session, model, agent, events }
}

test('the harness waits without model polling and resumes automatically before completing the task', { timeout: 10000 }, async t => {
  const { cwd, session, model, agent } = await backgroundAgent(t)
  assert.equal(model.requests.length, 2)
  assert.equal(session.latestEvent('task.finished'), undefined)
  const count = session.messages.length
  await agent.inspectProcesses()
  assert.equal(session.messages.length, count, 'a UI control fabricated an unpaired model message')
  await writeFile(path.join(cwd, 'release'), 'go')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 3)
  assert.equal(session.events.filter(event => event.type === 'process.delivered').length, 1)
  assert.ok(session.latestEvent('process.finished').seq < session.latestEvent('task.finished').seq)
})

test('interrupting an event wait stops all processes before the run settles', { timeout: 10000 }, async t => {
  const { session, model, agent } = await backgroundAgent(t)
  agent.interrupt()
  await agent.wait()
  assert.equal(agent.status, 'interrupted')
  assert.equal(model.requests.length, 2)
  assert.equal(agent.processes.active.length, 0)
  assert.equal(session.latestEvent('process.finished').status, 'cancelled')
  assert.ok(session.latestEvent('process.finished').seq < session.latestEvent('run.finished').seq)
  assert.equal(session.latestEvent('task.finished'), undefined)
})

test('user steering wakes an event wait and process controls do not consume its completion notification', { timeout: 10000 }, async t => {
  const { session, model, agent } = await backgroundAgent(t, request => {
    assert.ok(request.messages.some(message => message.content === 'Stop the build'))
    return response('Waiting for the cancellation result')
  })
  model.complete = async request => {
    model.requests.push(structuredClone(request))
    if (model.requests.length === 3) return response('Waiting for the cancellation result')
    assert.ok(request.messages.some(message => typeof message.content === 'string' && message.content.includes('status: cancelled')))
    return response('Build stopped')
  }
  const nextWait = deferred()
  const emit = agent.emit
  agent.emit = event => { emit(event); if (event.type === 'status' && event.text === 'waiting for processes') nextWait.resolve() }
  await agent.enqueue('Stop the build')
  await nextWait.promise
  const id = session.latestEvent('process.started').process.id
  await agent.inspectProcesses(id)
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(model.requests.length, 4)
  assert.equal(session.latestEvent('process.finished').status, 'cancelled')
  assert.equal(session.latestEvent('tool.finished').source, 'process-control')
})

test('restart marks yielded processes unknown and never replays them or duplicates completion delivery', async t => {
  const { session } = await fixture(t)
  const process = { id: 'p-123456abcdef', command: 'external side effect', callId: 'launch', status: 'running', artifact: 'stored.txt' }
  await session.append('process.started', { process })
  await session.append('tool.finished', { callId: 'launch', process, status: 'running' })
  assert.equal(await session.recover(), true)
  assert.equal(session.latestEvent('process.finished').status, 'unknown')
  assert.match(session.latestEvent('process.delivered').message.content, /not replayed/)
  await session.recover()
  assert.equal(session.events.filter(event => event.type === 'process.finished').length, 1)
  assert.equal(session.events.filter(event => event.type === 'process.delivered').length, 1)
})

test('restart delivers a durably completed background result that had not reached the model', async t => {
  const { session } = await fixture(t)
  const process = { id: 'p-123456abcdef', command: 'fixture', callId: 'launch', status: 'running' }
  await session.append('process.started', { process })
  await session.append('tool.finished', { callId: 'launch', process, status: 'running' })
  await session.append('process.finished', { process: { ...process, status: 'completed' }, status: 'completed', text: 'Confirmed result' })
  assert.equal(await session.recover(), false)
  assert.match(session.latestEvent('process.delivered').message.content, /Confirmed result/)
  await session.recover()
  assert.equal(session.events.filter(event => event.type === 'process.delivered').length, 1)
})

test('loss of the harness IPC connection terminates its owned process group', { timeout: 10000 }, async t => {
  const { session, processes, dispatcher, ready } = await processFixture(t)
  await dispatcher.run(call('shell', { command: gatedCommand, yield_time_ms: 0 }), new AbortController().signal)
  await ready.promise
  const job = processes.get(session.latestEvent('process.started').process.id)
  job.child.disconnect()
  await job.done
  assert.equal(job.result.isError, true)
  assert.equal(processes.active.length, 0)
  assert.throws(() => process.kill(job.child.pid, 0), { code: 'ESRCH' })
})

test('denied launches create no process and launch failures still settle their durable intent', async t => {
  const { session, dispatcher, processes } = await processFixture(t, { mode: 'ask', approve: async () => false })
  await dispatcher.run(call('shell', { command: 'false' }), new AbortController().signal)
  assert.equal(session.latestEvent('process.started'), undefined)
  dispatcher.mode = 'auto'
  processes.executor.prepare = async () => { throw new Error('fixture preparation failed') }
  const result = await dispatcher.run(call('shell', { command: 'false', yield_time_ms: 10000 }, 'failed'), new AbortController().signal)
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /fixture preparation failed/)
  assert.equal(session.latestEvent('process.finished').status, 'failed')
  assert.equal(processes.active.length, 0)
})

test('losing sandbox ownership stops a background process instead of allowing it to hang', { timeout: 10000 }, async t => {
  const { session, processes, dispatcher, ready } = await processFixture(t)
  const prepare = processes.executor.prepare.bind(processes.executor)
  let fail
  processes.executor.prepare = async (...args) => ({ ...await prepare(...args), onFailure: watcher => { fail = watcher; return () => { fail = null } } })
  await dispatcher.run(call('shell', { command: gatedCommand, yield_time_ms: 0 }), new AbortController().signal)
  await ready.promise
  const job = processes.get(session.latestEvent('process.started').process.id)
  fail(new Error('Fixture sandbox lost'))
  await job.done
  assert.equal(job.result.process.status, 'sandbox lost')
  assert.match(job.result.text, /Fixture sandbox lost/)
  assert.equal(fail, null)
})
