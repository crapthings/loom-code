import test from 'node:test'
import assert from 'node:assert/strict'
import { createModels, createProvider, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { createModel, listModels } from '../src/model/provider.js'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Agent } from '../src/core/agent.js'
import { fixture } from './helpers.js'
import { parseOptions, main } from '../src/cli.js'

test('default routing uses Vercel regardless of unrelated provider credentials', () => {
  const options = parseOptions([], { OPENAI_API_KEY: 'unrelated', ANTHROPIC_API_KEY: 'unrelated' })
  assert.equal(options.provider, 'vercel-ai-gateway')
  assert.equal(options.model, 'deepseek/deepseek-v4.1-flash')
  const model = createModel(options)
  assert.equal(model.label, 'vercel-ai-gateway/deepseek/deepseek-v4.1-flash')
  assert.equal(model.contextWindow, 1048576)
  assert.equal(createModel().label, model.label)
})

test('only Vercel routing is admitted while model selection remains configurable', () => {
  assert.throws(() => parseOptions(['--provider', 'openai'], {}), /Unknown option/)
  assert.throws(() => parseOptions(['--base-url', 'http://localhost/v1'], {}), /Unknown option/)
  assert.throws(() => parseOptions(['--context-window', '64000'], {}), /Unknown option/)
  assert.throws(() => parseOptions([], { LOOM_PROVIDER: 'anthropic' }), /Only Vercel/)
  assert.throws(() => createModel({ provider: 'openai', model: 'gpt-5.4' }), /Only Vercel/)
  assert.equal(parseOptions(['--model', 'openai/gpt-5.4'], { LOOM_MODEL: 'other' }).model, 'openai/gpt-5.4')
  assert.equal(parseOptions([], { LOOM_MODEL: 'openai/gpt-5.4' }).model, 'openai/gpt-5.4')
  const models = listModels()
  assert.ok(models.length > 0)
  assert.ok(models.every(model => model.startsWith('vercel-ai-gateway/')))
})

test('missing Vercel credentials fail before opening a workspace or entering the TUI', async t => {
  const previous = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  await assert.rejects(main(['--cwd', '/does-not-exist', '--print', 'Inspect']), /Set AI_GATEWAY_API_KEY/)
})

test('real Pi adapter streams text and preserves tool-call envelopes without paid APIs', async () => {
  const faux = fauxProvider({ provider: 'vercel-ai-gateway' })
  faux.setResponses([fauxAssistantMessage([fauxText('Evidence'), fauxToolCall('list_files', {})], { stopReason: 'toolUse' })])
  const collection = createModels()
  collection.setProvider(faux.provider)
  const selected = faux.getModel()
  const model = createModel({ collection, provider: selected.provider, model: selected.id })
  let text = ''
  const result = await model.complete({ system: 'test', messages: [{ role: 'user', content: 'Inspect', timestamp: 1 }], tools: [] }, { signal: new AbortController().signal, onDelta: delta => { text += delta } })
  assert.equal(text, 'Evidence')
  assert.equal(result.stopReason, 'toolUse')
  assert.equal(result.content.find(part => part.type === 'toolCall').name, 'list_files')
})

// localModels injects an offline HTTP transport to test stream and tool contracts without exposing endpoint configuration.
function localModels (baseUrl) {
  const models = createModels()
  models.setProvider(createProvider({
    id: 'vercel-ai-gateway',
    name: 'Offline test transport',
    baseUrl,
    auth: { apiKey: { name: 'test', resolve: async () => ({ auth: { apiKey: 'offline-test' } }) } },
    models: [{ id: 'local-model', name: 'local-model', api: 'openai-completions', provider: 'vercel-ai-gateway', baseUrl, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 8192 }],
    api: openAICompletionsApi()
  }))
  return models
}

test('injected offline HTTP adapter sends a streaming request and decodes a local SSE response', async t => {
  let request
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    request = JSON.parse(text)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = { id: 'local-response', object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Local evidence' }, finish_reason: null }] }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const collection = localModels(`http://127.0.0.1:${server.address().port}/v1`)
  const model = createModel({ collection, provider: 'vercel-ai-gateway', model: 'local-model' })
  let text = ''
  const result = await model.complete({ system: 'Inspect', messages: [{ role: 'user', content: 'Task', timestamp: 1 }], tools: [] }, { signal: new AbortController().signal, onDelta: delta => { text += delta } })
  assert.equal(result.stopReason, 'stop', result.errorMessage)
  assert.equal(text, 'Local evidence')
  assert.equal(request.model, 'local-model')
  assert.equal(request.stream, true)
})

test('real HTTP tool calls create a file and feed the committed result back to the provider', async t => {
  const { cwd, session } = await fixture(t)
  const requests = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    requests.push(JSON.parse(text))
    const first = requests.length === 1
    const delta = first
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'http-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'created.js', content: '// value holds the example result.\nexport const value = 1\n' }) } }] }
      : { role: 'assistant', content: 'File verified from tool evidence' }
    const chunk = { id: `response-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [{ index: 0, delta, finish_reason: null }] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const collection = localModels(`http://127.0.0.1:${server.address().port}/v1`)
  const model = createModel({ collection, provider: 'vercel-ai-gateway', model: 'local-model' })
  const agent = new Agent({ cwd, session, model, mode: 'edit' })
  await agent.initialize()
  await agent.enqueue('Create the example file')
  await agent.wait()
  assert.equal(agent.status, 'idle')
  assert.equal(requests.length, 2)
  assert.match(await readFile(path.join(cwd, 'created.js'), 'utf8'), /export const value = 1/)
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'write_file'))
  assert.match(requests[1].messages.find(message => message.role === 'tool').content, /Saved created.js/)
})
