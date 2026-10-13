import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

// readText reads bounded regular UTF-8 files without following a final symlink or blocking on a FIFO.
export async function readText (file, limit = 2 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try { return await readHandleText(handle, limit) } finally { await handle.close() }
}

// readHandleText bounds regular-file reads through an already-owned handle without closing it.
export async function readHandleText (handle, limit) {
  const info = await handle.stat()
  if (!info.isFile()) throw new Error('Text tools require a regular file')
  if (info.size > limit) throw Object.assign(new Error(`File exceeds the ${limit / (1024 * 1024)} MiB text limit`), { code: 'LOOM_TEXT_LIMIT' })
  const chunks = []
  const buffer = Buffer.alloc(Math.min(64 * 1024, limit + 1))
  let bytes = 0
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, limit + 1 - bytes), null)
    if (!bytesRead) break
    bytes += bytesRead
    if (bytes > limit) throw Object.assign(new Error(`File exceeds the ${limit / (1024 * 1024)} MiB text limit`), { code: 'LOOM_TEXT_LIMIT' })
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.includes('\0')) throw Object.assign(new Error('Binary files are not supported by text tools'), { code: 'LOOM_BINARY_FILE' })
  return text
}

// writeSynced creates an exclusive file and closes its handle even when writing or syncing fails.
export async function writeSynced (file, content, mode) {
  const handle = await open(file, 'wx', mode)
  try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
}
