import { defaultProvider, gatewayModels } from './catalog.js'

// defaultDecisionModel selects Luna's decision-only route without changing the chat model.
export const defaultDecisionModel = 'openai/gpt-6-luna-decisions'

// createDecisionModel exposes bounded, non-retrying classification through Vercel's native classifier transport.
export function createDecisionModel ({ model: id = defaultDecisionModel, collection } = {}) {
  const models = collection || gatewayModels()
  const model = models.getAllModels(defaultProvider).find(model => model.type === 'classifier' && model.id === id)
  if (!model) throw new Error(`Unknown decision model ${id}; use --decision-models to inspect the catalog`)
  return {
    label: `${defaultProvider}/${id}`,
    classify: async (context, { signal }) => {
      signal.throwIfAborted()
      if (Buffer.byteLength(JSON.stringify(context)) > 64 * 1024) throw new Error('Decision input exceeds the 64 KiB limit')
      return models.classify(model, context, { signal, maxRetries: 0, timeoutMs: 5000 })
    }
  }
}

// listDecisionModels lists classifier identifiers offline and keeps them separate from chat models.
export function listDecisionModels () {
  return gatewayModels().getAllModels(defaultProvider).filter(model => model.type === 'classifier').map(model => `${model.provider}/${model.id}`)
}
