// taskMetrics reports observed work and billed usage without equating changes, execution or classifier judgments with correctness.
export function taskMetrics (session, from) {
  const start = session.events.find(event => event.seq >= from && event.type === 'inbox.delivered')
  const events = session.events.filter(event => event.seq >= (start?.seq ?? from))
  const tools = events.filter(event => event.type === 'tool.finished')
  const changes = events.filter(event => ['tool.finished', 'process.finished'].includes(event.type) && event.changes?.count)
  const observedProcesses = new Set(events.filter(event => event.type === 'process.finished' && event.changes && !event.changes.unavailable).map(event => event.callId))
  const usage = events.filter(event => ['step.finished', 'decision.finished', 'context.compacted'].includes(event.type))
  return {
    from,
    tools: tools.length,
    observedChangedFiles: new Set(changes.flatMap(event => event.changes.files.map(file => file.path))).size,
    firstObservedChangeMs: changes.length && start ? changes[0].at - start.at : null,
    unobservedMutations: tools.filter(event => event.executed && !observedProcesses.has(event.callId) && (!event.changes || event.changes.unavailable) && ['shell', 'write_file', 'edit_file', 'restore_checkpoint'].includes(event.message?.toolName)).length,
    interventions: events.filter(event => event.type === 'progress.directed').length,
    followups: events.filter(event => event.type === 'progress.followup').map(event => ({ seq: event.seq, action: event.action, outcome: event.outcome, rounds: event.rounds, changedFiles: event.changedFiles })),
    reportedTokens: usage.reduce((sum, event) => sum + (event.usage?.totalTokens || 0), 0),
    reportedCost: usage.reduce((sum, event) => sum + (event.usage?.cost?.total || 0), 0),
    usageMissing: usage.filter(event => !event.usage).length
  }
}
