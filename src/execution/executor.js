import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sandboxPolicy, shellEnvironment } from './policy.js'
import { sandboxHelpers } from './helpers.js'
import { prepareIsolated } from './sandbox-client.js'

// tail serializes diagnostic and injected managers within one worker, never across live command workers.
let tail = Promise.resolve()

// acquire reserves the global manager without admitting a cancelled command into the sandbox.
async function acquire (signal) {
  const previous = tail
  let release
  tail = new Promise(resolve => { release = resolve })
  let abort
  try {
    await Promise.race([previous, new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new Error('Cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
    signal.throwIfAborted()
    return release
  } catch (error) {
    previous.then(release)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

// sandboxStatus reports platform support and dependencies without running a model or shell task.
export async function sandboxStatus () {
  if (!['darwin', 'linux'].includes(process.platform)) return { backend: 'unsupported', errors: ['Loom sandbox supports macOS and Linux only'], warnings: [] }
  const backend = process.platform === 'darwin' ? 'seatbelt' : 'bubblewrap'
  const release = await acquire(new AbortController().signal)
  try {
    SandboxManager.updateConfig({ ...sandboxPolicy(process.cwd(), tmpdir()), ...sandboxHelpers() })
    return { backend, ...SandboxManager.checkDependencies() }
  } catch (error) {
    return { backend, errors: [error.message], warnings: [] }
  } finally {
    try { await SandboxManager.reset() } finally { release() }
  }
}

// ShellExecutor prepares mandatory OS isolation or an explicitly selected unsandboxed launch with no fallback.
export class ShellExecutor {
  constructor ({ cwd, sandbox = 'required', manager }) {
    if (!['required', 'off'].includes(sandbox)) throw new Error('Sandbox must be required or off')
    this.cwd = cwd
    this.sandbox = sandbox
    this.manager = manager || SandboxManager
    this.isolated = !manager && sandbox === 'required'
    this.label = sandbox === 'off' ? 'UNSANDBOXED HOST' : `${process.platform === 'darwin' ? 'Seatbelt' : 'bubblewrap'} · network denied`
  }

  async prepare (command, signal) {
    if (this.isolated) return prepareIsolated(this.cwd, command, signal)
    const release = this.sandbox === 'off' ? () => {} : await acquire(signal)
    let scratch
    let initialized = false
    let wrapped = false
    let cleaning
    const clean = async () => {
      try {
        try { if (wrapped) this.manager.cleanupAfterCommand() } finally { if (initialized) await this.manager.reset() }
      } finally {
        try { if (scratch) await rm(scratch, { recursive: true, force: true }) } finally { release() }
      }
    }
    const cleanup = () => {
      cleaning ||= clean()
      return cleaning
    }
    try {
      signal.throwIfAborted()
      scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'loom-shell-')))
      signal.throwIfAborted()
      const env = shellEnvironment(scratch)
      if (this.sandbox === 'off') return { command: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], env, cleanup, label: this.label }
      if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Sandbox unavailable: only macOS and Linux are supported; no host fallback')
      const cwd = await realpath(this.cwd)
      const policy = { ...sandboxPolicy(cwd, scratch), ...sandboxHelpers() }
      if (policy.seccomp) policy.filesystem.allowRead.push({ path: policy.seccomp.applyPath, literal: true })
      initialized = true
      this.manager.updateConfig(policy)
      const dependencies = this.manager.checkDependencies()
      if (dependencies.errors.length || dependencies.warnings.length) throw new Error(`Sandbox dependencies unavailable or degraded: ${[...dependencies.errors, ...dependencies.warnings].join('; ')}; no host fallback`)
      await this.manager.initialize(policy, undefined, false)
      signal.throwIfAborted()
      const prefix = `export TMPDIR='${scratch.replace(/'/g, "'\\''")}'\n`
      const result = await this.manager.wrapWithSandboxArgv(prefix + command, '/bin/bash', undefined, signal, cwd, { commandId: randomUUID(), commandText: command })
      wrapped = true
      const warnings = this.manager.getLinuxGlobPatternWarnings()
      if (warnings.length) throw new Error(`Sandbox policy not fully enforced: ${warnings.join('; ')}`)
      return { command: result.argv[0], args: result.argv.slice(1), env, cleanup, label: this.label }
    } catch (error) {
      await cleanup()
      throw new Error(`Sandbox preparation failed: ${error.message}`, { cause: error })
    }
  }
}
