import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { TerminalApp } from '../src/ui/app.js'
import { safeText } from '../src/ui/theme.js'
import { parseOptions } from '../src/cli.js'
import { catalogs, translate } from '../src/ui/i18n.js'
import { LanguagePreferences } from '../src/ui/preferences.js'
import { selectSession } from '../src/ui/session-picker.js'
import { writeFile, symlink } from 'node:fs/promises'
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

test('streaming updates the message without rebuilding header or completion and final output settles transient state', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.tui.stop())
  let headers = 0
  let completions = 0
  const setHeader = app.header.setText.bind(app.header)
  const setAutocomplete = app.editor.setAutocompleteProvider.bind(app.editor)
  app.header.setText = text => { headers++; setHeader(text) }
  app.editor.setAutocompleteProvider = provider => { completions++; setAutocomplete(provider) }
  app.event({ type: 'queued', inputId: 'input', text: 'task', delivery: 'steer' })
  app.event({ type: 'user', inputId: 'input', text: 'task' })
  app.event({ type: 'assistant.start', stepId: 'stream' })
  app.event({ type: 'assistant.delta', stepId: 'stream', text: 'partial ' })
  app.event({ type: 'assistant.delta', stepId: 'stream', text: 'response' })
  assert.equal(app.store.getState().streams.get('stream'), 'partial response')
  assert.match(app.transcript.render(80).join('\n'), /partial response/)
  assert.equal(headers, 0)
  assert.equal(completions, 0)
  app.event({ type: 'assistant.end', stepId: 'stream', response: response('Final response') })
  assert.match(app.transcript.render(80).join('\n'), /Final response/)
  assert.equal(app.store.getState().streams.size, 0)
  assert.equal(app.store.getState().queued.size, 0)
  assert.equal(app.streamComponents.size, 0)
  await app.submit('/language zh-CN')
  assert.equal(headers, 1)
  assert.equal(completions, 1)
  await app.shutdown()
  app.store.dispatch({ type: 'ui.language', language: 'en' })
  assert.equal(headers, 1)
})

test('untrusted terminal escape sequences cannot become UI control codes', () => {
  assert.equal(safeText('\x1b[2Jhello\x1b]52;c;secret\x07\n世界'), 'hello\n世界')
})

test('progress reviews display their cause without opening approval or marking the task complete', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const terminal = new FakeTerminal()
  const app = new TerminalApp({ cwd, session, model, mode: 'plan', language: 'zh-CN', terminal })
  app.bind(agent)
  t.after(() => app.shutdown())
  app.start()
  app.event({ type: 'status', text: 'running' })
  app.event({ type: 'progress.review', reasons: ['history_only', 'empty_searches'], rounds: 6 })
  assert.match(app.transcript.render(80).join('\n'), /只查询了历史记录/)
  assert.match(app.transcript.render(80).join('\n'), /均无匹配/)
  assert.match(app.transcript.render(80).join('\n'), /任务继续运行/)
  assert.equal(app.store.getState().status, 'running')
  assert.equal(app.tui.hasOverlay(), false)
  app.event({ type: 'assistant.start', stepId: 'review' })
  terminal.columns = 35
  terminal.rows = 12
  terminal.resize()
  await delay(40)
  assert.equal(app.tui.getScreenLines().length, 12)
  assert.match(app.activityLine.render(80).join('\n'), /等待模型响应/)
})

test('independent assessment shows a live phase, concrete direction, configured model, and decision cost', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  agent.progressModel = { label: 'fake/progress' }
  agent.budget = { calls: 12, tokens: 1500, cost: 0.01, decisionCalls: 1, decisionCost: 0.00001 }
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', language: 'zh-CN', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.shutdown())
  app.start()
  assert.match(app.transcript.render(100).join('\n'), /fake\/progress/)
  app.event({ type: 'status', text: 'running' })
  app.event({ type: 'progress.assessment.start' })
  assert.match(app.activityLine.render(100).join('\n'), /正在评估任务进展/)
  app.event({ type: 'progress.assessment.end', status: 'completed', verdict: 'stalled', action: 'implement', budget: agent.budget })
  assert.match(app.transcript.render(100).join('\n'), /实施有依据的小范围修改/)
  assert.equal(app.store.getState().activity.phase, 'running')
  app.showStatus()
  assert.match(app.transcript.render(100).join('\n'), /决策调用：1/)
  assert.match(app.transcript.render(100).join('\n'), /\$0\.000010/)
  assert.equal(app.tui.hasOverlay(), false)
})

test('slash command registry keeps help and aliases aligned and validates arguments before effects', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.tui.stop())
  const inputs = []
  let stops = 0
  agent.enqueue = async (text, delivery) => inputs.push({ text, delivery })
  agent.interrupt = () => stops++
  await app.submit('/queue\tfirst line\nsecond line')
  await app.submit(' ordinary task ')
  assert.deepEqual(inputs, [{ text: 'first line\nsecond line', delivery: 'queue' }, { text: 'ordinary task', delivery: undefined }])
  await assert.rejects(app.submit('/queue'), /Invalid arguments/)
  await assert.rejects(app.submit('/stop unwanted'), /Invalid arguments/)
  for (const name of ['missing', 'toString', 'constructor', '__proto__']) {
    await assert.rejects(app.submit(`/${name}`), /Unknown command/)
  }
  assert.equal(stops, 0)
  assert.equal(inputs.length, 2)
  await app.submit('/stop')
  assert.equal(stops, 1)
  await app.submit('/help')
  const help = app.transcript.render(120).join('\n')
  for (const command of app.commandList()) assert.ok(help.includes(`/${command.name} —`))
  await app.submit('/permissions plan')
  assert.equal(agent.mode, 'plan')
  await app.submit('/lang zh-CN')
  assert.equal(app.language, 'zh-CN')
  await assert.rejects(app.submit('/stop unwanted'), /参数不正确/)
  assert.equal(model.requests.length, 0)
})

test('startup session picker excludes busy sessions and restores terminal on selection and cancellation', async () => {
  const terminal = new FakeTerminal()
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `session-${i}`, title: `Task ${i}`, updated: Date.now(), status: 'completed', pending: 0, busy: i === 0 }))
  const selected = selectSession(sessions, { language: 'zh-CN', terminal })
  await delay(40)
  assert.match(safeText(terminal.output), /打开历史会话/)
  terminal.columns = 35
  terminal.rows = 12
  terminal.resize()
  await delay(40)
  terminal.input('\r')
  assert.equal(await selected, 'session-1')
  assert.equal(terminal.stopped, true)
  const cancelled = selectSession(sessions, { terminal })
  terminal.input('\x1b')
  assert.equal(await cancelled, undefined)
  const interrupted = selectSession(sessions, { terminal })
  terminal.input('\x03')
  assert.equal(await interrupted, undefined)
  assert.equal(await selectSession(sessions.map(session => ({ ...session, busy: true })), { terminal }), undefined)
})

test('status reports localized context estimates without making model calls', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.tui.stop())
  await app.submit('/status')
  assert.match(app.transcript.render(100).join('\n'), /Estimated input/)
  assert.match(app.transcript.render(100).join('\n'), /output reserve/)
  await app.submit('/language zh-CN')
  await app.submit('/status')
  assert.match(app.transcript.render(100).join('\n'), /估计输入/)
  assert.equal(model.requests.length, 0)
})

test('continue explains empty recovery in the selected UI language without calling the model', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', language: 'zh-CN', terminal: new FakeTerminal() })
  app.bind(agent)
  agent.emit = event => app.event(event)
  t.after(() => app.tui.stop())
  await app.submit('/continue')
  assert.match(app.transcript.render(80).join('\n'), /没有待恢复的任务/)
  assert.equal(model.requests.length, 0)
  assert.equal(session.pending.length, 0)
})

test('shutdown prevents delayed language saves, engine events, and queued commands from reviving the UI', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const saving = deferred()
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal: new FakeTerminal(), saveLanguage: () => saving.promise })
  app.bind(agent)
  const switching = app.submit('/language zh-CN')
  await app.shutdown()
  const closed = app.store.getState()
  const transcript = app.transcript.render(80)
  saving.resolve()
  await switching
  app.event({ type: 'assistant.start', stepId: 'late' })
  app.event({ type: 'queued', inputId: 'late', text: 'late task' })
  await app.submit('late task')
  assert.equal(await app.approve({ signal: new AbortController().signal }), false)
  assert.equal(app.store.getState(), closed)
  assert.deepEqual(app.transcript.render(80), transcript)
  assert.equal(app.language, 'en')
  assert.equal(app.streamComponents.size, 0)
  assert.equal(session.pending.length, 0)
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

test('settings reads reject oversized files and final symlinks', async t => {
  const { cwd } = await fixture(t)
  const file = path.join(cwd, 'settings.json')
  await writeFile(file, ' '.repeat(64 * 1024 + 1))
  const preferences = new LanguagePreferences(file)
  await assert.rejects(preferences.load(), error => error.cause?.code === 'LOOM_TEXT_LIMIT')
  const linked = path.join(cwd, 'linked-settings.json')
  await symlink(file, linked)
  await assert.rejects(new LanguagePreferences(linked).load(), error => error.cause?.code === 'ELOOP')
})

test('approval cancelled during overlay creation closes without waiting for keyboard input', async t => {
  const { cwd, session, model, agent } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.shutdown())
  const controller = new AbortController()
  const showDialog = app.showDialog.bind(app)
  app.showDialog = (...args) => {
    const overlay = showDialog(...args)
    controller.abort()
    return overlay
  }
  assert.equal(await app.approve({ call: call('shell'), effect: 'shell', args: {}, signal: controller.signal }), false)
  assert.equal(app.tui.hasOverlay(), false)
  assert.equal(app.store.getState().dialogs.length, 0)
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

test('CLI validates budgets, modes, and rejects provider selection', () => {
  assert.equal(parseOptions([], {}).steps, Infinity)
  assert.equal(parseOptions(['--steps', '100'], {}).steps, 100)
  for (const steps of ['0', '501', 'Infinity']) assert.throws(() => parseOptions(['--steps', steps], {}), /integer/)
  assert.throws(() => parseOptions(['--steps', 'NaN']), /integer/)
  assert.throws(() => parseOptions(['--mode', 'unsafe']), /mode/)
  assert.throws(() => parseOptions(['--provider', 'google']), /Unknown option/)
  assert.throws(() => parseOptions(['--demo']), /Unknown option/)
  assert.equal(parseOptions(['--mode', 'auto']).sandbox, 'required')
  assert.equal(parseOptions(['--sandbox', 'off']).sandbox, 'off')
  assert.throws(() => parseOptions(['--sandbox', 'best-effort']), /sandbox/)
})

test('memory command renders localized empty state through the dispatcher without calling the model', async t => {
  const { cwd, session, agent, model } = await agentFixture(t, [])
  try {
    for (const language of ['en', 'zh-CN']) {
      const app = new TerminalApp({ cwd, session, model: model.label, mode: 'ask', language, terminal: new FakeTerminal() })
      app.bind(agent)
      await app.submit('/memory')
      assert.match(app.transcript.render(100).join('\n'), language === 'en' ? /No project memories saved/ : /尚未保存项目记忆/)
      app.unsubscribe()
      app.tui.stop()
    }
    assert.equal(model.requests.length, 0)
  } finally { await agent.close() }
})

test('live activity and tool cards show progress, results, and child completion without stale indicators', async t => {
  const { cwd, session, agent, model } = await agentFixture(t, [])
  const terminal = new FakeTerminal()
  const app = new TerminalApp({ cwd, session, model, mode: 'ask', language: 'zh-CN', terminal })
  app.bind(agent)
  t.after(() => app.shutdown())
  app.start()
  app.event({ type: 'status', text: 'running' })
  app.event({ type: 'assistant.start', stepId: 'one' })
  assert.match(safeText(app.activityLine.render(120).join('\n')), /等待模型响应/)
  app.store.dispatch({ type: 'ui.dialog.opened', dialog: { id: 'approval', kind: 'approval' } })
  assert.match(safeText(app.activityLine.render(120).join('\n')), /等待批准/)
  app.store.dispatch({ type: 'ui.dialog.closed', id: 'approval' })
  assert.match(safeText(app.activityLine.render(120).join('\n')), /等待模型响应/)
  app.event({ type: 'assistant.end', stepId: 'one', response: response('Checking') })
  const tool = call('shell', { command: 'test' }, 'live')
  app.event({ type: 'tool.start', call: tool })
  const component = app.toolComponents.get('root:live').component
  app.event({ type: 'tool.progress', callId: 'live', kind: 'process.output', text: 'partial output\x1b[2J' })
  assert.match(safeText(component.render(120).join('\n')), /partial output/)
  app.event({ type: 'tool.end', call: tool, status: 'completed', result: { isError: false, text: `exit: 0\n${'x'.repeat(4000)}\nFINAL RESULT` } })
  const rendered = safeText(component.render(120).join('\n'))
  assert.match(rendered, /✓ shell · 工具完成/)
  assert.match(rendered, /exit: 0/)
  assert.match(rendered, /FINAL RESULT/)
  assert.equal(app.toolComponents.size, 0)
  const computer = call('computer_press_key', { key: 'Space' }, 'desktop')
  app.event({ type: 'tool.start', call: computer })
  const desktop = app.toolComponents.get('root:desktop').component
  app.event({ type: 'tool.progress', callId: 'desktop', kind: 'computer.progress', text: 'Waiting for desktop result' })
  assert.match(safeText(desktop.render(120).join('\n')), /Waiting for desktop result/)
  app.event({ type: 'tool.end', call: computer, status: 'unknown', result: { isError: true, text: 'Disconnected; inspect before retrying.' } })
  assert.match(safeText(desktop.render(120).join('\n')), /结果未知/)
  assert.equal(app.toolComponents.size, 0)
  app.event({ type: 'assistant.start', stepId: 'two' })
  assert.match(safeText(app.activityLine.render(120).join('\n')), /等待模型响应/)
  const child = { child: 'child-session', role: 'explore' }
  app.event({ ...child, type: 'tool.start', call: tool })
  app.event({ ...child, type: 'tool.end', call: tool, status: 'cancelled', result: { isError: true, text: 'cancelled' } })
  assert.match(safeText(app.transcript.render(120).join('\n')), /explore · child-se · shell · 工具已取消/)
  terminal.columns = 35
  terminal.rows = 12
  terminal.resize()
  await delay(30)
  assert.equal(app.tui.getScreenLines().length, 12)
  app.event({ type: 'status', text: 'idle' })
  assert.equal(safeText(app.activityLine.render(120).join('\n')).trim(), '')
  await app.shutdown()
  app.event({ type: 'tool.progress', callId: 'live', kind: 'process.output', text: 'late' })
  assert.equal(app.toolComponents.size, 0)
})

test('computer blockers display OS recovery steps in errors and status without opening an approval dialog', async t => {
  const { cwd, session, agent, model } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'auto', language: 'zh-CN', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.shutdown())
  agent.computer = { blocker: { code: 'permissions_pending' }, close: async () => {} }
  app.event({ type: 'error', text: 'Driver permissions pending' })
  app.showStatus()
  const text = safeText(app.transcript.render(160).join('\n'))
  assert.equal(text.match(/电脑权限暂未就绪/g)?.length, 2)
  assert.match(text, /permissions_pending/)
  assert.match(text, /cua-driver permissions grant/)
  assert.match(text, /continue/)
  assert.equal(app.tui.hasOverlay(), false)
  assert.equal(model.requests.length, 0)
})

test('background shell cards and live rows distinguish running work from completed commands', async t => {
  const { cwd, session, agent, model } = await agentFixture(t, [])
  const app = new TerminalApp({ cwd, session, model, mode: 'auto', language: 'zh-CN', terminal: new FakeTerminal() })
  app.bind(agent)
  t.after(() => app.shutdown())
  app.start()
  const tool = call('shell', { command: 'pnpm build' }, 'launch')
  const process = { id: 'p-123456abcdef', callId: 'launch', command: 'pnpm build', status: 'running', started: Date.now() - 2000, artifact: 'output.txt' }
  app.event({ type: 'status', text: 'running' })
  app.event({ type: 'tool.start', call: tool })
  const card = app.toolComponents.get('root:launch').component
  app.event({ type: 'process.state', process, text: 'compiling' })
  app.event({ type: 'tool.end', call: tool, status: 'running', result: { isError: false, text: 'still running' } })
  assert.match(safeText(card.render(120).join('\n')), /已转后台运行/)
  assert.doesNotMatch(safeText(card.render(120).join('\n')), /✓/)
  app.event({ type: 'status', text: 'waiting for processes' })
  const live = safeText(app.activityLine.render(160).join('\n'))
  assert.match(live, /不调用模型/)
  assert.match(live, /pnpm build/)
  assert.match(live, /stop ID/)
  app.event({ type: 'process.state', process: { ...process, status: 'completed', finished: Date.now(), exitCode: 0 }, text: 'BUILD FINISHED' })
  app.event({ type: 'status', text: 'idle' })
  assert.equal(safeText(app.activityLine.render(160).join('\n')).trim(), '')
  assert.match(safeText(app.transcript.render(160).join('\n')), /BUILD FINISHED/)
})
