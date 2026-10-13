import { parseArgs } from 'node:util'
import { realpath } from 'node:fs/promises'
import { Agent } from './core/agent.js'
import { Session } from './core/session.js'
import { listSessions } from './core/session-list.js'
import { selectSession } from './ui/session-picker.js'
import { translate } from './ui/i18n.js'
import { createModel, listModels, defaultProvider, defaultModel } from './model/provider.js'
import { TerminalApp } from './ui/app.js'
import { safeText } from './ui/theme.js'
import { validateMode } from './core/modes.js'
import { sandboxStatus } from './execution/executor.js'
import { LanguagePreferences } from './ui/preferences.js'
import { createDecisionModel, defaultDecisionModel, listDecisionModels } from './model/decision.js'

// parseOptions validates command-line configuration before opening a session or entering raw mode.
export function parseOptions (args, env = process.env) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      cwd: { type: 'string', default: process.cwd() },
      session: { type: 'string' },
      model: { type: 'string' },
      mode: { type: 'string', default: 'ask' },
      sandbox: { type: 'string', default: 'required' },
      'sandbox-status': { type: 'boolean', default: false },
      steps: { type: 'string', default: '30' },
      reasoning: { type: 'string', default: 'off' },
      print: { type: 'string' },
      json: { type: 'boolean', default: false },
      models: { type: 'boolean', default: false },
      verify: { type: 'string', default: 'off' },
      'decision-model': { type: 'string' },
      'decision-models': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      last: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  const resumeCommand = positionals[0] === 'resume'
  if (positionals.length && (!resumeCommand || positionals.length > 2)) throw new Error('Usage: loom resume [SESSION_ID] [--last | --list]')
  if (positionals[1] && values.session) throw new Error('Specify a session ID only once')
  if (positionals[1]) values.session = positionals[1]
  if ((values.last || values.list) && !resumeCommand) throw new Error('--last and --list require loom resume')
  if (values.last && (values.session || values.list)) throw new Error('--last cannot be combined with a session ID or --list')
  if (values.list && (values.session || values.resume || values.print !== undefined)) throw new Error('--list cannot be combined with execution or session selection')
  if (values.resume && !resumeCommand && !values.session) throw new Error('--resume requires --session ID; use loom resume to choose a session')
  validateMode(values.mode)
  if (!['off', 'shadow'].includes(values.verify)) throw new Error('--verify must be off or shadow')
  if (!['required', 'off'].includes(values.sandbox)) throw new Error('--sandbox must be required or off')
  const steps = Number(values.steps)
  if (!Number.isInteger(steps) || steps < 1 || steps > 500) throw new Error('--steps must be an integer from 1 to 500')
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(values.reasoning)) throw new Error('Invalid --reasoning level')
  if (env.LOOM_PROVIDER && !['vercel', defaultProvider].includes(env.LOOM_PROVIDER)) throw new Error('Only Vercel AI Gateway is supported; remove LOOM_PROVIDER')
  const model = values.model || env.LOOM_MODEL || defaultModel
  const decisionModel = values['decision-model'] || env.LOOM_DECISION_MODEL || defaultDecisionModel
  return { ...values, provider: defaultProvider, model, decisionModel, steps, resumeCommand }
}

// helpText documents both interactive usage and deterministic headless execution.
export const helpText = `Loom Code — durable coding-agent orchestration in JavaScript

Usage: loom [options]
       loom resume [SESSION_ID] [--last | --list] [options]

  --cwd DIRECTORY          Workspace (default: current directory)
  --model ID               Model identifier (or LOOM_MODEL)
  --models                 List Vercel AI Gateway chat models
  --verify off|shadow      Optional completion evaluation (default: off; shadow records only)
  --decision-model ID      Classifier identifier (or LOOM_DECISION_MODEL)
  --decision-models        List decision models without API calls
  --mode ask|edit|auto|plan Initial permissions; switch with /mode in the TUI
  --sandbox required|off   Mandatory OS sandbox (default) or explicit host execution
  --sandbox-status         Check sandbox platform and dependencies without API calls
  --session ID             Reopen a saved workspace session
  --resume                 Explicitly execute unfinished work in a selected session
  --last                   Open the most recent available session (loom resume)
  --list                   List workspace sessions; --json for JSON (loom resume)
  --steps N                Shared model-call allowance (default: 30)
  --reasoning LEVEL        off|minimal|low|medium|high|xhigh
  --print TASK             Run without a TUI; shell approval is denied
  --json                   Stream JSON events in headless mode
  --help                   Show this help

Interactive: Enter steers, /queue schedules, Esc interrupts, /help lists commands.
Interface: English by default; /language selects and saves en or zh-CN.
API requests use Vercel AI Gateway with AI_GATEWAY_API_KEY.
Default: Vercel AI Gateway / deepseek/deepseek-v4.1-flash; set AI_GATEWAY_API_KEY.
LOOM_MODEL overrides the default model.
Shell commands require approval in ask/edit; auto permits host execution without prompts.
Shell sandbox defaults to required, with network denied and no unsandboxed fallback.
`

// main builds one runtime for either the terminal interface or the headless event stream.
export async function main (args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (options.help) { process.stdout.write(helpText); return }
  if (options['sandbox-status']) { const status = await sandboxStatus(); process.stdout.write(`${JSON.stringify(status, null, 2)}\n`); if (status.errors.length || status.warnings.length) process.exitCode = 1; return }
  if (options.models) { process.stdout.write(`${listModels().join('\n')}\n`); return }
  if (options['decision-models']) { process.stdout.write(`${listDecisionModels().join('\n')}\n`); return }
  if (!options.resumeCommand && !process.env.AI_GATEWAY_API_KEY) throw new Error('Set AI_GATEWAY_API_KEY to use Vercel AI Gateway')
  const cwd = await realpath(options.cwd)
  const preferences = new LanguagePreferences()
  if (options.resumeCommand) {
    if (!options.session && !options.last && (options.resume || options.print !== undefined) && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Headless execution requires a session ID or --last')
    const catalog = await listSessions(cwd)
    if (options.list || (!options.session && !options.last && (!process.stdin.isTTY || !process.stdout.isTTY))) {
      if (options.json) process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`)
      else {
        for (const session of catalog.sessions) process.stdout.write(`${session.id}\t${new Date(session.updated).toISOString()}\t${session.busy ? 'busy' : session.status}\t${safeText(session.title)}\n`)
        if (!catalog.sessions.length) process.stdout.write('No saved sessions in this workspace.\n')
        if (catalog.skipped) process.stderr.write(`Skipped ${catalog.skipped} unreadable or invalid sessions.\n`)
      }
      return
    }
    if (catalog.skipped) process.stderr.write(`Skipped ${catalog.skipped} unreadable or invalid sessions.\n`)
    if (options.last) options.session = catalog.sessions.find(session => !session.busy)?.id
    else if (!options.session) options.session = await selectSession(catalog.sessions, { language: await preferences.load() })
    if (!options.session) {
      if (!catalog.sessions.some(session => !session.busy)) process.stdout.write(`${translate(await preferences.load(), 'session.none')}\n`)
      return
    }
    const selected = catalog.sessions.find(session => session.id === options.session)
    if (!selected) throw new Error('Saved root session not found in this workspace')
    if (selected.busy) throw new Error('Session is already open in another process')
  }
  if (!process.env.AI_GATEWAY_API_KEY) throw new Error('Set AI_GATEWAY_API_KEY to use Vercel AI Gateway')
  const headless = options.print !== undefined || (options.resume && !process.stdin.isTTY)
  if (options.json && !headless) throw new Error('--json requires --print or headless --resume')
  if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive mode needs a terminal; use --print TASK')
  const model = createModel(options)
  const decisionModel = options.verify === 'shadow' ? createDecisionModel({ model: options.decisionModel }) : undefined
  const language = headless ? 'en' : await preferences.load()
  const session = await Session.open(cwd, options.session, { existing: options.resumeCommand })
  let agent
  let app
  const shutdown = () => app ? app.shutdown().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) : agent.interrupt()
  try {
    if (!headless) app = new TerminalApp({ cwd, session, model, mode: options.mode, sandbox: options.sandbox, language, saveLanguage: language => preferences.save(language) })
    const emit = event => {
      if (app) return app.event(event)
      if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`)
      else if (event.type === 'assistant.end' && !event.child) process.stdout.write(`${safeText(event.response.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))}\n`)
      else if (event.type === 'error') process.stderr.write(`${safeText(event.text)}\n`)
      else if (event.type === 'resume.skipped') process.stdout.write(`${event.text}\n`)
    }
    agent = new Agent({ cwd, session, model, decisionModel, mode: options.mode, sandbox: options.sandbox, steps: options.steps, emit, approve: app ? request => app.approve(request) : async () => false })
    app?.bind(agent)
    await agent.initialize()
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
    if (headless) {
      if (agent.blocked && !options.resume) throw new Error('Recovery requires inspecting recorded outcomes and explicitly passing --resume')
      if (options.resume) await agent.resume()
      if (options.print) await agent.enqueue(options.print)
      await agent.wait()
      if (agent.status !== 'idle') process.exitCode = 1
    } else {
      const closed = new Promise(resolve => { app.onClose = resolve })
      app.start()
      if (options.resume) await agent.resume()
      await closed
    }
  } finally {
    process.removeListener('SIGINT', shutdown)
    process.removeListener('SIGTERM', shutdown)
    app?.tui.stop()
    if (agent) await agent.close()
    else await session.close()
  }
}
