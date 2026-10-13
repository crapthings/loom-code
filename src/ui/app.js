import { CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, ScrollView, SelectList, Text, TuiAltScreen, VStack, matchesKey } from '@earendil-works/pi-tui'
import { colors, editorTheme, markdownTheme, safeText, selectTheme } from './theme.js'
import { modes } from '../core/modes.js'
import { sandboxStatus } from '../execution/executor.js'
import { SelectionDialog, dialogOptions } from './dialog.js'

// commands describes the terminal commands offered by the editor's completion menu.
const commands = [
  { name: 'help', description: 'Show controls and commands' },
  { name: 'mode', description: 'Switch ask / edit / auto / plan permissions' },
  { name: 'permissions', description: 'Open the permission mode selector' },
  { name: 'sandbox', description: 'Show execution isolation and dependency status' },
  { name: 'queue', description: 'Queue a task after current work' },
  { name: 'stop', description: 'Interrupt current execution' },
  { name: 'continue', description: 'Resume after inspecting partial or unknown effects' },
  { name: 'compact', description: 'Compact earlier complete exchanges' },
  { name: 'undo', description: 'Restore the latest unchanged file checkpoint' },
  { name: 'status', description: 'Show session and budget' },
  { name: 'exit', description: 'Close the session safely' }
]

// TerminalApp presents a scrollable transcript, persistent editor, execution status, and cancellable approvals.
export class TerminalApp {
  constructor ({ cwd, session, model, mode, sandbox = 'required', terminal = new ProcessTerminal() }) {
    this.tui = new TuiAltScreen(terminal)
    this.transcript = new Container()
    this.streams = new Map()
    this.queued = new Map()
    this.commandTail = Promise.resolve()
    this.session = session
    this.model = model
    this.mode = mode
    this.sandbox = sandbox
    this.cwd = cwd
    this.header = new Text(`${colors.bold('LOOM CODE')}  ${colors.dim(model.label)}  ${colors.warning(mode)} · ${sandbox === 'off' ? colors.warning('UNSANDBOXED HOST') : 'sandbox required'}\n${colors.dim(cwd)}`, 1, 0)
    this.footer = new Text('', 1, 0)
    this.editor = new Editor(this.tui, editorTheme)
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, cwd))
    this.editor.onSubmit = text => {
      this.editor.setText('')
      this.editor.addToHistory(text)
      this.commandTail = this.commandTail.then(() => this.submit(text)).catch(error => this.add('Error', error.message))
    }
    this.tui.setLayoutRoot(new VStack([
      { component: this.header, basis: 'auto', shrink: 0 },
      { component: new ScrollView(this.transcript, { primary: true, follow: 'end' }), basis: 0, grow: 1, minSize: 1 },
      { component: this.editor, basis: 'auto', maxSize: 8, shrink: 0 },
      { component: this.footer, basis: 'auto', shrink: 0 }
    ]))
    this.tui.setFocus(this.editor)
    this.tui.addInputListener(data => {
      if (matchesKey(data, 'ctrl+c')) {
        if (this.agent?.running) this.agent.interrupt()
        else this.shutdown()
        return { consume: true }
      }
      if (matchesKey(data, 'escape') && this.agent?.running && !this.tui.hasOverlay()) {
        this.agent.interrupt()
        return { consume: true }
      }
    })
    this.refreshStatus('idle')
  }

  bind (agent) {
    this.agent = agent
  }

  start () {
    this.add('Welcome', 'Enter 发送修正或新任务 · /queue 排队 · Esc 停止 · Ctrl+C 空闲时退出\n/mode 切换权限 · /continue 恢复未完成任务 · /help 查看帮助')
    for (const message of this.session.messages) {
      if (message.role === 'user') this.add('You', message.content)
      if (message.role === 'assistant') this.add('Loom', message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
      if (message.role === 'toolResult') this.add(message.toolName, message.content[0]?.text || '')
    }
    if (this.agent.blocked) this.add('Recovery required', '发现结果未知的工具调用。检查工作区和日志后，用 /continue 明确恢复；不会自动重放副作用。')
    if (this.session.pending.length) this.add('Pending inputs', `${this.session.pending.length} 个持久化输入等待 /continue`)
    this.tui.start()
  }

  add (label, text) {
    const component = new Text(`${colors.accent(label)}\n${safeText(text)}`, 1, 1)
    this.transcript.addChild(component)
    this.tui.requestRender()
    return component
  }

  event (event) {
    if (event.child) {
      if (event.type === 'user') this.add(`${event.role} · ${event.child.slice(0, 8)}`, event.text)
      if (event.type === 'tool.start') this.add(`${event.role} tool`, event.call.name)
      if (event.type === 'error') this.add(`${event.role} error`, event.text)
      return
    }
    if (event.type === 'mode.changed') this.updateMode(event.mode)
    if (event.type === 'permission.granted') this.add('Permissions', `${event.tool} 已获本次运行授权，不再逐次询问；切换 /mode 或退出后失效，沙箱边界保持不变。`)
    if (event.type === 'queued') this.queued.set(event.inputId, this.add(`Pending · ${event.delivery}`, event.text))
    if (event.type === 'user') {
      const component = this.queued.get(event.inputId)
      if (component) { component.setText(`${colors.accent('You')}\n${safeText(event.text)}`); this.queued.delete(event.inputId) } else this.add('You', event.text)
    }
    if (event.type === 'assistant.start') {
      const component = new Markdown('', 1, 1, markdownTheme)
      this.transcript.addChild(component)
      this.streams.set(event.stepId, { component, text: '' })
    }
    if (event.type === 'assistant.delta') {
      const stream = this.streams.get(event.stepId)
      if (stream) { stream.text += event.text; stream.component.setText(safeText(stream.text)) }
    }
    if (event.type === 'assistant.end') {
      const stream = this.streams.get(event.stepId)
      stream?.component.setText(safeText(event.response.content.filter(part => part.type === 'text').map(part => part.text).join('\n')))
      this.streams.delete(event.stepId)
      this.refreshStatus(this.agent.status, event.budget)
    }
    if (event.type === 'tool.start') this.add(`Tool · ${event.call.name}`, JSON.stringify(event.call.arguments))
    if (event.type === 'tool.end') this.add(event.result.isError ? 'Tool failed' : 'Tool completed', event.result.text.slice(0, 2500))
    if (event.type === 'tool.progress') this.refreshStatus(event.text)
    if (event.type === 'error') this.add('Execution stopped', `${event.text}\n用 /continue 恢复，或提交新的任务。`)
    if (event.type === 'status') this.refreshStatus(event.text, event.budget)
    this.tui.requestRender()
  }

  refreshStatus (status, budget = this.agent?.budget) {
    this.footer.setText(colors.dim(`${status} · session ${this.session.id.slice(0, 8)} · calls ${budget?.calls || 0} · tokens ${budget?.tokens || 0} · $${(budget?.cost || 0).toFixed(4)}\nEnter: steer · /queue: next task · Esc: interrupt · Ctrl+C: stop/exit`))
    this.tui.requestRender()
  }

  updateMode (mode) {
    this.mode = mode
    this.header.setText(`${colors.bold('LOOM CODE')}  ${colors.dim(this.model.label)}  ${colors.warning(`${mode} · ${modes[mode].label}`)} · sandbox ${this.sandbox}\n${colors.dim(this.cwd)}`)
    this.add('Permissions', `${mode} · ${modes[mode].description}`)
  }

  chooseMode () {
    if (this.agent.running) throw new Error('请先用 /stop 停止任务，或等待完成，再切换权限。')
    return new Promise(resolve => {
      const choices = new SelectList(Object.entries(modes).map(([value, mode]) => ({ value, label: `${value} · ${mode.label}`, description: mode.description })), 4, selectTheme)
      choices.setSelectedIndex(Object.keys(modes).indexOf(this.agent.mode))
      const dialog = new SelectionDialog({ title: colors.warning(`切换权限 · 当前 ${this.agent.mode}`), preview: `完全自动模式跳过审批；执行边界：${this.agent.executor.label}。`, choices, terminal: this.tui.terminal })
      const overlay = this.tui.showOverlay(dialog, dialogOptions)
      const finish = mode => { overlay.hide(); this.modeMenuCancel = null; this.tui.requestRender(); resolve(mode) }
      choices.onSelect = item => finish(item.value)
      choices.onCancel = () => finish(undefined)
      this.modeMenuCancel = () => finish(undefined)
      this.tui.requestRender()
    })
  }

  async switchMode (input) {
    const mode = input || await this.chooseMode()
    if (!mode || this.closing) return
    await this.agent.setMode(mode)
    if (this.mode !== mode) this.updateMode(mode)
  }

  approve ({ call, effect, args, signal }) {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
      const choices = new SelectList([
        { value: 'deny', label: 'Deny', description: 'Return refusal to the agent' },
        { value: 'allow', label: 'Allow once', description: 'Execute this exact call' },
        { value: 'session', label: 'Allow for this session', description: `All ${safeText(call.name)} calls until mode change or exit` }
      ], 3, selectTheme, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 24 })
      const title = colors.warning(effect === 'shell' ? `APPROVE SHELL · ${this.agent?.executor.label || this.sandbox}` : 'APPROVE WORKSPACE EDIT')
      const dialog = new SelectionDialog({ title, preview: `${safeText(call.name)}\n${safeText(JSON.stringify(args, null, 2)).slice(0, 2000)}`, choices, terminal: this.tui.terminal })
      const overlay = this.tui.showOverlay(dialog, dialogOptions)
      const finish = allowed => {
        signal.removeEventListener('abort', abort)
        overlay.hide()
        this.tui.requestRender()
        resolve(allowed)
      }
      const abort = () => finish(false)
      choices.onSelect = item => finish(item.value === 'session' ? 'session' : item.value === 'allow')
      choices.onCancel = () => finish(false)
      signal.addEventListener('abort', abort, { once: true })
      this.tui.requestRender()
    })
  }

  async submit (input) {
    const text = input.trim()
    if (!text) return
    if (/^\/(mode|permissions)(\s|$)/.test(text)) return this.switchMode(text.split(/\s+/).slice(1).join(' '))
    if (text === '/exit') return this.shutdown()
    if (text === '/stop') return this.agent.interrupt()
    if (text === '/sandbox') { this.add('Sandbox', `${this.agent.executor.label}\n${JSON.stringify(await sandboxStatus(), null, 2)}\n模型 API 在沙箱外；/mode 不改变隔离边界。`); return }
    if (text === '/continue') return this.agent.resume()
    if (text === '/compact') { await this.agent.compact(); this.add('Context', '压缩完成，原始历史已保留。'); return }
    if (text === '/undo') { await this.agent.undo(); return }
    if (text === '/status') { this.add('Session', `ID: ${this.session.id}\nLog: ${this.session.directory}\nPending: ${this.session.pending.length}\nStatus: ${this.agent.status}`); return }
    if (text === '/help') { this.add('Commands', commands.map(command => `/${command.name} — ${command.description}`).join('\n')); return }
    if (text.startsWith('/queue ')) return this.agent.enqueue(text.slice(7), 'queue')
    if (text.startsWith('/')) throw new Error('Unknown command; use /help')
    return this.agent.enqueue(text)
  }

  async shutdown () {
    if (this.closing) return
    this.closing = true
    this.modeMenuCancel?.()
    try {
      await this.agent.close()
    } catch (error) {
      process.stderr.write(`${safeText(error.message)}\n`)
      process.exitCode = 1
    } finally {
      this.tui.stop()
      this.onClose?.()
    }
  }
}
