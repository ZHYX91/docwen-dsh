import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { IMAGE_MEDIA, IMAGE_TYPES, imageTargets } from './documents.js'
import { object, objects, text } from './machine.js'

type Json = Record<string, unknown>

export interface ImageStore {
  imageHostPath(ref: Json): string | undefined
  readImage(ref: Json, signal?: AbortSignal): Promise<{ data: Uint8Array }>
}

export interface WorkspaceScope { sessionId: string; workspaceRoot: string }
interface WorkspaceStat { absolutePath: string; version: string; bytes?: number }
export interface WorkspaceFiles {
  scopeOf(sessionId: string, signal: AbortSignal): Promise<WorkspaceScope | undefined>
  stat(scope: WorkspaceScope, path: string, signal: AbortSignal): Promise<WorkspaceStat>
  readBytes(scope: WorkspaceScope, path: string, options: Record<string, never>, signal: AbortSignal):
    Promise<WorkspaceStat & { offset: number; eof: boolean; data: Uint8Array }>
}

function pathApi(root: string) {
  return root.startsWith('/') ? path.posix : path.win32
}

function workspacePath(scope: WorkspaceScope, requested: string): string {
  const root = scope.workspaceRoot
  const api = pathApi(root)
  if (!api.isAbsolute(root) || !requested || requested.includes('\0') ||
      (!api.isAbsolute(requested) && /^[a-z][a-z\d+.\-]*:/iu.test(requested))) {
    throw new Error('Select a regular file inside this conversation’s workspace.')
  }
  const absolute = api.resolve(root, requested)
  const relative = api.relative(root, absolute)
  if (!relative || relative === '..' || relative.startsWith('..' + api.sep) || api.isAbsolute(relative)) {
    throw new Error('The file is outside this conversation’s workspace.')
  }
  return absolute
}

/** workspaceFiles also serves outside-workspace files. Limit both the request and its
 * host-resolved identity before transferring any bytes, then verify the snapshot. */
export async function readWorkspaceFile(
  files: WorkspaceFiles, scope: WorkspaceScope, requested: string, limit: number, signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted()
  const candidate = workspacePath(scope, requested)
  const stat = await files.stat(scope, candidate, signal)
  const canonical = workspacePath(scope, stat.absolutePath)
  if (!pathApi(scope.workspaceRoot).isAbsolute(stat.absolutePath) || !stat.version ||
      (stat.bytes !== undefined && (!Number.isSafeInteger(stat.bytes) || stat.bytes < 0 || stat.bytes > limit))) {
    throw new Error('The workspace file is too large or its identity is unavailable.')
  }
  signal.throwIfAborted()
  const read = await files.readBytes(scope, canonical, {}, signal)
  signal.throwIfAborted()
  if (read.absolutePath !== stat.absolutePath || read.version !== stat.version || read.offset !== 0 || !read.eof ||
      read.data.byteLength > limit || (stat.bytes !== undefined && stat.bytes !== read.data.byteLength) ||
      (read.bytes !== undefined && read.bytes !== read.data.byteLength)) {
    throw new Error('The workspace file changed or could not be read completely.')
  }
  return read.data
}

interface HistoryMessage {
  assistantId?: string
  blocks: Json[]
}

/** In a fork the host supplies only the inherited prefix, with an open tail
 * closed as "forked". Completed turns and message IDs survive unchanged. */
function* committedMessages(events: Json[]): Generator<HistoryMessage> {
  const completed = new Set<Json>()
  let start: Json | undefined
  for (const event of events) {
    if (event.type === 'turn/start') start = event
    if (event.type === 'turn/end') {
      if (start && object(object(event.data).reason).kind === 'completed') completed.add(start)
      start = undefined
    }
  }

  start = undefined
  for (const event of events) {
    if (event.type === 'turn/start') start = event
    if (event.type === 'turn/end') start = undefined
    if (event.surfaceOp !== 'append') continue
    if (event.type === 'user/message') {
      const data = object(event.data)
      if (object(data.source).kind === 'user') yield { blocks: objects(data.content) }
    }
    if (event.type === 'assistant/message' && start && completed.has(start)) {
      const data = object(event.data)
      if (data.interrupted === true) continue
      const message = object(data.message)
      const blocks = objects(message.content)
      if (!blocks.some(block => block.type === 'tool-call')) {
        yield { assistantId: text(message.id), blocks }
      }
    }
  }
}

export function visibleAttachments(events: Json[]): { type: string; attachment: Json }[] {
  const items = new Map<string, { type: string; attachment: Json }>()
  for (const { blocks } of committedMessages(events)) {
    for (const block of blocks) {
      if (block.type !== 'file' && block.type !== 'image') continue
      const attachment = object(block.attachment)
      items.set(text(attachment.attachmentId), { type: block.type, attachment })
    }
  }
  return [...items.values()]
}

export function completedReply(events: Json[], messageId: string): { markdown: string; refs: Json[] } {
  const images = new Map<string, Json>()
  for (const { assistantId, blocks } of committedMessages(events)) {
    const selected = assistantId === messageId
    const paragraphs: string[] = []
    for (const block of blocks) {
      if (selected && block.type === 'text' && typeof block.text === 'string') paragraphs.push(block.text)
      if (block.type !== 'image') continue
      const ref = object(block.attachment)
      const id = text(ref.attachmentId)
      images.set(id, ref)
      if (selected) {
        if (!/^[A-Za-z0-9._:-]+$/u.test(id)) throw new Error('An attachment reference is invalid.')
        paragraphs.push(`![Image](dsh-attachment:${id})`)
      }
    }
    if (selected) {
      const markdown = paragraphs.join('\n\n')
      if (!markdown.trim()) throw new Error('The reply has no visible content.')
      return { markdown, refs: [...images.values()] }
    }
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
  markdown: string, refs: Json[], store: ImageStore, files: WorkspaceFiles,
  scope: WorkspaceScope, signal: AbortSignal,
): Promise<ResolvedImage[]> {
  const targets = imageTargets(markdown)
  if (targets.length > 32) throw new Error('The reply exceeds the limit of 32 referenced images.')
  if (!targets.length) return []
  const api = pathApi(scope.workspaceRoot)
  const byToken = new Map<string, ResolvedImage>()
  let total = 0
  for (const { token, url } of targets) {
    if (byToken.has(token)) continue
    signal.throwIfAborted()
    let raw = url
    const scoping = `dsh-resource://file/session/${scope.sessionId}/`
    if (raw.startsWith(scoping)) raw = raw.slice(scoping.length)
    if (raw.startsWith('file:')) raw = fileURLToPath(raw)
    else if (!api.isAbsolute(raw)) raw = decodeURIComponent(raw)
    const attachmentId = raw.startsWith('dsh-attachment:') ? raw.slice('dsh-attachment:'.length) : undefined
    const canonical = api.isAbsolute(raw) ? api.normalize(raw) : null
    const ref = refs.find(candidate => {
      if (attachmentId !== undefined) return candidate.attachmentId === attachmentId
      if (!canonical) return false
      const stored = store.imageHostPath(candidate)
      return stored !== undefined && api.relative(stored, canonical) === ''
    })
    let media: string
    let bytes: Uint8Array
    if (ref) {
      media = text(ref.mediaType)
      if (!IMAGE_MEDIA.has(media) || typeof ref.bytes !== 'number' || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > MAX_IMAGE) {
        throw new Error('A referenced conversation attachment is not a supported image.')
      }
      bytes = (await store.readImage(ref, signal)).data
      if (bytes.byteLength !== ref.bytes) throw new Error('A referenced conversation attachment is incomplete.')
    } else {
      if (/^[a-z][a-z+.-]*:/i.test(raw) && !api.isAbsolute(raw)) {
        throw new Error(`An image is not an available attachment or workspace file: ${url.slice(0, 150)}`)
      }
      media = IMAGE_TYPES[api.extname(raw).toLowerCase()]
      if (!media) throw new Error(`An image uses an unsupported format: ${url.slice(0, 150)}`)
      try {
        bytes = await readWorkspaceFile(files, scope, raw, MAX_IMAGE, signal)
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
