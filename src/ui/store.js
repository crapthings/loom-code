import { createStore } from 'zustand/vanilla'
import { validateMode } from '../core/modes.js'
import { validateLanguage } from './i18n.js'

// budgetSnapshot copies display counters so mutable execution budgets never enter the UI store.
function budgetSnapshot (budget, previous) {
  if (!budget) return previous
  const snapshot = { calls: budget.calls || 0, tokens: budget.tokens || 0, cost: budget.cost || 0 }
  return previous && Object.keys(snapshot).every(key => snapshot[key] === previous[key]) ? previous : snapshot
}

// uiTransition projects engine events and local UI actions into immutable display state without executing effects.
export function uiTransition (state, event) {
  if (event.child) return state
  if (event.type === 'ui.language') return { ...state, language: validateLanguage(event.language) }
  if (event.type === 'mode.changed') return { ...state, mode: validateMode(event.mode) }
  if (event.type === 'ui.closing') return { ...state, closing: true }
  if (event.type === 'ui.closed') return { ...state, streams: new Map(), queued: new Map(), dialogs: [] }
  if (event.type === 'ui.dialog.opened') return { ...state, dialogs: [...state.dialogs, { ...event.dialog }] }
  if (event.type === 'ui.dialog.closed') return { ...state, dialogs: state.dialogs.filter(dialog => dialog.id !== event.id) }
  if (event.type === 'ui.status' || event.type === 'status' || event.type === 'tool.progress') {
    const status = event.type === 'ui.status' ? event.status : event.kind === 'process.started' ? { kind: event.kind, boundary: event.boundary, pid: event.pid } : event.text
    const budget = budgetSnapshot(event.budget, state.budget)
    return status === state.status && budget === state.budget ? state : { ...state, status, budget }
  }
  if (event.type === 'queued') {
    const queued = new Map(state.queued)
    queued.set(event.inputId, { text: event.text, delivery: event.delivery })
    return { ...state, queued }
  }
  if (event.type === 'user') {
    if (!state.queued.has(event.inputId)) return state
    const queued = new Map(state.queued)
    queued.delete(event.inputId)
    return { ...state, queued }
  }
  if (event.type === 'assistant.start' || event.type === 'assistant.delta' || event.type === 'assistant.end') {
    if (event.type !== 'assistant.start' && !state.streams.has(event.stepId)) return state
    const streams = new Map(state.streams)
    if (event.type === 'assistant.start') streams.set(event.stepId, '')
    if (event.type === 'assistant.delta') streams.set(event.stepId, streams.get(event.stepId) + event.text)
    if (event.type === 'assistant.end') streams.delete(event.stepId)
    return { ...state, streams, budget: budgetSnapshot(event.budget, state.budget) }
  }
  return state
}

// createUiStore creates one app's ephemeral view state with event-only writes and disposable subscriptions.
export function createUiStore ({ language = 'en', mode = 'ask' } = {}) {
  const store = createStore(() => ({ language: validateLanguage(language), mode: validateMode(mode), status: 'idle', budget: { calls: 0, tokens: 0, cost: 0 }, streams: new Map(), queued: new Map(), dialogs: [], closing: false }))
  return { getState: store.getState, subscribe: store.subscribe, dispatch: event => store.setState(state => uiTransition(state, event), true) }
}
