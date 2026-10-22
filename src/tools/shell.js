import { Type } from '@earendil-works/pi-ai'
import { ProcessManager } from '../execution/processes.js'

// processId limits controls to opaque IDs owned by the current session.
const processId = Type.String({ pattern: '^p-[a-f0-9]{12}$' })

// shellTools expose command launch and process controls through the same durable dispatcher.
export function shellTools (cwd, session, executor, processes = new ProcessManager({ cwd, session, executor })) {
  return [{
    name: 'shell',
    description: `Run a command through ${processes.executor.label}. Output streams to an artifact; do not pipe to tail just to limit output. Long commands return a process ID and finish in the background; do not append & or sleep to wait. Completion is delivered automatically. Use $TMPDIR for temporary files. timeout is an optional execution deadline in seconds (default: none); yield_time_ms only controls how soon this call returns (default: 1000 ms).`,
    effect: 'shell',
    parallel: false,
    tracksWorkspace: true,
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483 })), yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }),
    execute: (args, context) => processes.start(args, context)
  }, {
    name: 'process_status',
    description: 'Inspect this session’s shell processes, or one process and its latest output. Completion arrives automatically; do not repeatedly poll.',
    effect: 'read',
    parallel: true,
    parameters: Type.Object({ id: Type.Optional(processId) }),
    execute: ({ id }, { source }) => processes.status(id, source !== 'process-control')
  }, {
    name: 'process_wait',
    description: 'Wait briefly for an existing shell process without restarting it. Prefer automatic completion delivery when no independent work remains.',
    effect: 'read',
    parallel: true,
    parameters: Type.Object({ id: processId, yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000 })) }),
    execute: ({ id, yield_time_ms: milliseconds = 1000 }, { signal }) => processes.wait(id, milliseconds, signal)
  }, {
    name: 'process_stop',
    description: 'Stop one shell process owned by this session and return its settled result; this does not launch or retry any command.',
    effect: 'cancel',
    parallel: false,
    parameters: Type.Object({ id: processId }),
    execute: async ({ id }, { source }) => {
      processes.stop(id)
      await processes.get(id).done
      return processes.status(id, source !== 'process-control')
    }
  }]
}
