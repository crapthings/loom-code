import test from 'node:test'
import assert from 'node:assert/strict'
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { createModel } from '../src/model/provider.js'
import { compatibleModels } from '../src/model/compatible.js'
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

test('explicit provider and model selections override the Vercel defaults', () => {
  assert.equal(parseOptions(['--provider', 'vercel'], {}).provider, 'vercel-ai-gateway')
  assert.equal(parseOptions(['--provider', 'openai'], {}).model, 'gpt-5.4')
  assert.equal(parseOptions([], { LOOM_PROVIDER: 'anthropic' }).model, 'claude-sonnet-4-6')
  assert.equal(parseOptions(['--model', 'openai/gpt-5.4'], { LOOM_MODEL: 'other' }).model, 'openai/gpt-5.4')
  assert.equal(parseOptions(['--base-url', 'http://localhost/v1', '--model', 'local'], {}).model, 'local')
  assert.throws(() => parseOptions(['--base-url', 'http://localhost/v1'], {}), /explicit --model/)
})

test('missing Vercel credentials fail before opening a workspace or entering the TUI', async t => {
  const previous = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  await assert.rejects(main(['--provider', 'vercel', '--cwd', '/does-not-exist', '--print', 'Inspect']), /Set AI_GATEWAY_API_KEY/)
})

test('real Pi adapter streams text and preserves tool-call envelopes without paid APIs', async () => {
  const faux = fauxProvider()
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

test('compatible endpoints validate URL configuration and retain their explicit context window', () => {
  assert.throws(() => compatibleModels('file:///tmp/key', 'test'), /HTTP/)
  assert.throws(() => compatibleModels('http://user:secret@localhost/v1', 'test'), /credentials/)
  const collection = compatibleModels('http://localhost:11434/v1', 'local-model', 64000)
  assert.equal(createModel({ collection, provider: 'compatible', model: 'local-model' }).contextWindow, 64000)
})

test('compatible HTTP adapter sends a streaming request and decodes a local SSE response', async t => {
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
  const collection = compatibleModels(`http://127.0.0.1:${server.address().port}/v1`, 'local-model')
  const model = createModel({ collection, provider: 'compatible', model: 'local-model' })
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
  const collection = compatibleModels(`http://127.0.0.1:${server.address().port}/v1`, 'local-model')
  const model = createModel({ collection, provider: 'compatible', model: 'local-model' })
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
