// estimateTokens estimates serialized UTF-8 prompt size when a provider tokenizer is unavailable.
export function estimateTokens (value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3)
}

// promptEnvelopeBytes accounts for the fixed JSON property names and separators around prompt components.
const promptEnvelopeBytes = Buffer.byteLength('{"system":,"messages":,"tools":}')

// contextBudget reserves bounded output space and reports estimated input components independently of billed usage.
export function contextBudget ({ model, system = '', messages = [], tools = [] }) {
  const window = model.contextWindow
  const output = Math.max(1, Math.floor(Math.min(8192, model.maxOutputTokens || 8192, window * 0.2)))
  const safety = Math.ceil(window * 0.1)
  const inputLimit = Math.max(1, window - output - safety)
  const bytes = { instructions: Buffer.byteLength(JSON.stringify(system), 'utf8'), messages: Buffer.byteLength(JSON.stringify(messages), 'utf8'), tools: Buffer.byteLength(JSON.stringify(tools), 'utf8') }
  const components = { instructions: Math.ceil(bytes.instructions / 3), messages: Math.ceil(bytes.messages / 3), tools: Math.ceil(bytes.tools / 3) }
  const input = Math.ceil((bytes.instructions + bytes.messages + bytes.tools + promptEnvelopeBytes) / 3)
  return { estimated: true, window, input, output, safety, inputLimit, compactAt: Math.min(Math.floor(window * 0.65), inputLimit), components }
}
