import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { setTimeout as delay } from 'node:timers/promises'

// defaultProvider selects Vercel AI Gateway unless a caller explicitly chooses another provider.
export const defaultProvider = 'vercel-ai-gateway'

// defaultModels supplies known model identifiers for providers that support an implicit selection.
export const defaultModels = { 'vercel-ai-gateway': 'deepseek/deepseek-v4.1-flash', anthropic: 'claude-sonnet-4-6', openai: 'gpt-5.4' }

// createModel wraps Pi's multi-provider streams in the harness's small completion interface.
export function createModel ({ provider = defaultProvider, model: id = defaultModels[provider], reasoning = 'off', collection } = {}) {
  const models = collection || builtinModels()
  const model = models.getModel(provider, id)
  if (!model) throw new Error(`Unknown model ${provider}/${id}; use --models to inspect the catalog`)
  return {
    label: `${provider}/${id}`,
    contextWindow: model.contextWindow,
    complete: async ({ system, messages, tools }, { signal, onDelta, onRetry = () => {} }) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted()
        let streamed = false
        const stream = models.streamSimple(model, { systemPrompt: system, messages, tools }, { signal, maxRetries: 0, timeoutMs: 120000, reasoning: reasoning === 'off' ? undefined : reasoning })
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
export function listModels (provider) {
  return builtinModels().getModels(provider).map(model => `${model.provider}/${model.id}`)
}
