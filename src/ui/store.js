import { createStore } from 'zustand/vanilla'
import { updateActivity } from './activity.js'
import { transitions } from './transitions.js'
import { validateMode } from '../core/modes.js'
import { validateLanguage } from './i18n.js'

// uiTransition guards lifecycle boundaries before dispatching an event to its pure display transition.
export function uiTransition (state, event) {
  if (state.closed) return state
  const projected = !event.child && Object.hasOwn(transitions, event.type) ? transitions[event.type](state, event) : state
  const stale = ['assistant.delta', 'assistant.end', 'assistant.retry'].includes(event.type) && !event.child && !state.streams.has(event.stepId)
  const activity = state.closing ? null : stale ? state.activity : updateActivity(state.activity, event)
  return activity === projected.activity ? projected : { ...projected, activity }
}

// createUiStore creates one app's ephemeral view state with event-only writes and disposable subscriptions.
export function createUiStore ({ language = 'en', mode = 'ask' } = {}) {
  const store = createStore(() => ({ language: validateLanguage(language), mode: validateMode(mode), status: 'idle', activity: null, processes: new Map(), budget: { calls: 0, tokens: 0, cost: 0 }, streams: new Map(), queued: new Map(), dialogs: [], closing: false, closed: false }))
  return { getState: store.getState, subscribe: store.subscribe, dispatch: event => store.setState(state => uiTransition(state, event), true) }
}
