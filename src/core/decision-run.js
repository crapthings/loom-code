import { randomUUID, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

// classifyWithinDeadline settles a judgment even when a classifier ignores cancellation.
async function classifyWithinDeadline (model, context, signal) {
  let abort
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return model.classify(context, { signal }) }), new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new Error('Decision cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

// runDecision records and accounts for one bounded classifier request without authorizing tools or replaying work.
export async function runDecision ({ session, model, budget, mode, from, context, validate, signal, timeoutMs = 5000 }) {
  signal.throwIfAborted()
  if (!budget.takeDecision(mode)) {
    await session.append('decision.skipped', { mode, reason: 'Decision call or time budget exhausted' })
    return { status: 'skipped' }
  }
  const decisionId = randomUUID()
  const inputHash = createHash('sha256').update(JSON.stringify(context)).digest('hex')
  await session.append('decision.started', { decisionId, mode, model: model.label, version: 1, from, inputHash, context })
  const started = performance.now()
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  let result
  let usage
  try {
    const response = await classifyWithinDeadline(model, context, requestSignal)
    usage = response.usage
    budget.accountDecision(response.usage)
    requestSignal.throwIfAborted()
    if (response.stopReason !== 'stop') throw new Error(response.errorMessage || 'Decision request failed')
    result = { status: 'completed', answers: validate(response.answers) }
  } catch (error) {
    result = { status: signal.aborted ? 'cancelled' : requestSignal.aborted ? 'timeout' : 'failed', error: error instanceof Error ? error.message : String(error) }
  }
  const finished = { decisionId, mode, ...result, usage, elapsedMs: performance.now() - started }
  await session.append('decision.finished', finished)
  return finished
}
