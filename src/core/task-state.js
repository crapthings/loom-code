// boundedInput retains source references and explicitly marks shortened user requirements.
function boundedInput (event) {
  const text = event.message.content
  const truncated = text.length > 4000
  return { seq: event.seq, inputId: event.inputId, text: truncated ? `${text.slice(0, 2000)}\n[omitted; consult source event ${event.seq}]\n${text.slice(-2000)}` : text, truncated }
}

// taskState projects recorded task inputs and tool outcomes without inferring correctness from model claims.
export function taskState (session, { unfinishedOnly = false } = {}) {
  const completed = session.latestEvent ? session.latestEvent('task.finished') : session.events.findLast(event => event.type === 'task.finished')
  const delivered = session.latestEvent ? session.latestEvent('inbox.delivered') : session.events.findLast(event => event.type === 'inbox.delivered')
  const active = Boolean(delivered && delivered.seq > (completed?.seq ?? -1))
  if (unfinishedOnly && !active) return null
  const from = active ? (completed?.seq ?? -1) + 1 : completed?.from ?? 0
  const inputs = []
  const outcomes = []
  let firstInput
  let inputCount = 0
  let outcomeCount = 0
  for (let index = session.events.length - 1; index >= 0; index--) {
    const event = session.events[index]
    if (event.seq < from) break
    if (!active && completed && event.seq > completed.seq) continue
    if (event.type === 'inbox.delivered' && typeof event.message?.content === 'string') {
      firstInput = event
      inputCount++
      if (inputs.length < 7) inputs.push(event)
    }
    if (event.type === 'tool.finished') {
      outcomeCount++
      if (outcomes.length < 12) outcomes.push(event)
    }
  }
  inputs.reverse()
  if (inputCount > 7) inputs.unshift(firstInput)
  outcomes.reverse()
  return {
    version: 1,
    from,
    status: active ? 'unfinished' : completed ? 'execution-finished' : 'empty',
    inputs: inputs.map(boundedInput),
    outcomes: outcomes.map(event => ({ seq: event.seq, callId: event.callId, status: event.status, executed: event.executed })),
    omitted: { inputs: inputCount - inputs.length, outcomes: outcomeCount - outcomes.length }
  }
}
