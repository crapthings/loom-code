import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { protectedNames, isCredentialPath } from '../execution/policy.js'

// excludedTrees omits metadata, dependencies and generated output from bounded source observations.
const excludedTrees = new Set([...protectedNames, 'node_modules', 'vendor', 'dist', 'coverage', 'build', '.next'])

// WorkspaceObserver compares bounded source hashes around authorized mutations without storing file contents.
export class WorkspaceObserver {
  constructor (cwd, { files = 2000, bytes = 16 * 1024 * 1024, milliseconds = 250 } = {}) {
    this.cwd = cwd
    this.limits = { files, bytes, milliseconds }
  }

  async capture () {
    const files = new Map()
    const omitted = { excluded: 0, unreadable: 0, oversized: 0, limited: false }
    const deadline = Date.now() + this.limits.milliseconds
    let bytes = 0
    try {
      const root = await realpath(this.cwd)
      const pending = ['']
      while (pending.length) {
        const directory = pending.pop()
        const absolute = path.join(root, directory)
        if (!(await lstat(absolute)).isDirectory() || await realpath(absolute) !== absolute) { omitted.excluded++; continue }
        const entries = await readdir(absolute, { withFileTypes: true })
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (files.size >= this.limits.files || bytes >= this.limits.bytes || Date.now() >= deadline) { omitted.limited = true; return { files, omitted } }
          const relative = path.join(directory, entry.name)
          if (excludedTrees.has(entry.name) || isCredentialPath(relative) || entry.isSymbolicLink()) { omitted.excluded++; continue }
          if (entry.isDirectory()) { pending.push(relative); continue }
          if (!entry.isFile()) { omitted.excluded++; continue }
          let handle
          try {
            handle = await open(path.join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
            const before = await handle.stat()
            if (!before.isFile() || before.nlink !== 1) { omitted.excluded++; continue }
            if (before.size > 2 * 1024 * 1024 || bytes + before.size > this.limits.bytes) { omitted.oversized++; continue }
            const buffer = Buffer.alloc(before.size + 1)
            const read = await handle.read(buffer, 0, buffer.length, 0)
            bytes += read.bytesRead
            const after = await handle.stat()
            if (read.bytesRead !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) { omitted.unreadable++; continue }
            files.set(relative, createHash('sha256').update(buffer.subarray(0, read.bytesRead)).digest('hex'))
          } catch { omitted.unreadable++ } finally { await handle?.close() }
        }
      }
    } catch { omitted.unreadable++ }
    return { files, omitted }
  }

  compare (before, after) {
    const complete = snapshot => !snapshot.omitted.limited && !snapshot.omitted.unreadable && !snapshot.omitted.oversized
    const files = []
    let count = 0
    for (const file of new Set([...before.files.keys(), ...after.files.keys()])) {
      const previous = before.files.get(file)
      const current = after.files.get(file)
      if (previous === current || (!previous && !complete(before)) || (!current && !complete(after))) continue
      count++
      if (files.length < 100) files.push({ path: file, before: previous ?? null, after: current ?? null })
    }
    return { files, count, omitted: Math.max(0, count - files.length), coverage: { before: before.omitted, after: after.omitted }, attribution: 'Observed during this call; concurrent edits may contribute. Hash changes do not prove correctness.' }
  }
}
