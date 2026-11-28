import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Zip, ZipPassThrough } from 'fflate'
import { IMAGE_MEDIA, readResultFile, sections } from './documents.js'
import { registerEntries, type EntryHost } from './entries.js'
import { MARKDOWN, object, text, UnconfirmedExit } from './machine.js'
import { ResultStore, sessionKey } from './result-store.js'
import { Busy, DocumentTasks, type OpenInput, type TaskPorts } from './tasks.js'
import { MAX_JSON, receiveUploads, TooLarge } from './uploads.js'

const route = '/api/docwen-dsh'
const noCache = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: noCache })
interface Host extends TaskPorts {
  connection: {
    fetch: {
      register(def: {
        path: string
        methods: ('GET' | 'POST')[]
        requestBody: 'buffered' | 'streaming'
        fetch: (r: Request) => Promise<Response>
      }): () => Promise<void>
    }
  }
  effect(callback: () => () => Promise<void>, label: string): unknown
  inject: EntryHost['inject']
  on: EntryHost['on'] & ((event: 'session/disposed', handler: (session: { id: string }) => void) => unknown)
}

export const name = 'docwen-dsh'
export const inject = ['connection', 'sessionQuery', 'workspaceFiles', 'attachments', 'subprocess']

async function bodyBytes(request: Request, limit: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new TooLarge('The request exceeds the file size limit.')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('The request contains no input.')
  const buffers: Uint8Array[] = []
  let bytes = 0
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      const item = await reader.read()
      signal.throwIfAborted()
      if (item.done) break
      bytes += item.value.length
      if (bytes > limit) throw new TooLarge('The request exceeds the file size limit.')
      buffers.push(item.value)
    }
    return Buffer.concat(buffers)
  } finally {
    signal.removeEventListener('abort', cancel)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
const parseJSON = (bytes: Uint8Array) =>
  object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
async function taskInput(
  r: Request, signal: AbortSignal, stageUploads: () => Promise<string>,
): Promise<OpenInput> {
  const contentType = r.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data'))
    return { intent: parseJSON(await bodyBytes(r, MAX_JSON, signal)) }
  const form = await receiveUploads(r, contentType, await stageUploads(), signal)
  return { intent: object(JSON.parse(form.intent)), uploads: form.uploads }
}

function bitmap(bytes: Uint8Array, media: string) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (media === 'image/png') return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (media === 'image/jpeg') return b[0] === 255 && b[1] === 216 && b[2] === 255
  if (media === 'image/gif') return /^GIF8[79]a/u.test(b.toString('ascii', 0, 6))
  if (media === 'image/bmp') return b.toString('ascii', 0, 2) === 'BM'
  return (
    media === 'image/webp' && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
  )
}
function binary(body: BodyInit, media: string, name: string, inline = false) {
  const filename = encodeURIComponent(path.posix.basename(name)).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16),
  )
  return new Response(body, {
    headers: {
      ...noCache,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Type': media,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
    },
  })
}

async function archiveBody(root: string, files: Parameters<typeof readResultFile>[1][], signal: AbortSignal) {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, chunk) => {
    if (error) throw error
    if (chunk.byteLength) chunks.push(chunk)
  })
  try {
    // Verify the complete group before committing an HTTP success. Stored ZIP entries
    // pass the already verified member buffers through without concatenating them.
    for (const file of files) {
      signal.throwIfAborted()
      const bytes = await readResultFile(root, file, signal)
      const entry = new ZipPassThrough(file.path)
      zip.add(entry)
      entry.push(bytes, true)
    }
    signal.throwIfAborted()
    zip.end()
  } catch (error) {
    zip.terminate()
    throw error
  }
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal.aborted) {
        chunks.length = 0
        controller.error(signal.reason)
        return
      }
      const next = chunks.shift()
      if (next) controller.enqueue(next)
      else controller.close()
    },
    cancel() { chunks.length = 0 },
  })
  return { stream, length }
}

export function routeHandler(tasks: DocumentTasks) {
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url),
        query = url.searchParams
      const id = query.get('sessionId') ?? '',
        action = query.get('action'),
        signal = request.signal
      if (!sessionKey.test(id)) return json({ error: 'Invalid session identity.' }, 400)
      if (request.method === 'POST') {
        if (request.headers.get('x-docwen-dsh') !== '1')
          return json({ error: 'Invalid document request.' }, 403)
        const origin = request.headers.get('origin')
        if (origin && origin !== url.origin) {
          // The DSH web bridge keeps the admitted HTTP Host but uses a synthetic URL.
          const browser = URL.canParse(origin) ? new URL(origin) : undefined
          if (
            url.origin !== 'http://dsh.internal' ||
            !browser ||
            !['http:', 'https:'].includes(browser.protocol) ||
            browser.origin !== origin ||
            browser.host !== request.headers.get('host')
          ) {
            return json({ error: 'This document request belongs to another origin.' }, 403)
          }
        }
        if (action === 'cancel' || action === 'delete') {
          await tasks.scope(id, signal)
          const body = parseJSON(await bodyBytes(request, 2048, signal))
          if (action === 'cancel') return json({ ok: tasks.cancel(id, text(body.taskId)) })
          await tasks.store.remove(id, text(body.resultId))
          return json({ ok: true })
        }
        if (action !== 'run')
          return json({ error: 'Unknown document operation.' }, 400)
        const upload = (request.headers.get('content-type') ?? '').toLowerCase().startsWith('multipart/form-data')
        if (upload !== url.pathname.endsWith('/upload'))
          return json({ error: 'The operation was sent to the wrong route.' }, 400)
        return json(
          await tasks.submit(id, query.get('taskId') ?? randomUUID(), signal, (s, stageUploads) =>
            taskInput(request, s, stageUploads),
          ),
        )
      }
      if (request.method !== 'GET') return json({ error: 'Unsupported method.' }, 405)
      if (action === 'catalog') return json(await tasks.catalog(id, signal))
      if (action === 'list') return json(await tasks.list(id, signal, query.get('before') ?? undefined))
      if (action === 'attachments') return json(await tasks.attachments(id, signal))
      if (action === 'preview') return json(await tasks.preview(id, text(query.get('messageId')), signal))
      if (action === 'source-preview') {
        const item = await tasks.previewSource(id, Object.fromEntries(query), signal)
        if (IMAGE_MEDIA.has(item.media) && bitmap(item.bytes, item.media))
          return binary(new Uint8Array(item.bytes), item.media, item.name, true)
        if (item.media !== MARKDOWN && item.media !== 'text/plain')
          return json({ error: 'Preview supports Markdown, text and raster images.' }, 415)
        return new Response(new TextDecoder('utf-8', { fatal: true }).decode(item.bytes), {
          headers: { ...noCache, 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      await tasks.scope(id, signal)
      if (action === 'active') return json(await tasks.active(id))
      if (action === 'result') return json((await tasks.store.get(id, text(query.get('resultId')))).result)
      if (!['file', 'archive', 'sections'].includes(action ?? ''))
        return json({ error: 'Unknown result operation.' }, 400)
      const { result, files } = await tasks.store.get(id, text(query.get('resultId')))
      if (action === 'archive') {
        const { stream, length } = await archiveBody(files, result.files, signal)
        const response = binary(stream, 'application/zip', 'docwen-result.zip')
        response.headers.set('Content-Length', String(length))
        return response
      }
      const file = result.files.find((f) => f.id === (query.get('artifactId') ?? result.primary))
      if (!file) return json({ error: 'Result file not found.' }, 404)
      const bytes = await readResultFile(files, file, signal)
      if (action === 'sections')
        return file.media === MARKDOWN
          ? json(sections(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
          : json({ error: 'Choose a Markdown artifact.' }, 415)
      return binary(new Uint8Array(bytes), file.media, file.path, query.get('inline') === '1' && bitmap(bytes, file.media))
    } catch (error) {
      if (error instanceof UnconfirmedExit)
        return json({ error: error.message, code: 'process_exit_unconfirmed' }, 409)
      if (request.signal.aborted) return json({ error: 'The document request was cancelled.' }, 499)
      if (error instanceof Busy) return json({ error: error.message }, 409)
      if (error instanceof TooLarge) return json({ error: error.message }, 413)
      const code = (error as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT')
        return json({ error: 'The selected file, result or DocWen executable was not found.' }, 404)
      if (code === 'EACCES' || code === 'EPERM')
        return json({ error: 'The host denied access to a selected file or document service.' }, 403)
      if (code && typeof code === 'string')
        return json({ error: 'The host could not complete the document operation.' }, 422)
      return json(
        {
          error:
            error instanceof SyntaxError
              ? 'Invalid document request.'
              : error instanceof Error
                ? error.message
                : 'The document operation failed.',
        },
        422,
      )
    }
  }
}

export function apply(ctx: Host) {
  const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'))
  const executable =
    process.env.DOCWEN_DSH_EXECUTABLE || (process.platform === 'win32' ? 'DocWenCLI.exe' : 'DocWenCLI')
  const tasks = new DocumentTasks(ctx, new ResultStore(home), executable)
  registerEntries(ctx, tasks)
  ctx.on('session/disposed', (session) => tasks.closeSession(session.id))
  const fetch = routeHandler(tasks)
  const unregister = [
    ctx.connection.fetch.register({ path: route, methods: ['GET', 'POST'], requestBody: 'buffered', fetch }),
    ctx.connection.fetch.register({
      path: route + '/upload',
      methods: ['POST'],
      requestBody: 'streaming',
      fetch,
    }),
  ]
  ctx.effect(
    () => async () => {
      await tasks.dispose()
      await Promise.all(unregister.map((fn) => fn()))
    },
    'Stop DocWen tasks and release document routes',
  )
}
