import { defaultProvider, gatewayModels } from './catalog.js'
import { setTimeout as delay } from 'node:timers/promises'

// defaultProvider identifies the only supported production gateway.
export { defaultProvider }

// defaultModel selects the initial model served through Vercel AI Gateway.
export const defaultModel = 'deepseek/deepseek-v4.1-flash'

// createModel wraps Vercel's Pi streams in the harness's small completion interface.
export function createModel ({ provider = defaultProvider, model: id = defaultModel, reasoning = 'off', collection } = {}) {
  if (!['vercel', defaultProvider].includes(provider)) throw new Error('Only Vercel AI Gateway is supported')
  provider = defaultProvider
  const models = collection || gatewayModels()
  const model = models.getModel(provider, id)
  if (!model) throw new Error(`Unknown model ${provider}/${id}; use --models to inspect the catalog`)
  return {
    label: `${provider}/${id}`,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    complete: async ({ system, messages, tools }, { signal, maxTokens, onDelta, onRetry = () => {} }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted()
        let streamed = false
        const stream = models.streamSimple(model, { systemPrompt: system, messages, tools }, { signal, maxTokens, maxRetries: 0, timeoutMs: 120000, reasoning: reasoning === 'off' ? undefined : reasoning })
        for await (const event of stream) {
          if (event.type === 'text_delta') { streamed = true; onDelta(event.delta) }
        }
        const response = await stream.result()
        if (response.stopReason !== 'error' || streamed || attempt === 2 || !/(429|rate.limit|overloaded|503|502|ECONNRESET)/i.test(response.errorMessage || '')) return response
        onRetry()
        await delay(500 * 2 ** attempt, undefined, { signal })
      }
    }
  }
}

// listModels returns built-in chat identifiers without accessing credentials or making paid requests.
export function listModels () {
  return gatewayModels().getModels(defaultProvider).map(model => `${model.provider}/${model.id}`)
}
