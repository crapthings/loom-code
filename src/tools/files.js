import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'

// hashText identifies the exact UTF-8 file version observed by an agent.
export function hashText (text) {
  return createHash('sha256').update(text).digest('hex')
}

// resolveFile confines built-in file tools to canonical workspace paths and excludes harness metadata.
export async function resolveFile (cwd, input, create = false) {
  const root = await realpath(cwd)
  const file = path.resolve(root, input)
  const relative = path.relative(root, file)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the workspace')
  if (relative.split(path.sep).some(part => ['.git', '.loom'].includes(part))) throw new Error('Protected metadata path')
  let canonical
  try {
    canonical = await realpath(file)
    if (create && (await lstat(file)).isSymbolicLink()) throw new Error('Writing through a symlink is disabled')
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw error
    canonical = path.join(await realpath(path.dirname(file)), path.basename(file))
  }
  const actual = path.relative(root, canonical)
  if (actual === '..' || actual.startsWith(`..${path.sep}`) || path.isAbsolute(actual)) throw new Error('Symlink resolves outside the workspace')
  if (actual.split(path.sep).some(part => ['.git', '.loom'].includes(part))) throw new Error('Symlink resolves to protected metadata')
  return canonical
}

// readText refuses binary and oversized files before loading their contents into memory.
async function readText (file) {
  if ((await stat(file)).size > 2 * 1024 * 1024) throw new Error('File exceeds the 2 MiB text limit')
  const text = await readFile(file, 'utf8')
  if (text.includes('\0')) throw new Error('Binary files are not supported by text tools')
  return text
}

// fileTools provides version-checked file inspection and reversible workspace edits.
export function fileTools (cwd, session) {
  return [
    {
      name: 'read_file',
      description: 'Read workspace text with line numbers and a SHA-256 version for subsequent writes.',
      effect: 'read',
      parallel: true,
      parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      execute: async ({ path: input, offset = 1, limit = 200 }) => {
        const text = await readText(await resolveFile(cwd, input))
        const lines = text.split('\n')
        return `sha256: ${hashText(text)}\nlines: ${lines.length}\n${lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line}`).join('\n')}`
      }
    },
    {
      name: 'list_files',
      description: 'List a bounded workspace tree while skipping dependency, Git, and harness directories.',
      effect: 'read',
      parallel: true,
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async ({ path: input = '.' }, { signal }) => (await walkFiles(cwd, input, signal)).join('\n')
    },
    {
      name: 'search',
      description: 'Search a literal string in workspace text and return bounded file:line matches.',
      effect: 'read',
      parallel: true,
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) }),
      execute: async ({ query, path: input = '.' }, { signal }) => {
        const results = []
        for (const entry of await walkFiles(cwd, input, signal)) {
          signal.throwIfAborted()
          const file = await resolveFile(cwd, entry)
          if ((await stat(file)).size > 256 * 1024) continue
          const text = await readFile(file, 'utf8')
          if (text.includes('\0')) continue
          for (const [index, line] of text.split('\n').entries()) {
            if (line.includes(query)) results.push(`${entry}:${index + 1}: ${line.slice(0, 500)}`)
            if (results.length >= 200) return `${results.join('\n')}\n[Match limit reached; narrow the search]`
          }
        }
        return results.join('\n') || 'No matches'
      }
    },
    {
      name: 'write_file',
      description: 'Create a file or replace an existing file using its expected SHA-256; parent directories must already exist.',
      effect: 'write',
      parallel: false,
      parameters: Type.Object({ path: Type.String(), content: Type.String(), expectedHash: Type.Optional(Type.String()) }),
      execute: async ({ path: input, content, expectedHash }, { signal }) => {
        const file = await resolveFile(cwd, input, true)
        let previous = null
        try { previous = await readText(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (previous !== null && hashText(previous) !== expectedHash) throw new Error('File changed or expectedHash missing; read it again before overwriting')
        if (previous === null && expectedHash) throw new Error('Expected file no longer exists')
        return saveFile(session, file, input, previous, content, signal)
      }
    },
    {
      name: 'edit_file',
      description: 'Replace exactly one matching text span and preserve a before-edit checkpoint.',
      effect: 'write',
      parallel: false,
      parameters: Type.Object({ path: Type.String(), oldText: Type.String({ minLength: 1 }), newText: Type.String(), expectedHash: Type.String() }),
      execute: async ({ path: input, oldText, newText, expectedHash }, { signal }) => {
        const file = await resolveFile(cwd, input, true)
        const previous = await readText(file)
        if (hashText(previous) !== expectedHash) throw new Error('File changed; read it again before editing')
        const index = previous.indexOf(oldText)
        if (index < 0 || previous.indexOf(oldText, index + 1) >= 0) throw new Error('oldText must match exactly once')
        return saveFile(session, file, input, previous, previous.replace(oldText, () => newText), signal)
      }
    }
  ]
}

// walkFiles enumerates at most five thousand regular files without following directory symlinks.
async function walkFiles (cwd, input, signal) {
  cwd = await realpath(cwd)
  const first = await resolveFile(cwd, input)
  if ((await stat(first)).isFile()) return [path.relative(cwd, first)]
  const pending = [first]
  const files = []
  while (pending.length && files.length < 5000) {
    signal.throwIfAborted()
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      if (['.git', '.loom', 'node_modules', 'vendor', 'dist', 'coverage'].includes(entry.name)) continue
      const file = path.join(entry.parentPath, entry.name)
      if (entry.isDirectory()) pending.push(file)
      if (entry.isFile()) files.push(path.relative(cwd, file))
    }
  }
  return files.sort()
}

// saveFile writes a checkpoint before replacing a version-checked file and records the resulting hash.
export async function saveFile (session, file, input, previous, content, signal, restoration = false) {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Write exceeds the 2 MiB text limit')
  signal.throwIfAborted()
  const checkpoint = randomUUID()
  const directory = path.join(session.directory, 'checkpoints')
  await mkdir(directory, { recursive: true })
  const snapshot = await open(path.join(directory, `${checkpoint}.json`), 'wx', 0o600)
  await snapshot.writeFile(JSON.stringify({ path: input, previous, nextHash: hashText(content) }))
  await snapshot.sync()
  await snapshot.close()
  await session.append('file.checkpoint', { path: input, checkpoint, nextHash: hashText(content), restoration })
  signal.throwIfAborted()
  if (previous === null) {
    const handle = await open(file, 'wx', 0o644)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
  } else {
    const mode = (await stat(file)).mode
    const temporary = `${file}.loom-${checkpoint}`
    const handle = await open(temporary, 'wx', mode)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    if (hashText(await readText(file)) !== hashText(previous)) throw new Error('File changed during edit; checkpoint preserved')
    await rename(temporary, file)
  }
  return `Saved ${input}; sha256: ${hashText(content)}; checkpoint: ${checkpoint}`
}
