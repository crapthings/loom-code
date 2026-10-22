import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { readText, writeSynced } from '../io.js'
import { Type } from '@earendil-works/pi-ai'
import { protectedNames, isCredentialPath, runtimeRoot } from '../execution/policy.js'

// skippedDirectories omits generated trees only when exploring the workspace root.
const skippedDirectories = new Set(['node_modules', 'vendor', 'dist', 'coverage'])

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
  if (relative.split(path.sep).some(part => protectedNames.includes(part))) throw new Error('Protected metadata path')
  if (isCredentialPath(relative)) throw new Error('Protected credential path')
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
  if (actual.split(path.sep).some(part => protectedNames.includes(part))) throw new Error('Symlink resolves to protected metadata')
  if (isCredentialPath(actual)) throw new Error('Symlink resolves to protected credentials')
  if (create && (canonical === runtimeRoot || canonical.startsWith(`${runtimeRoot}${path.sep}`))) throw new Error('The running Loom installation is protected from tool writes')
  return canonical
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
      description: 'List a bounded workspace tree; root scans skip dependencies and build output, while an explicit subdirectory includes them. Protected paths and symlinks are always excluded.',
      effect: 'read',
      parallel: true,
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async ({ path: input = '.' }, { signal }) => {
        const { files, capped } = await walkFiles(cwd, input, signal)
        return files.join('\n') + (capped ? '\n[File limit reached; narrow the path]' : '')
      }
    },
    {
      name: 'search',
      description: 'Search literal text in workspace files up to 2 MiB each; return at most 200 matching lines with 500-character previews and coverage notices. Root scans skip dependency/build trees; explicit subdirectories include their dependency/build children. Protected paths and symlinks are always excluded.',
      effect: 'read',
      parallel: true,
      parameters: Type.Object({ query: Type.String({ minLength: 1 }), path: Type.Optional(Type.String()) }),
      execute: async ({ query, path: input = '.' }, { signal }) => searchFiles(cwd, input, query, signal)
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
        return saveFile(session, file, input, previous, previous.slice(0, index) + newText + previous.slice(index + oldText.length), signal)
      }
    }
  ]
}

// walkFiles enumerates at most five thousand regular files without following directory symlinks.
async function walkFiles (cwd, input, signal) {
  cwd = await realpath(cwd)
  const first = await resolveFile(cwd, input)
  const excluded = { generated: 0, protected: 0, symlinks: 0, paths: [] }
  if ((await stat(first)).isFile()) return { files: [path.relative(cwd, first)], capped: false, excluded }
  const rootScan = first === cwd
  const pending = [first]
  const files = []
  while (pending.length && files.length < 5000) {
    signal.throwIfAborted()
    for (const entry of await readdir(pending.pop(), { withFileTypes: true })) {
      if (protectedNames.includes(entry.name) || isCredentialPath(entry.name)) { excluded.protected++; continue }
      if (entry.isSymbolicLink()) { excluded.symlinks++; continue }
      const file = path.join(entry.parentPath, entry.name)
      if (rootScan && entry.isDirectory() && skippedDirectories.has(entry.name)) {
        excluded.generated++
        if (excluded.paths.length < 5) excluded.paths.push(path.relative(cwd, file))
        continue
      }
      if (entry.isDirectory()) pending.push(file)
      if (entry.isFile()) files.push(path.relative(cwd, file))
      if (files.length === 5000) break
    }
  }
  return { files: files.sort(), capped: files.length === 5000, excluded }
}

// searchFiles searches bounded text while retaining coverage failures and actionable truncation notices.
async function searchFiles (cwd, input, query, signal) {
  const { files, capped, excluded } = await walkFiles(cwd, input, signal)
  const results = []
  const skipped = []
  let skippedCount = 0
  let scanned = 0
  let limited = false
  let shortened = false
  for (const entry of files) {
    signal.throwIfAborted()
    let text
    try {
      text = await readText(await resolveFile(cwd, entry))
    } catch (error) {
      signal.throwIfAborted()
      skippedCount++
      const reason = error.code === 'LOOM_TEXT_LIMIT' ? 'exceeds 2 MiB' : error.code === 'LOOM_BINARY_FILE' ? 'binary content' : 'unreadable or no longer an allowed regular file'
      if (skipped.length < 5) skipped.push(`${entry}: ${reason}`)
      continue
    }
    scanned++
    for (const [index, line] of text.split('\n').entries()) {
      signal.throwIfAborted()
      const match = line.indexOf(query)
      if (match < 0) continue
      if (results.length === 200) { limited = true; break }
      const start = Math.max(0, match - 100)
      const end = start + 500
      const truncated = start > 0 || end < line.length
      shortened ||= truncated
      results.push(`${entry}:${index + 1}: ${start ? '[…]' : ''}${line.slice(start, end)}${end < line.length ? '[…]' : ''}`)
    }
    if (limited) break
  }
  const excludedCount = excluded.generated + excluded.protected + excluded.symlinks
  const incomplete = capped || limited || skippedCount > 0 || excludedCount > 0
  const summary = results.join('\n') || (incomplete ? 'No matches in successfully searched files; coverage is incomplete.' : 'No matches in searched files.')
  const notices = [`[Coverage: ${incomplete ? 'incomplete' : 'complete within traversal scope'}; read ${scanned}/${files.length} enumerated files; skipped ${skippedCount}.]`]
  if (excludedCount) notices.push(`[Excluded ${excludedCount} traversal entries: ${excluded.generated} dependency/build directories, ${excluded.protected} protected paths, ${excluded.symlinks} symlinks; exclusions are not evidence of absence.]`)
  if (excluded.generated) notices.push(`[Dependency/build paths omitted (up to 5 shown): ${excluded.paths.join(', ')}. Pass a specific allowed subdirectory to include its build output, or a specific allowed file. Protected paths and traversed symlinks remain excluded.]`)
  if (capped) notices.push('[File limit reached (5000); narrow the path. Remaining files were not enumerated.]')
  if (limited) notices.push('[Match limit reached (200); remaining lines/files were not searched. Narrow the query or path.]')
  if (shortened) notices.push('[Matching lines shortened to 500-character previews near the match; use read_file at the reported line for context.]')
  if (skippedCount) notices.push(`[Skipped files (up to 5 shown):\n${skipped.join('\n')}\nUse a permitted shell search for oversized files, or resolve access/path issues. Do not infer absence from skipped files.]`)
  return `${summary}\n\n${notices.join('\n')}`
}

// saveFile writes a checkpoint before replacing a version-checked file and records the resulting hash.
export async function saveFile (session, file, input, previous, content, signal, restoration = false) {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Write exceeds the 2 MiB text limit')
  signal.throwIfAborted()
  const checkpoint = randomUUID()
  const directory = path.join(session.directory, 'checkpoints')
  await mkdir(directory, { recursive: true })
  const nextHash = hashText(content)
  await writeSynced(path.join(directory, `${checkpoint}.json`), JSON.stringify({ path: input, previous, nextHash }), 0o600)
  await session.append('file.checkpoint', { path: input, checkpoint, nextHash, restoration })
  signal.throwIfAborted()
  if (previous === null) {
    await writeSynced(file, content, 0o644)
  } else {
    const mode = (await stat(file)).mode
    const temporary = `${file}.loom-${checkpoint}`
    let created = false
    try {
      // Own the temporary file before writing so cleanup never removes a pre-existing path.
      const handle = await open(temporary, 'wx', mode)
      created = true
      try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
      if (hashText(await readText(file)) !== hashText(previous)) throw new Error('File changed during edit; checkpoint preserved')
      signal.throwIfAborted()
      await rename(temporary, file)
    } finally { if (created) await rm(temporary, { force: true }) }
  }
  return `Saved ${input}; sha256: ${nextHash}; checkpoint: ${checkpoint}`
}
