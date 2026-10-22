// visibleMessage projects public text and tool intent without provider metadata or private reasoning.
export function visibleMessage (message) {
  if (!message) return undefined
  const { role, toolCallId, toolName, isError } = message
  const recalled = ['read_history', 'search_history', 'get_memory', 'list_memories'].includes(toolName)
  const content = recalled
    ? [{ type: 'text', text: '[Copied recall output omitted; consult its original source events.]' }]
    : typeof message.content === 'string'
      ? message.content
      : (message.content || []).flatMap(part => part.type === 'text' ? [{ type: 'text', text: part.text }] : part.type === 'toolCall' ? [{ type: 'toolCall', id: part.id, name: part.name, arguments: part.arguments }] : part.type === 'image' ? [{ type: 'text', text: `[Screenshot artifact: ${part.artifact || '(inline image)'}. This text projection does not include pixels; its existence alone does not verify visual behavior.]` }] : [])
  return { role, toolCallId, toolName, isError, content }
}

// evidenceEvent retains source-linked execution facts while excluding internal evaluation payloads and copied recall.
export function evidenceEvent (event) {
  const { seq, id, at, type, callId, source, status, executed, path, checkpoint, nextHash, changes, process, outcome, text, inputId, summary } = event
  return { seq, id, at, type, callId, source, status, executed, path, checkpoint, nextHash, changes, process, outcome, inputId, text, summary, call: event.call, message: visibleMessage(event.message) }
}
