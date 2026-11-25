import { fileURLToPath } from 'node:url'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileWithin, IMAGE_MEDIA, IMAGE_TYPES, imageTargets, readLimited } from './documents.js'
import { object, objects, text } from './machine.js'

type Json = Record<string, unknown>

export interface ImageStore {
  imageHostPath(ref: Json): string | undefined
  readImage(ref: Json, signal?: AbortSignal): Promise<{ data: Uint8Array }>
}

function pathKey(value: string): string {
  const normalized = path.normalize(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function completedReply(events: Json[], messageId: string): { markdown: string; refs: Json[] } {
  const attachments = new Map<string, Json>()
  let reply: { markdown: string; refs: Json[] } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') reply = undefined
    if (event.type === 'turn/end' && reply) return reply
    if (event.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const data = object(event.data)
      if (object(data.source).kind !== 'user') continue
      for (const block of objects(data.content)) {
        if (block.type !== 'image') continue
        const ref = object(block.attachment)
        attachments.set(text(ref.attachmentId), ref)
      }
    }
    if (event.type !== 'assistant/message') continue
    const message = object(object(event.data).message)
    if (message.id !== messageId) {
      reply = undefined
      continue
    }
    const content = objects(message.content)
    if (content.some(block => block.type === 'tool-call')) continue
    const paragraphs: string[] = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') paragraphs.push(block.text)
      if (block.type === 'image') {
        const ref = object(block.attachment)
        const id = text(ref.attachmentId)
        if (!/^[A-Za-z0-9._:-]+$/u.test(id)) throw new Error('An attachment reference is invalid.')
        attachments.set(id, ref)
        paragraphs.push(`![Image](dsh-attachment:${id})`)
      }
    }
    const markdown = paragraphs.join('\n\n')
    if (!markdown.trim()) throw new Error('The reply has no visible content.')
    reply = { markdown, refs: [...attachments.values()] }
  }
  throw new Error('The selected reply is not a completed message in this conversation.')
}

interface ResolvedImage {
  token: string
  bytes: Uint8Array
  media: string
}

const MAX_IMAGE = 16 * 1024 * 1024

export async function replyImages(
  markdown: string, refs: Json[], store: ImageStore, workspace: string,
  sessionId: string, signal: AbortSignal,
): Promise<ResolvedImage[]> {
  const targets = imageTargets(markdown)
  if (targets.length > 32) throw new Error('The reply exceeds the limit of 32 referenced images.')
  if (!targets.length) return []
  const root = await realpath(workspace)
  const byToken = new Map<string, ResolvedImage>()
  let total = 0
  for (const { token, url } of targets) {
    if (byToken.has(token)) continue
    signal.throwIfAborted()
    let raw = url
    const scoping = `dsh-resource://file/session/${sessionId}/`
    if (raw.startsWith(scoping)) raw = raw.slice(scoping.length)
    if (raw.startsWith('file:')) raw = fileURLToPath(raw)
    else if (!path.isAbsolute(raw)) raw = decodeURIComponent(raw)
    const attachmentId = raw.startsWith('dsh-attachment:') ? raw.slice('dsh-attachment:'.length) : undefined
    const canonical = path.isAbsolute(raw) ? pathKey(raw) : null
    const ref = refs.find(candidate => {
      if (attachmentId !== undefined) return candidate.attachmentId === attachmentId
      if (!canonical) return false
      const stored = store.imageHostPath(candidate)
      return stored !== undefined && pathKey(stored) === canonical
    })
    let media: string
    let bytes: Uint8Array
    if (ref) {
      media = text(ref.mediaType)
      if (!IMAGE_MEDIA.has(media) || typeof ref.bytes !== 'number' || ref.bytes > MAX_IMAGE) {
        throw new Error('A referenced conversation attachment is not a supported image.')
      }
      bytes = (await store.readImage(ref, signal)).data
      if (bytes.byteLength !== ref.bytes) throw new Error('A referenced conversation attachment is incomplete.')
    } else {
      if (/^[a-z][a-z+.-]*:/i.test(raw) && !path.isAbsolute(raw)) {
        throw new Error(`An image is not an available attachment or workspace file: ${url.slice(0, 150)}`)
      }
      media = IMAGE_TYPES[path.extname(raw).toLowerCase()]
      if (!media) throw new Error(`An image uses an unsupported format: ${url.slice(0, 150)}`)
      try {
        const locator = await fileWithin(root, path.resolve(root, raw))
        bytes = await readLimited(locator, MAX_IMAGE, signal)
      } catch (error) {
        signal.throwIfAborted()
        throw new Error(`Cannot read the referenced image: ${url.slice(0, 150)}`, { cause: error })
      }
    }
    total += bytes.length
    if (total > 64 * 1024 * 1024) throw new Error('The reply’s images exceed the total size limit.')
    byToken.set(token, { token, bytes, media })
  }
  return [...byToken.values()]
}
