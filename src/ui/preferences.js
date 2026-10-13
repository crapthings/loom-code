import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { validateLanguage } from './i18n.js'

// LanguagePreferences reads and atomically saves user-level UI language without storing permissions or credentials.
export class LanguagePreferences {
  constructor (file = path.join(homedir(), '.config', 'loom', 'settings.json')) { this.file = file }

  async read () {
    try {
      const settings = JSON.parse(await readFile(this.file, 'utf8'))
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Settings must be a JSON object')
      return settings
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw new Error(`Cannot read Loom settings at ${this.file}: ${error.message}`, { cause: error })
    }
  }

  async load () { return validateLanguage((await this.read()).language ?? 'en') }

  async save (language) {
    validateLanguage(language)
    const settings = { ...await this.read(), language }
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.file)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
