import { CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, ScrollView, SelectList, Text, TuiAltScreen, VStack, matchesKey } from '@earendil-works/pi-tui'
import { colors, editorTheme, markdownTheme, safeText, selectTheme } from './theme.js'
import { modes } from '../core/modes.js'
import { sandboxStatus } from '../execution/executor.js'
import { SelectionDialog, dialogOptions } from './dialog.js'
import { catalogs, translate, validateLanguage } from './i18n.js'

// commands describes the terminal commands offered by the editor's completion menu.
const commands = ['help', 'mode', 'permissions', 'language', 'lang', 'sandbox', 'queue', 'stop', 'continue', 'compact', 'undo', 'status', 'exit']

// TerminalApp presents a scrollable transcript, persistent editor, execution status, and cancellable approvals.
export class TerminalApp {
  constructor ({ cwd, session, model, mode, sandbox = 'required', language = 'en', saveLanguage = async () => {}, terminal = new ProcessTerminal() }) {
    this.language = validateLanguage(language)
    this.saveLanguage = saveLanguage
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
    this.header = new Text('', 1, 0)
    this.footer = new Text('', 1, 0)
    this.editor = new Editor(this.tui, editorTheme)
    this.refreshLanguage()
    this.editor.onSubmit = text => {
      this.editor.setText('')
      this.editor.addToHistory(text)
      this.commandTail = this.commandTail.then(() => this.submit(text)).catch(error => this.add(this.t('label.error'), error.message))
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

  t (key, values) { return translate(this.language, key, values) }

  commandList () { return commands.map(name => ({ name, description: this.t(`command.${name}`) })) }

  executionLabel (label = this.agent?.executor.label || this.sandbox) {
    return label.replace('UNSANDBOXED HOST', this.t('sandbox.off')).replace('network denied', this.t('sandbox.denied'))
  }

  statusLabel (status) { return Object.hasOwn(catalogs.en, `status.${status}`) ? this.t(`status.${status}`) : status }

  refreshLanguage () {
    this.header.setText(`${colors.bold('LOOM CODE')}  ${colors.dim(this.model.label)}  ${colors.warning(`${this.mode} · ${this.t(`mode.${this.mode}.label`)}`)} · ${this.sandbox === 'off' ? colors.warning(this.t('sandbox.off')) : this.t('sandbox.required')}\n${colors.dim(this.cwd)}`)
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(this.commandList(), this.cwd))
    this.refreshStatus(this.lastStatus || 'idle', this.lastBudget)
  }

  start () {
    this.add(this.t('label.welcome'), this.t('welcome.controls'))
    for (const message of this.session.messages) {
      if (message.role === 'user') this.add(this.t('label.you'), message.content)
      if (message.role === 'assistant') this.add('Loom', message.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))
      if (message.role === 'toolResult') this.add(message.toolName, message.content[0]?.text || '')
    }
    if (this.agent.blocked) this.add(this.t('label.recovery'), this.t('recovery.instructions'))
    if (this.session.pending.length) this.add(this.t('label.pending'), this.t('pending.count', { count: this.session.pending.length }))
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
      if (event.type === 'tool.start') this.add(this.t('child.tool', { role: event.role }), event.call.name)
      if (event.type === 'error') this.add(this.t('child.error', { role: event.role }), event.text)
      return
    }
    if (event.type === 'mode.changed') this.updateMode(event.mode)
    if (event.type === 'permission.granted') this.add(this.t('label.permissions'), this.t('grant.notice', { tool: event.tool }))
    if (event.type === 'queued') this.queued.set(event.inputId, this.add(this.t('pending.label', { delivery: event.delivery }), event.text))
    if (event.type === 'user') {
      const component = this.queued.get(event.inputId)
      if (component) { component.setText(`${colors.accent(this.t('label.you'))}\n${safeText(event.text)}`); this.queued.delete(event.inputId) } else this.add(this.t('label.you'), event.text)
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
    if (event.type === 'tool.start') this.add(this.t('tool.start', { name: event.call.name }), JSON.stringify(event.call.arguments))
    if (event.type === 'tool.end') this.add(this.t(event.result.isError ? 'tool.failed' : 'tool.completed'), event.result.text.slice(0, 2500))
    if (event.type === 'tool.progress') this.refreshStatus(event.kind === 'process.started' ? event : event.text)
    if (event.type === 'error') this.add(this.t('label.stopped'), `${event.text}\n${this.t('error.resume')}`)
    if (event.type === 'status') this.refreshStatus(event.text, event.budget)
    this.tui.requestRender()
  }

  refreshStatus (status, budget = this.agent?.budget) {
    this.lastStatus = status
    this.lastBudget = budget
    const label = typeof status === 'object' ? this.t('status.process', { boundary: this.executionLabel(status.boundary), pid: status.pid }) : this.statusLabel(status)
    this.footer.setText(colors.dim(`${this.t('status.footer', { status: label, session: this.session.id.slice(0, 8), calls: budget?.calls || 0, tokens: budget?.tokens || 0, cost: `$${(budget?.cost || 0).toFixed(4)}` })}\n${this.t('status.controls')}`))
    this.tui.requestRender()
  }

  updateMode (mode) {
    this.mode = mode
    this.refreshLanguage()
    this.add(this.t('label.permissions'), `${mode} · ${this.t(`mode.${mode}.description`)}`)
  }

  chooseMode () {
    if (this.agent.running) throw new Error(this.t('mode.busy'))
    return new Promise(resolve => {
      const choices = new SelectList(Object.keys(modes).map(value => ({ value, label: `${value} · ${this.t(`mode.${value}.label`)}`, description: this.t(`mode.${value}.description`) })), 4, selectTheme)
      choices.setSelectedIndex(Object.keys(modes).indexOf(this.agent.mode))
      const dialog = new SelectionDialog({ title: colors.warning(this.t('mode.title', { mode: this.agent.mode })), preview: this.t('mode.preview', { boundary: this.executionLabel() }), choices, terminal: this.tui.terminal, t: (key) => this.t(key) })
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

  chooseLanguage () {
    return new Promise(resolve => {
      const choices = new SelectList(Object.keys(catalogs).map(value => ({ value, label: this.t(`language.${value}`), description: this.t(`language.${value}.description`) })), 2, selectTheme)
      choices.setSelectedIndex(Object.keys(catalogs).indexOf(this.language))
      const dialog = new SelectionDialog({ title: colors.warning(this.t('language.title')), preview: this.t('language.preview'), choices, terminal: this.tui.terminal, t: (key) => this.t(key) })
      const overlay = this.tui.showOverlay(dialog, dialogOptions)
      const finish = language => { overlay.hide(); this.languageMenuCancel = null; this.tui.requestRender(); resolve(language) }
      choices.onSelect = item => finish(item.value)
      choices.onCancel = () => finish(undefined)
      this.languageMenuCancel = () => finish(undefined)
      this.tui.requestRender()
    })
  }

  async switchLanguage (input) {
    const language = input || await this.chooseLanguage()
    if (!language || this.closing) return
    if (!Object.hasOwn(catalogs, language)) throw new Error(this.t('language.invalid'))
    await this.saveLanguage(language)
    this.language = language
    this.refreshLanguage()
    this.add(this.t('label.language'), this.t('language.changed', { language: this.t(`language.${language}`) }))
  }

  approve ({ call, effect, args, signal }) {
    if (signal.aborted) return Promise.resolve(false)
    return new Promise(resolve => {
      const choices = new SelectList([
        { value: 'deny', label: this.t('approval.deny'), description: this.t('approval.deny.description') },
        { value: 'allow', label: this.t('approval.once'), description: this.t('approval.once.description') },
        { value: 'session', label: this.t('approval.session'), description: this.t('approval.session.description', { tool: safeText(call.name) }) }
      ], 3, selectTheme, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 24 })
      const title = colors.warning(this.t(effect === 'shell' ? 'approval.shell' : 'approval.write', { boundary: this.executionLabel() }))
      const dialog = new SelectionDialog({ title, preview: `${safeText(call.name)}\n${safeText(JSON.stringify(args, null, 2)).slice(0, 2000)}`, choices, terminal: this.tui.terminal, t: (key) => this.t(key) })
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
    if (/^\/(language|lang)(\s|$)/.test(text)) return this.switchLanguage(text.split(/\s+/).slice(1).join(' '))
    if (text === '/exit') return this.shutdown()
    if (text === '/stop') return this.agent.interrupt()
    if (text === '/sandbox') { this.add(this.t('label.sandbox'), `${this.executionLabel()}\n${JSON.stringify(await sandboxStatus(), null, 2)}\n${this.t('sandbox.details')}`); return }
    if (text === '/continue') return this.agent.resume()
    if (text === '/compact') { await this.agent.compact(); this.add(this.t('label.context'), this.t('context.compacted')); return }
    if (text === '/undo') { await this.agent.undo(); return }
    if (text === '/status') { this.add(this.t('label.session'), this.t('session.details', { id: this.session.id, log: this.session.directory, pending: this.session.pending.length, status: this.statusLabel(this.agent.status) })); return }
    if (text === '/help') { this.add(this.t('label.commands'), this.commandList().map(command => `/${command.name} — ${command.description}`).join('\n')); return }
    if (text.startsWith('/queue ')) return this.agent.enqueue(text.slice(7), 'queue')
    if (text.startsWith('/')) throw new Error(this.t('command.unknown'))
    return this.agent.enqueue(text)
  }

  async shutdown () {
    if (this.closing) return
    this.closing = true
    this.modeMenuCancel?.()
    this.languageMenuCancel?.()
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
