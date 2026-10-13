import { validateMode } from '../core/modes.js'
import { validateLanguage } from './i18n.js'

// budgetSnapshot copies counters while preserving the previous reference when values have not changed.
function budgetSnapshot (budget, previous) {
  if (!budget) return previous
  const snapshot = { calls: budget.calls || 0, tokens: budget.tokens || 0, cost: budget.cost || 0 }
  return previous && Object.keys(snapshot).every(key => snapshot[key] === previous[key]) ? previous : snapshot
}

// changeLanguage validates the requested display language and avoids unchanged updates.
function changeLanguage (state, event) {
  const language = validateLanguage(event.language)
  return language === state.language ? state : { ...state, language }
}

// changeMode validates the projected permission mode without changing execution authority.
function changeMode (state, event) {
  const mode = validateMode(event.mode)
  return mode === state.mode ? state : { ...state, mode }
}

// closeDialog removes one overlay's metadata without notifying for missing IDs.
function closeDialog (state, event) {
  const dialogs = state.dialogs.filter(dialog => dialog.id !== event.id)
  return dialogs.length === state.dialogs.length ? state : { ...state, dialogs }
}

// changeStatus replaces display status and a copied budget snapshot only when necessary.
function changeStatus (state, status, counters) {
  const budget = budgetSnapshot(counters, state.budget)
  return status === state.status && budget === state.budget ? state : { ...state, status, budget }
}

// showToolProgress converts structured process progress into display data without retaining tool objects.
function showToolProgress (state, event) {
  const status = event.kind === 'process.started' ? { kind: event.kind, boundary: event.boundary, pid: event.pid } : event.text
  return changeStatus(state, status, event.budget)
}

// queueInput adds an admitted input while preserving previous queue snapshots.
function queueInput (state, event) {
  const queued = new Map(state.queued)
  queued.set(event.inputId, { text: event.text, delivery: event.delivery })
  return { ...state, queued }
}

// deliverInput removes an admitted input after its visible user message is committed.
function deliverInput (state, event) {
  if (!state.queued.has(event.inputId)) return state
  const queued = new Map(state.queued)
  queued.delete(event.inputId)
  return { ...state, queued }
}

// startAssistant allocates the transient text for a new model step.
function startAssistant (state, event) {
  const streams = new Map(state.streams)
  streams.set(event.stepId, '')
  return { ...state, streams, budget: budgetSnapshot(event.budget, state.budget) }
}

// appendAssistant ignores late deltas and appends text without mutating older snapshots.
function appendAssistant (state, event) {
  if (!state.streams.has(event.stepId)) return state
  const streams = new Map(state.streams)
  streams.set(event.stepId, streams.get(event.stepId) + event.text)
  return { ...state, streams, budget: budgetSnapshot(event.budget, state.budget) }
}

// finishAssistant removes transient text once the authoritative assistant response is committed.
function finishAssistant (state, event) {
  if (!state.streams.has(event.stepId)) return state
  const streams = new Map(state.streams)
  streams.delete(event.stepId)
  return { ...state, streams, budget: budgetSnapshot(event.budget, state.budget) }
}

// failAssistant drops transient streams after an operation fails while preserving its visible transcript.
function failAssistant (state, event) {
  const budget = budgetSnapshot(event.budget, state.budget)
  if (!state.streams.size && budget === state.budget) return state
  return { ...state, streams: new Map(), budget }
}

// transitions maps mutually exclusive event names to pure display-state transformations.
export const transitions = Object.freeze({
  'ui.language': changeLanguage,
  'mode.changed': changeMode,
  'ui.closing': state => state.closing ? state : { ...state, closing: true },
  'ui.closed': state => ({ ...state, closing: true, closed: true, streams: new Map(), queued: new Map(), dialogs: [] }),
  'ui.dialog.opened': (state, event) => ({ ...state, dialogs: [...state.dialogs, { ...event.dialog }] }),
  'ui.dialog.closed': closeDialog,
  'ui.status': (state, event) => changeStatus(state, event.status, event.budget),
  status: (state, event) => changeStatus(state, event.text, event.budget),
  'tool.progress': showToolProgress,
  queued: queueInput,
  user: deliverInput,
  'assistant.start': startAssistant,
  'assistant.delta': appendAssistant,
  'assistant.end': finishAssistant,
  error: failAssistant
})
