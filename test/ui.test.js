import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalApp } from '../src/ui/app.js'
import { safeText } from '../src/ui/theme.js'
import { parseOptions } from '../src/cli.js'
import { agentFixture, call, deferred, fixture, response } from './helpers.js'

// FakeTerminal drives the production renderer while retaining its screen output for assertions.
class FakeTerminal {
  columns = 80
  rows = 24
  output = ''
  start (input, resize) { this.input = input; this.resize = resize }
  stop () { this.stopped = true }
  write (data) { this.output += data }
  moveBy () {}
  hideCursor () {}
  showCursor () {}
  clearLine () {}
  clearFromCursor () {}
  clearScreen () {}
}

test('production TUI renders CJK, streams, keeps its editor, and survives narrow resizing', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [response('完成检查')])
  const terminal = new FakeTerminal()
  const app = new TerminalApp({ cwd, session, model, mode: 'plan', terminal })
  app.bind(agent)
  agent.emit = event => app.event(event)
  t.after(() => app.tui.stop())
  app.start()
  await app.submit('检查代码')
  await agent.wait()
  await delay(40)
  assert.match(terminal.output, /LOOM CODE/)
  assert.match(app.tui.getScreenLines().join('\n'), /完成检查/)
  terminal.columns = 35
  terminal.rows = 12
  terminal.resize()
  await delay(40)
  assert.equal(app.tui.getScreenLines().length, 12)
  assert.ok(app.tui.getScreenLines().some(line => line.includes('Enter')))
})

test('approval defaults to deny and cancellation closes the focused overlay', async t => {
  const { cwd, session } = await fixture(t)
  const app = new TerminalApp({ cwd, session, model: { label: 'fake' }, mode: 'ask', terminal: new FakeTerminal() })
  t.after(() => app.tui.stop())
  const controller = new AbortController()
  const approval = app.approve({ call: call('shell'), effect: 'shell', args: { command: 'deploy' }, signal: controller.signal })
  assert.equal(app.tui.hasOverlay(), true)
  controller.abort()
  assert.equal(await approval, false)
  assert.equal(app.tui.hasOverlay(), false)
})

test('TUI editor submissions run through the real command and input admission path', async t => {
  const entered = deferred()
  const { cwd, session, model, agent } = await agentFixture(t, [() => { entered.resolve(); return response('Done') }])
  const app = new TerminalApp({ cwd, session, model, mode: 'plan', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.tui.stop())
  app.editor.onSubmit('Inspect')
  await entered.promise
  await app.commandTail
  await agent.wait()
  assert.equal(session.messages[0].content, 'Inspect')
  assert.equal(app.editor.getText(), '')
})

test('untrusted terminal escape sequences cannot become UI control codes', () => {
  assert.equal(safeText('\x1b[2Jhello\x1b]52;c;secret\x07\n世界'), 'hello\n世界')
})

test('slash permission commands update the runtime, prompt, tools, and header together', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const terminal = new FakeTerminal()
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal })
  app.bind(agent)
  agent.emit = event => app.event(event)
  t.after(() => app.tui.stop())
  app.start()
  await app.submit('/mode plan')
  assert.equal(agent.mode, 'plan')
  assert.equal(app.mode, 'plan')
  assert.equal(agent.dispatcher.declarations.some(tool => tool.name === 'write_file'), false)
  await app.submit('/permissions auto')
  assert.equal(agent.dispatcher.mode, 'auto')
  assert.match(agent.system, /Auto mode allows/)
  assert.ok(agent.dispatcher.declarations.some(tool => tool.name === 'write_file'))
  assert.equal(session.events.filter(event => event.type === 'permission.mode').length, 2)
  const selection = app.submit('/mode')
  assert.equal(app.tui.hasOverlay(), true)
  terminal.input('\x1b')
  await selection
  assert.equal(agent.mode, 'auto')
  assert.equal(app.tui.hasOverlay(), false)
})

test('CLI validates budgets, modes, and non-default providers', () => {
  assert.throws(() => parseOptions(['--steps', 'NaN']), /integer/)
  assert.throws(() => parseOptions(['--mode', 'unsafe']), /mode/)
  assert.throws(() => parseOptions(['--provider', 'google']), /Specify --model/)
  assert.equal(parseOptions(['--demo', '--mode', 'plan']).demo, true)
})
