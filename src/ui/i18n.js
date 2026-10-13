import { en } from './locales/en.js'
import { zhCN } from './locales/zh-CN.js'

// catalogs maps supported language identifiers to their interface message catalogs.
export const catalogs = { en, 'zh-CN': zhCN }

// validateLanguage rejects unsupported identifiers before settings or rendered UI change.
export function validateLanguage (language) {
  if (!Object.hasOwn(catalogs, language)) throw new Error('Unsupported interface language; choose en or zh-CN')
  return language
}

// translate resolves a localized message with English fallback and literal named substitutions.
export function translate (language, key, values = {}) {
  const message = catalogs[validateLanguage(language)][key] ?? en[key]
  if (message === undefined) throw new Error(`Unknown interface message: ${key}`)
  return message.replace(/\{([\w-]+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}
