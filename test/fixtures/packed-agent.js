import { pathToFileURL } from 'node:url'
import { createDemoModel } from './demo-model.js'

// runPackedAgent verifies packaged SDK exports and a real tool round trip with a test-only model.
async function runPackedAgent () {
  const api = await import(pathToFileURL(process.argv[2]).href)
  if (!api.Agent || !api.Session || !api.Dispatcher || !api.createModel || !api.createDecisionModel || !api.listDecisionModels || 'createDemoModel' in api) throw new Error('Unexpected packaged SDK exports')
  const cwd = process.cwd()
  const session = await api.Session.open(cwd)
  const decisionModel = { label: 'offline/decision', classify: async () => ({ stopReason: 'stop', answers: { coverage: { type: 'choice', choice: 'unknown', confidence: 0.2, probabilities: { complete: 0, incomplete: 0, unknown: 1 } }, unsupportedClaims: { type: 'bool', probability: 0.5 }, missingVerification: { type: 'bool', probability: 0.5 } } }) }
  const agent = new api.Agent({ cwd, session, model: createDemoModel(), decisionModel, mode: 'plan', emit: event => process.stdout.write(`${JSON.stringify(event)}\n`) })
  try {
    await agent.initialize()
    await agent.enqueue('Inspect the workspace')
    await agent.wait()
    if (agent.status !== 'idle') throw new Error(`Packaged agent ended with status ${agent.status}`)
  } finally { await agent.close() }
}

// Fixture failures make the calling smoke check fail after the agent has released its resources.
runPackedAgent().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1 })
