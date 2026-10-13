import { Type } from '@earendil-works/pi-ai'

// memoryTools exposes scoped source-backed memory through the normal read and write permission boundary.
export function memoryTools ({ session, memory }) {
  const id = Type.String({ minLength: 1, maxLength: 80 })
  const revision = Type.Integer({ minimum: 1 })
  const optional = Type.Optional
  const status = Type.Union([Type.Literal('stale'), Type.Literal('archived')])
  const mutate = (action, args, { signal, call }) => memory.request(action, { ...args, operationId: `${session.id}:${call.id}` }, { signal }).then(JSON.stringify)
  return [{
    name: 'list_memories',
    description: 'Find explicit project memories by literal text; file limits applicability to project rules and matching path scopes. Sources are unchecked in listings; use get_memory before relying on a record. Use nextOffset to paginate.',
    effect: 'read',
    parameters: Type.Object({ query: optional(Type.String({ maxLength: 200 })), file: optional(Type.String({ maxLength: 512 })), includeInactive: optional(Type.Boolean()), limit: optional(Type.Integer({ minimum: 1, maximum: 20 })), offset: optional(Type.Integer({ minimum: 0, maximum: 10000 })) }),
    execute: async (args, { signal }) => JSON.stringify(await memory.request('list', args, { signal }))
  }, {
    name: 'get_memory',
    description: 'Read a memory and check its original source events; missing, changed or expired evidence marks it stale. Optionally inspect an older immutable revision. Available evidence does not prove the current code still agrees.',
    effect: 'read',
    parameters: Type.Object({ id, revision: optional(revision) }),
    execute: async (args, { signal }) => JSON.stringify(await memory.request('get', args, { signal }))
  }, {
    name: 'remember',
    description: 'Only on an explicit user request, save a project or relative-path memory backed by 1–8 original user inputs or successful tool events. Source seq refers to the JSONL event sequence; omitted sessionId means this session. Updating requires id and expectedRevision; supply full replacement fields and sources. Omitted expiresAt removes expiry on update. Never store assistant guesses, secrets, or recalled copies.',
    effect: 'write',
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }), kind: optional(Type.Union(['preference', 'convention', 'fact'].map(value => Type.Literal(value)))), scope: optional(Type.Union(['project', 'path'].map(value => Type.Literal(value)))), path: optional(Type.String({ maxLength: 512 })), sources: Type.Array(Type.Object({ sessionId: optional(Type.String({ pattern: '^[a-zA-Z0-9-]{1,80}$' })), seq: Type.Integer({ minimum: 0 }) }), { minItems: 1, maxItems: 8 }), id: optional(id), expectedRevision: optional(revision), expiresAt: optional(Type.Integer({ minimum: 1 })) }),
    execute: (args, context) => mutate('save', { ...args, sources: args.sources.map(source => ({ ...source, sessionId: source.sessionId || session.id })) }, context)
  }, {
    name: 'forget_memory',
    description: 'Mark an explicitly identified memory stale or archived with a reason and expectedRevision. Archives retain immutable revisions and sources; this is not physical erasure.',
    effect: 'write',
    parameters: Type.Object({ id, expectedRevision: revision, status, reason: Type.String({ minLength: 1, maxLength: 500 }) }),
    execute: (args, context) => mutate('invalidate', args, context)
  }]
}
