import { Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { colors } from './theme.js'
import { translate } from './i18n.js'

// panelBackground gives trusted rendered dialog rows a solid background, including after child style resets.
function panelBackground (line) {
  const background = '\x1b[48;5;236m'
  return `${background}${line.split('\x1b[0m').join(`\x1b[0m${background}`)}\x1b[0m`
}

// SelectionDialog keeps a bounded preview above visible keyboard choices inside a framed modal.
export class SelectionDialog {
  constructor ({ title, preview, choices, terminal, t = key => translate('en', key) }) {
    this.title = new Text(title, 0, 0)
    this.preview = new Text(preview, 0, 0)
    this.choices = choices
    this.terminal = terminal
    this.t = t
  }

  handleInput (data) { this.choices.handleInput(data) }

  handleMouse (event) {
    const layout = this.choiceLayout
    if (!layout || event.y < layout.row || event.y >= layout.row + layout.height || event.x < 2 || event.x >= layout.width + 2) return
    return this.choices.handleMouse({ ...event, x: event.x - 2, y: event.y - layout.row, width: layout.width, height: layout.height })
  }

  invalidate () { this.title.invalidate(); this.preview.invalidate(); this.choices.invalidate() }

  render (width) {
    const inner = Math.max(1, width - 4)
    const choices = this.choices.render(inner)
    const title = this.title.render(inner).slice(0, 2)
    const hint = truncateToWidth(this.t('dialog.controls'), inner)
    const budget = Math.max(0, this.terminal.rows - 2 - choices.length - title.length - 4)
    let preview = this.preview.render(inner)
    if (preview.length > budget) preview = budget ? [...preview.slice(0, budget - 1), colors.dim(truncateToWidth(this.t('dialog.truncated'), inner))] : []
    this.choiceLayout = { row: title.length + preview.length + 2, width: inner, height: choices.length }
    const border = colors.dim(`┌${'─'.repeat(Math.max(0, width - 2))}┐`)
    const bottom = colors.dim(`└${'─'.repeat(Math.max(0, width - 2))}┘`)
    const rows = [...title, ...preview, '', ...choices, hint].map(line => {
      const content = truncateToWidth(line, inner)
      return `│ ${content}${' '.repeat(Math.max(0, inner - visibleWidth(content)))} │`
    })
    return [border, ...rows, bottom].map(panelBackground)
  }
}

// dialogOptions centers a compact modal and lets the renderer clamp it to narrower terminals.
export const dialogOptions = { width: 88, anchor: 'center', margin: 1 }
