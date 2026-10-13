import { ProcessTerminal, SelectList, Text, TuiAltScreen, matchesKey } from '@earendil-works/pi-tui'
import { SelectionDialog, dialogOptions } from './dialog.js'
import { safeText, selectTheme } from './theme.js'
import { translate } from './i18n.js'

// selectSession opens a disposable startup picker and returns an existing session ID without starting execution.
export function selectSession (sessions, { language = 'en', terminal = new ProcessTerminal() } = {}) {
  const t = (key, values) => translate(language, key, values)
  const available = sessions.filter(session => !session.busy)
  if (!available.length) return Promise.resolve(undefined)
  const tui = new TuiAltScreen(terminal)
  tui.setLayoutRoot(new Text('', 0, 0))
  const choices = new SelectList(available.map(session => ({ value: session.id, label: safeText(session.title), description: `${session.id} · ${new Date(session.updated).toLocaleString(language)} · ${t(`session.state.${session.status}`)} · ${t('session.pending', { count: session.pending })}` })), Math.max(1, Math.min(8, Math.floor((terminal.rows - 8) / 2))), selectTheme)
  const renderChoices = choices.render.bind(choices)
  choices.render = width => { choices.maxVisible = Math.max(1, Math.min(8, Math.floor((terminal.rows - 8) / 2))); return renderChoices(width) }
  const dialog = new SelectionDialog({ title: t('session.choose'), preview: t('session.openOnly'), choices, terminal, t })
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = id => { if (settled) return; settled = true; tui.stop(); resolve(id) }
    choices.onSelect = item => finish(item.value)
    choices.onCancel = () => finish(undefined)
    tui.addInputListener(data => { if (matchesKey(data, 'ctrl+c')) { finish(undefined); return { consume: true } } })
    try { tui.showOverlay(dialog, dialogOptions); tui.start() } catch (error) { tui.stop(); reject(error) }
  })
}
