import { parseArgs } from 'node:util'
import { realpath } from 'node:fs/promises'
import { Agent } from './core/agent.js'
import { Session } from './core/session.js'
import { createModel, listModels, defaultProvider, defaultModels } from './model/provider.js'
import { createDemoModel } from './model/demo.js'
import { TerminalApp } from './ui/app.js'
import { safeText } from './ui/theme.js'
import { compatibleModels } from './model/compatible.js'
import { validateMode } from './core/modes.js'
import { sandboxStatus } from './execution/executor.js'

// parseOptions validates command-line configuration before opening a session or entering raw mode.
export function parseOptions (args, env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      demo: { type: 'boolean', default: false },
      cwd: { type: 'string', default: process.cwd() },
      session: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      'base-url': { type: 'string' },
      'context-window': { type: 'string', default: '32768' },
      mode: { type: 'string', default: 'ask' },
      sandbox: { type: 'string', default: 'required' },
      'sandbox-status': { type: 'boolean', default: false },
      steps: { type: 'string', default: '30' },
      reasoning: { type: 'string', default: 'off' },
      print: { type: 'string' },
      json: { type: 'boolean', default: false },
      models: { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  validateMode(values.mode)
  if (!['required', 'off'].includes(values.sandbox)) throw new Error('--sandbox must be required or off')
  const steps = Number(values.steps)
  if (!Number.isInteger(steps) || steps < 1 || steps > 500) throw new Error('--steps must be an integer from 1 to 500')
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(values.reasoning)) throw new Error('Invalid --reasoning level')
  const selected = values.provider || env.LOOM_PROVIDER || defaultProvider
  const provider = selected === 'vercel' ? defaultProvider : selected
  const model = values.model || env.LOOM_MODEL || defaultModels[provider]
  const contextWindow = Number(values['context-window'])
  if (!Number.isInteger(contextWindow) || contextWindow < 8192) throw new Error('--context-window must be an integer of at least 8192')
  if (values['base-url'] && !values.model && !env.LOOM_MODEL) throw new Error('--base-url requires an explicit --model')
  if (!values.demo && !values.help && !values.models && !values['sandbox-status'] && !model) throw new Error('Specify --model for this provider')
  return { ...values, provider, model, steps, contextWindow }
}

// helpText documents both interactive usage and deterministic headless execution.
export const helpText = `Loom Code — durable coding-agent orchestration in JavaScript

Usage: loom [options]

  --demo                   Offline model; real file tools and orchestration
  --cwd DIRECTORY          Workspace (default: current directory)
  --provider NAME          Pi provider; default: vercel-ai-gateway (alias: vercel)
  --model ID               Model identifier (or LOOM_MODEL)
  --base-url URL           OpenAI-compatible endpoint; optional LOOM_API_KEY
  --context-window N       Compatible endpoint context size (default: 32768)
  --models                 List chat models, optionally filtered by provider
  --mode ask|edit|auto|plan Initial permissions; switch with /mode in the TUI
  --sandbox required|off   Mandatory OS sandbox (default) or explicit host execution
  --sandbox-status         Check sandbox platform and dependencies without API calls
  --session ID             Reopen a saved workspace session
  --resume                 Explicitly resume interrupted or recovered work
  --steps N                Shared model-call allowance (default: 30)
  --reasoning LEVEL        off|minimal|low|medium|high|xhigh
  --print TASK             Run without a TUI; shell approval is denied
  --json                   Stream JSON events in headless mode
  --help                   Show this help

Interactive: Enter steers, /queue schedules, Esc interrupts, /help lists commands.
API credentials resolve through the selected provider's environment variables.
Default: Vercel AI Gateway / deepseek/deepseek-v4.1-flash; set AI_GATEWAY_API_KEY.
LOOM_PROVIDER and LOOM_MODEL override the defaults.
Shell commands require approval in ask/edit; auto permits host execution without prompts.
Shell sandbox defaults to required, with network denied and no unsandboxed fallback.
`

// main builds one runtime for either the terminal interface or the headless event stream.
export async function main (args = process.argv.slice(2)) {
  const options = parseOptions(args)
  if (options.help) { process.stdout.write(helpText); return }
  if (options['sandbox-status']) { const status = sandboxStatus(); process.stdout.write(`${JSON.stringify(status, null, 2)}\n`); if (status.errors.length || status.warnings.length) process.exitCode = 1; return }
  if (options.models) { process.stdout.write(`${listModels(args.includes('--provider') ? options.provider : undefined).join('\n')}\n`); return }
  if (!options.demo && !options['base-url'] && options.provider === defaultProvider && !process.env.AI_GATEWAY_API_KEY) throw new Error('Set AI_GATEWAY_API_KEY to use Vercel AI Gateway, or choose --provider / --base-url explicitly')
  const headless = options.print !== undefined || (options.resume && !process.stdin.isTTY)
  if (options.json && !headless) throw new Error('--json requires --print or headless --resume')
  if (!headless && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Interactive mode needs a terminal; use --print TASK or --demo --print TASK')
  const cwd = await realpath(options.cwd)
  const collection = options['base-url'] ? compatibleModels(options['base-url'], options.model, options.contextWindow) : undefined
  const model = options.demo ? createDemoModel() : createModel({ ...options, collection, provider: collection ? 'compatible' : options.provider })
  const session = await Session.open(cwd, options.session)
  let agent
  let app
  const shutdown = () => app ? app.shutdown().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }) : agent.interrupt()
  try {
    if (!headless) app = new TerminalApp({ cwd, session, model, mode: options.mode, sandbox: options.sandbox })
    const emit = event => {
      if (app) return app.event(event)
      if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`)
      else if (event.type === 'assistant.end' && !event.child) process.stdout.write(`${safeText(event.response.content.filter(part => part.type === 'text').map(part => part.text).join('\n'))}\n`)
      else if (event.type === 'error') process.stderr.write(`${safeText(event.text)}\n`)
    }
    agent = new Agent({ cwd, session, model, mode: options.mode, sandbox: options.sandbox, steps: options.steps, emit, approve: app ? request => app.approve(request) : async () => false })
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
