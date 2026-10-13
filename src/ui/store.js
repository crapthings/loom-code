import { createStore } from 'zustand/vanilla'
import { transitions } from './transitions.js'
import { validateMode } from '../core/modes.js'
import { validateLanguage } from './i18n.js'

// uiTransition guards lifecycle boundaries before dispatching an event to its pure display transition.
export function uiTransition (state, event) {
  if (state.closed || event.child) return state
  if (!Object.hasOwn(transitions, event.type)) return state
  return transitions[event.type](state, event)
}

// createUiStore creates one app's ephemeral view state with event-only writes and disposable subscriptions.
export function createUiStore ({ language = 'en', mode = 'ask' } = {}) {
  const store = createStore(() => ({ language: validateLanguage(language), mode: validateMode(mode), status: 'idle', budget: { calls: 0, tokens: 0, cost: 0 }, streams: new Map(), queued: new Map(), dialogs: [], closing: false, closed: false }))
  return { getState: store.getState, subscribe: store.subscribe, dispatch: event => store.setState(state => uiTransition(state, event), true) }
}
