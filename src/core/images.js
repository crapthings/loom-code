import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'

// imageFormats restricts screenshot artifacts to provider-supported raster formats.
const imageFormats = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

// maximumImageBytes bounds each decoded screenshot before storage or provider delivery.
const maximumImageBytes = 8 * 1024 * 1024

// imageFile validates content-addressed artifact names without accepting arbitrary filesystem paths.
function imageFile (artifact) {
  const match = /^image-([a-f0-9]{64})\.(png|jpg|webp)$/.exec(artifact || '')
  if (!match) throw new Error('Invalid screenshot artifact')
  return { digest: match[1], mimeType: Object.keys(imageFormats).find(type => imageFormats[type] === match[2]) }
}

// storeImages saves bounded screenshots separately so the durable journal contains references rather than base64.
export async function storeImages (directory, images = []) {
  if (!Array.isArray(images) || images.length > 4) throw new Error('A tool may return at most four screenshots')
  const stored = []
  for (const image of images) {
    const extension = imageFormats[image.mimeType]
    if (!extension || typeof image.data !== 'string' || image.data.length % 4 || image.data.length > Math.ceil(maximumImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw new Error('Invalid or oversized screenshot')
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.length || bytes.length > maximumImageBytes) throw new Error('Invalid or oversized screenshot')
    const signature = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : extension === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    if (!signature) throw new Error('Screenshot content does not match its MIME type')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const artifact = `image-${digest}.${extension}`
    try {
      const handle = await open(path.join(directory, artifact), 'wx', 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      await readImage(directory, artifact)
    }
    stored.push({ type: 'image', artifact, mimeType: image.mimeType, bytes: bytes.length })
  }
  return stored
}

// readImage verifies an immutable screenshot without following symlinks before returning provider image content.
export async function readImage (directory, artifact) {
  const { digest, mimeType } = imageFile(artifact)
  const handle = await open(path.join(directory, artifact), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || !stat.size || stat.size > maximumImageBytes) throw new Error('Invalid screenshot file')
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    const bytes = buffer.subarray(0, size)
    if (size !== stat.size || createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Screenshot artifact changed; capture the current state again')
    return { type: 'image', mimeType, data: bytes.toString('base64') }
  } finally { await handle.close() }
}

// projectImages keeps only the latest four screenshot occurrences in the active context while preserving recall references.
export function projectImages (messages, supportsImages = true) {
  let remaining = supportsImages ? 4 : 0
  return messages.slice().reverse().map(message => {
    if (!Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.slice().reverse().map(part => {
      if (part.type !== 'image') return part
      if (remaining-- > 0) return part
      changed = true
      return { type: 'text', text: `[Screenshot ${part.artifact || '(inline image)'} omitted from this request: ${supportsImages ? 'older observation; use read_image to recall the artifact' : 'the selected model does not accept images'}.]` }
    }).reverse()
    return changed ? { ...message, content } : message
  }).reverse()
}

// hydrateImages resolves screenshot references only at the provider boundary and reports missing evidence explicitly.
export async function hydrateImages (directory, messages) {
  return Promise.all(messages.map(async message => {
    if (!Array.isArray(message.content)) return message
    const content = await Promise.all(message.content.map(async part => {
      if (part.type !== 'image' || !part.artifact) return part
      try { return await readImage(directory, part.artifact) } catch {
        return { type: 'text', text: `[Screenshot ${part.artifact} unavailable or changed; capture the current state again. Pixels were not supplied.]` }
      }
    }))
    return { ...message, content }
  }))
}
