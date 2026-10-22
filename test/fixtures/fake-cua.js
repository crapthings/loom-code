import { createInterface } from 'node:readline'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

// screenshot supplies a tiny PNG without opening a desktop or calling a provider.
const screenshot = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII='

// tools represents a small Driver catalog including a tool that Loom must not expose.
const tools = [
  { name: 'check_permissions', inputSchema: { type: 'object', properties: { prompt: { type: 'boolean' }, probe_direct_capture: { type: 'boolean' }, session: { type: 'string' } }, additionalProperties: false } },
  { name: 'list_windows', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_window_state', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, session: { type: 'string' } }, required: ['pid'], additionalProperties: false } },
  { name: 'press_key', inputSchema: { type: 'object', properties: { key: { type: 'string' }, session: { type: 'string' } }, required: ['key'], additionalProperties: false } },
  { name: 'browser_prepare', inputSchema: { type: 'object', properties: { profile: { type: 'object', properties: { mode: { type: 'string' } } }, strategy: { type: 'object' } }, required: ['profile'] } },
  { name: 'kill_app', inputSchema: { type: 'object', properties: {} } }
]

// send writes exactly one MCP stdio message without diagnostic output on stdout.
function send (message) { process.stdout.write(`${JSON.stringify(message)}\n`) }

// handle implements the pinned modern protocol and observable fake actions for interruption tests.
function handle (request) {
  appendFileSync(process.argv[2], `${JSON.stringify(request)}\n`)
  if (request.id === undefined) return
  const { method, params = {} } = request
  let result = { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
  if (method === 'server/discover') result = { ...result, supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'fake-cua', version: '0.28.0' } } }
  else if (method === 'tools/list') result.tools = tools
  else if (method === 'resources/read') result.contents = [{ uri: params.uri, mimeType: 'text/markdown', text: 'Observe the selected window before and after input.' }]
  else if (method === 'tools/call') {
    if (params.name === 'check_permissions') {
      const file = `${process.argv[2]}.permissions.json`
      const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { accessibility: true, screen_recording: true, direct_capture_status: 'not_checked' }
      result.content = [{ type: 'text', text: JSON.stringify(report) }]
      send({ jsonrpc: '2.0', id: request.id, result })
      return
    }
    const key = params.arguments?.key
    if (key === 'permissions_pending') {
      result.isError = true
      result.content = [{ type: 'text', text: 'permissions_pending: macOS Accessibility or Screen Recording permission is still pending; no action started, retry after the permission gate completes' }]
      result.structuredContent = { code: 'tool_invocation_failed', exit_code: 75 }
      send({ jsonrpc: '2.0', id: request.id, result })
      return
    }
    if (key === 'disconnect') { process.exit(0); return }
    if (key === 'hang') {
      send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: params._meta?.progressToken, progress: 1, message: 'Fake input accepted; result pending' } })
      return
    }
    result.content = [{ type: 'text', text: params.name === 'get_window_state' ? 'Window 7, pid 42; inspect the attached screenshot.' : 'Action delivered; verify with a fresh observation.' }]
    if (params.name === 'get_window_state') result.content.push({ type: 'image', mimeType: 'image/png', data: screenshot })
    if (key === 'error') result.isError = true
  } else { send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unknown method' } }); return }
  send({ jsonrpc: '2.0', id: request.id, result })
}

// input ends the fixture when its owning client closes the connection.
const input = createInterface({ input: process.stdin })
input.on('line', line => handle(JSON.parse(line)))
input.on('close', () => process.exit(0))
