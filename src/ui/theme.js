import { stripVTControlCharacters } from 'node:util'

// safeText removes terminal control sequences from model and tool content before rendering.
export function safeText (text) {
  return [...stripVTControlCharacters(String(text))].filter(char => char === '\n' || char === '\t' || (char.codePointAt(0) >= 32 && !(char.codePointAt(0) >= 127 && char.codePointAt(0) <= 159))).join('')
}

// paint wraps application-owned labels in a terminal color without styling untrusted escape codes.
function paint (code) {
  return text => `\x1b[${code}m${safeText(text)}\x1b[0m`
}

// colors defines the small set of semantic styles used throughout the terminal interface.
export const colors = { accent: paint('36'), dim: paint('2'), good: paint('32'), warning: paint('33'), error: paint('31'), bold: paint('1') }

// selectTheme styles approval choices and autocomplete suggestions with the same visual language.
export const selectTheme = { selectedPrefix: colors.accent, selectedText: colors.bold, description: colors.dim, scrollInfo: colors.dim, noMatch: colors.dim }

// editorTheme supplies Pi's multiline editor with its border and suggestion styles.
export const editorTheme = { borderColor: colors.accent, selectList: selectTheme }

// markdownTheme renders response structure using restrained terminal colors.
export const markdownTheme = { heading: colors.accent, link: colors.accent, linkUrl: colors.dim, code: colors.warning, codeBlock: colors.good, codeBlockBorder: colors.dim, quote: colors.dim, quoteBorder: colors.dim, hr: colors.dim, listBullet: colors.accent, bold: colors.bold, italic: colors.dim, strikethrough: colors.dim, underline: colors.accent }
