// updateActivity projects execution events into a bounded live indicator without changing execution authority.
export function updateActivity (activity, event) {
  if (event.source === 'process-control') return activity
  const now = event.at ?? Date.now()
  if (event.child) return activity && ['tool.progress', 'tool.end', 'assistant.delta', 'status'].includes(event.type) ? { ...activity, lastEvent: now } : activity
  let phase
  if (['status', 'ui.status'].includes(event.type)) {
    const status = event.text ?? event.status
    if (['idle', 'failed', 'interrupted', 'recovery required'].includes(status)) return null
    if (status === 'running' && activity) return activity
    phase = status
  }
  if (event.type === 'assistant.start') phase = 'waiting'
  if (event.type === 'assistant.delta') phase = 'receiving'
  if (event.type === 'assistant.retry') phase = 'retrying'
  if (event.type === 'assistant.end') phase = 'running'
  if (event.type === 'progress.assessment.start') phase = 'assessing'
  if (event.type === 'progress.assessment.end') phase = 'running'
  if (event.type === 'completion.assessment.start') phase = 'verifying'
  if (event.type === 'completion.assessment.end') phase = 'running'
  if (event.type === 'tool.start') phase = 'tools'
  if (event.type === 'tool.end') phase = 'running'
  if (event.type === 'error' || event.type === 'ui.closing' || event.type === 'ui.closed') return null
  if (!phase && !['tool.progress', 'process.state'].includes(event.type)) return activity
  if (!activity && !phase) return activity
  const tools = { ...activity?.tools }
  if (event.type === 'tool.start') tools[event.call.id] = event.call.name
  if (event.type === 'tool.end') delete tools[event.call.id]
  if (Object.keys(tools).length) phase = 'tools'
  phase ||= activity.phase
  return { phase, tools, started: activity?.started ?? now, since: activity?.phase === phase ? activity.since : now, lastEvent: now }
}

// outputPreview preserves the beginning and final output while bounding terminal rendering work.
export function outputPreview (text, limit = 2500) {
  const value = String(text)
  return value.length <= limit ? value : `${value.slice(0, 500)}\n[…]\n${value.slice(-(limit - 505))}`
}
