import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { hashText, resolveFile, saveFile } from './files.js'

// latestCheckpoint selects the newest original edit that has not already been restored.
export function latestCheckpoint (session) {
  const restored = new Set(session.events.filter(event => event.type === 'file.restored').map(event => event.checkpoint))
  return session.events.findLast(event => event.type === 'file.checkpoint' && !event.restoration && !restored.has(event.checkpoint))
}

// checkpointTool restores a before-edit state only when the file still matches the recorded post-edit version.
export function checkpointTool (cwd, session) {
  return {
    name: 'restore_checkpoint',
    description: 'Undo a file edit by its checkpoint ID only if the file still matches the recorded post-edit version.',
    effect: 'write',
    parallel: false,
    parameters: Type.Object({ id: Type.String({ pattern: '^[a-f0-9-]{36}$' }) }),
    execute: async ({ id }, { signal }) => {
      const event = session.events.find(event => event.type === 'file.checkpoint' && event.checkpoint === id)
      if (!event) throw new Error('Unknown checkpoint')
      if (session.events.some(event => event.type === 'file.restored' && event.checkpoint === id)) throw new Error('Checkpoint has already been restored')
      const snapshot = JSON.parse(await readFile(path.join(session.directory, 'checkpoints', `${id}.json`), 'utf8'))
      const file = await resolveFile(cwd, event.path, true)
      const current = await readFile(file, 'utf8')
      if (hashText(current) !== snapshot.nextHash) throw new Error('File changed since this edit; refusing to overwrite subsequent work')
      signal.throwIfAborted()
      if (snapshot.previous === null) await unlink(file)
      else await saveFile(session, file, event.path, current, snapshot.previous, signal, true)
      await session.append('file.restored', { checkpoint: id, path: event.path })
      return `Restored ${event.path} from checkpoint ${id}`
    }
  }
}
