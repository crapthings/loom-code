import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalApp } from '../src/ui/app.js'
import { safeText } from '../src/ui/theme.js'
import { parseOptions } from '../src/cli.js'
import { catalogs, translate } from '../src/ui/i18n.js'
import { LanguagePreferences } from '../src/ui/preferences.js'
import path from 'node:path'
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

test('approval stays centered on wide screens and keeps choices visible for long arguments after resizing', async t => {
  const { cwd, session } = await fixture(t)
  const terminal = new FakeTerminal()
  terminal.columns = 240
  terminal.rows = 60
  const app = new TerminalApp({ cwd, session, model: { label: 'fake' }, mode: 'ask', terminal })
  t.after(() => app.tui.stop())
  app.bind({ blocked: false, executor: { label: 'Seatbelt · network denied' } })
  app.start()
  app.add('Code', 'const background = true\n'.repeat(80))
  const approval = app.approve({ call: call('shell'), effect: 'shell', args: { command: 'long command '.repeat(200) }, signal: new AbortController().signal })
  await delay(40)
  let screen = app.tui.getScreenLines().map(safeText)
  const top = screen.find(line => line.includes('┌'))
  assert.equal(top.indexOf('┌'), 76)
  assert.equal(top.indexOf('┐') - top.indexOf('┌'), 87)
  assert.ok(screen.some(line => line.includes('Deny')))
  assert.ok(screen.some(line => line.includes('Allow once')))
  assert.ok(screen.some(line => line.includes('Allow for this session')))
  assert.ok(app.tui.getScreenLines().some(line => line.includes('\x1b[48;5;236m')))
  terminal.columns = 35
  terminal.rows = 12
  terminal.resize()
  await delay(40)
  screen = app.tui.getScreenLines().map(safeText)
  assert.equal(screen.length, 12)
  assert.ok(screen.some(line => line.includes('Deny')))
  assert.ok(screen.some(line => line.includes('Allow once')))
  assert.ok(screen.some(line => line.includes('Allow for this session')))
  assert.ok(screen.some(line => line.includes('Enter')))
  assert.ok(screen.some(line => line.includes('└')))
  terminal.input('\x1b[B')
  terminal.input('\r')
  assert.equal(await approval, true)
  assert.equal(app.tui.hasOverlay(), false)
  const remembered = app.approve({ call: call('shell'), effect: 'shell', args: { command: 'test' }, signal: new AbortController().signal })
  terminal.input('\x1b[B')
  terminal.input('\x1b[B')
  terminal.input('\r')
  assert.equal(await remembered, 'session')
  const denied = app.approve({ call: call('shell'), effect: 'shell', args: { command: 'test' }, signal: new AbortController().signal })
  terminal.input('\r')
  assert.equal(await denied, false)
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

test('language commands persist preferences and refresh live controls without changing permissions or conversation content', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const preferences = new LanguagePreferences(path.join(cwd, 'user-settings', 'settings.json'))
  assert.equal(await preferences.load(), 'en')
  const terminal = new FakeTerminal()
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal, saveLanguage: language => preferences.save(language) })
  app.bind(agent)
  t.after(() => app.tui.stop())
  app.start()
  const original = app.add('Original', 'User content stays English 中文')
  const before = original.render(80)
  agent.dispatcher.sessionGrants.add('shell')
  app.event({ type: 'tool.progress', kind: 'process.started', boundary: 'Seatbelt · network denied', pid: 42 })
  await app.submit('/language zh-CN')
  assert.equal(app.language, 'zh-CN')
  assert.equal(await new LanguagePreferences(preferences.file).load(), 'zh-CN')
  assert.equal(agent.mode, 'ask')
  assert.equal(agent.dispatcher.sessionGrants.has('shell'), true)
  assert.equal(model.requests.length, 0)
  assert.deepEqual(original.render(80), before)
  assert.match(safeText(app.header.render(80).join('\n')), /逐次询问.*强制沙箱/)
  assert.match(safeText(app.footer.render(80).join('\n')), /进程 42 已启动/)
  assert.match(app.commandList().find(command => command.name === 'language').description, /界面语言/)
  const controller = new AbortController()
  const approval = app.approve({ call: call('shell'), effect: 'shell', args: { command: 'test' }, signal: controller.signal })
  await delay(40)
  const screen = app.tui.getScreenLines().map(safeText).join('\n')
  assert.match(screen, /批准命令/)
  assert.match(screen, /本次会话允许/)
  assert.match(screen, /允许一次/)
  controller.abort()
  assert.equal(await approval, false)
  const cancelled = app.submit('/language')
  terminal.input('\x1b')
  await cancelled
  assert.equal(app.language, 'zh-CN')
  const selected = app.submit('/language')
  terminal.input('\x1b[A')
  terminal.input('\r')
  await selected
  assert.equal(app.language, 'en')
  assert.equal(await preferences.load(), 'en')
  assert.match(safeText(app.footer.render(80).join('\n')), /process 42 started/)
  await assert.rejects(app.submit('/lang unknown'), /Unsupported language/)
  assert.equal(app.language, 'en')
  await app.submit('/lang zh-CN')
  assert.equal(app.language, 'zh-CN')
})

test('language save failures leave the current UI unchanged and catalogs preserve all message placeholders', async t => {
  const { cwd, session } = await fixture(t)
  const app = new TerminalApp({ cwd, session, model: { label: 'fake' }, mode: 'ask', saveLanguage: async () => { throw new Error('Cannot save settings') }, terminal: new FakeTerminal() })
  t.after(() => app.tui.stop())
  await assert.rejects(app.submit('/language zh-CN'), /Cannot save settings/)
  assert.equal(app.language, 'en')
  assert.deepEqual(Object.keys(catalogs.en).sort(), Object.keys(catalogs['zh-CN']).sort())
  for (const key of Object.keys(catalogs.en)) {
    const placeholders = text => [...text.matchAll(/\{([\w-]+)\}/g)].map(match => match[1]).sort()
    assert.deepEqual(placeholders(catalogs.en[key]), placeholders(catalogs['zh-CN'][key]), key)
  }
  assert.match(translate('zh-CN', 'grant.notice', { tool: '$&' }), /\$&/)
  assert.throws(() => translate('de', 'approval.deny'), /Unsupported/)
})

test('slash permission commands update the runtime, prompt, tools, and header together', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const terminal = new FakeTerminal()
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal })
  app.bind(agent)
  agent.emit = event => app.event(event)
  t.after(() => app.tui.stop())
  app.start()
  agent.dispatcher.sessionGrants.add('shell')
  await app.submit('/mode plan')
  assert.equal(agent.dispatcher.sessionGrants.size, 0)
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
  assert.equal(parseOptions(['--mode', 'auto']).sandbox, 'required')
  assert.equal(parseOptions(['--sandbox', 'off']).sandbox, 'off')
  assert.throws(() => parseOptions(['--sandbox', 'best-effort']), /sandbox/)
})
