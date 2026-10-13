// modes lists the user-selectable permission levels displayed by the terminal interface.
export const modes = Object.freeze(['ask', 'edit', 'auto', 'plan'])

// validateMode rejects unknown permission levels before any runtime state changes.
export function validateMode (mode) {
  if (!modes.includes(mode)) throw new Error('Permission mode must be ask, edit, auto, or plan')
  return mode
}
