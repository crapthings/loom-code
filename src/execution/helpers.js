import { accessSync, constants, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// executable resolves a sandbox helper only from administrator-installed system locations.
function executable (name) {
  for (const directory of ['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']) {
    try {
      const file = realpathSync(path.join(directory, name))
      accessSync(file, constants.X_OK)
      return file
    } catch {}
  }
  throw new Error(`Sandbox helper ${name} missing from trusted system directories`)
}

// sandboxHelpers pins Linux helper paths before the runtime can discover programs through the caller's PATH.
export function sandboxHelpers () {
  if (process.platform !== 'linux') return {}
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error(`Sandbox seccomp helper unsupported on ${process.arch}`)
  const packageRoot = new URL('../', import.meta.resolve('@anthropic-ai/sandbox-runtime'))
  const applyPath = realpathSync(fileURLToPath(new URL(`vendor/seccomp/${process.arch}/apply-seccomp`, packageRoot)))
  accessSync(applyPath, constants.X_OK)
  return { bwrapPath: executable('bwrap'), socatPath: executable('socat'), ripgrep: { command: executable('rg') }, seccomp: { applyPath } }
}
