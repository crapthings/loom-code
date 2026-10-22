// estimateBytes excludes encoded raster data and reserves a provisional fixed allowance per image.
function estimateBytes (value) {
  let images = 0
  const text = JSON.stringify(value, (key, part) => {
    if (part?.type === 'image') { images++; return { type: 'image', mimeType: part.mimeType, artifact: part.artifact } }
    return part
  })
  return Buffer.byteLength(text, 'utf8') + images * 4096 * 3
}

// estimateTokens estimates text plus image allowances when a provider tokenizer is unavailable.
export function estimateTokens (value) {
  return Math.ceil(estimateBytes(value) / 3)
}

// promptEnvelopeBytes accounts for the fixed JSON property names and separators around prompt components.
const promptEnvelopeBytes = Buffer.byteLength('{"system":,"messages":,"tools":}')

// contextBudget reserves bounded output space and reports estimated input components independently of billed usage.
export function contextBudget ({ model, system = '', messages = [], tools = [] }) {
  const window = model.contextWindow
  const output = Math.max(1, Math.floor(Math.min(8192, model.maxOutputTokens || 8192, window * 0.2)))
  const safety = Math.ceil(window * 0.1)
  const inputLimit = Math.max(1, window - output - safety)
  const bytes = { instructions: estimateBytes(system), messages: estimateBytes(messages), tools: estimateBytes(tools) }
  const components = { instructions: Math.ceil(bytes.instructions / 3), messages: Math.ceil(bytes.messages / 3), tools: Math.ceil(bytes.tools / 3) }
  const input = Math.ceil((bytes.instructions + bytes.messages + bytes.tools + promptEnvelopeBytes) / 3)
  return { estimated: true, window, input, output, safety, inputLimit, compactAt: Math.min(Math.floor(window * 0.65), inputLimit), components }
}
