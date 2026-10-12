import { createModels, createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

// compatibleModels registers an explicitly configured OpenAI-compatible endpoint with optional Loom-specific credentials.
export function compatibleModels (baseUrl, id, contextWindow = 32768) {
  const endpoint = new URL(baseUrl)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('Use an HTTP(S) base URL without embedded credentials')
  const models = createModels()
  models.setProvider(createProvider({
    id: 'compatible',
    name: 'Configured endpoint',
    baseUrl,
    auth: { apiKey: { name: 'LOOM_API_KEY', resolve: async () => ({ auth: { apiKey: process.env.LOOM_API_KEY || 'loom-local' } }) } },
    models: [{ id, name: id, api: 'openai-completions', provider: 'compatible', baseUrl, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: Math.min(8192, Math.floor(contextWindow / 4)) }],
    api: openAICompletionsApi()
  }))
  return models
}
