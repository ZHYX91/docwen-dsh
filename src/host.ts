import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
import { completedReply, replyImages, type ImageStore } from './history.js'
import {
  collectBundle, hash, IMAGE_TYPES, MAX_DOCUMENT, portablePath, readResult, readResultFile, sections,
  snapshot, type Result,
} from './documents.js'
import { DOCX, EXPORT, IMPORT, MARKDOWN, object, runMachine, UnconfirmedExit, type ManagedProcess } from './machine.js'

const route = '/api/docwen-dsh'
const identifier = /^[A-Za-z0-9._:-]{1,180}$/u
const resultId = /^[0-9a-f-]{36}$/u
const noCache = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }

type Json = Record<string, unknown>
interface Host {
  connection: {
    fetch: {
      register(definition: {
        path: string
        methods: ('GET' | 'POST')[]
        requestBody: 'buffered' | 'streaming'
        fetch: (request: Request) => Promise<Response>
      }): () => Promise<void>
    }
  }
  sessionQuery: { readSession(sessionId: string): Promise<{ events: Json[] } | undefined> }
  workspaceFiles: { scopeOf(sessionId: string, signal: AbortSignal): Promise<{ workspaceRoot: string } | undefined> }
  attachments: ImageStore
  subprocess: {
    resolveExecutable(command: string, env: undefined, signal: AbortSignal): Promise<string>
    spawn(spec: { argv: string[]; cwd: string; stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe' }; graceMs: number }): ManagedProcess
  }
  effect(callback: () => () => Promise<void>, label: string): unknown
}

export const name = 'docwen-dsh'
export const inject = ['connection', 'sessionQuery', 'workspaceFiles', 'attachments', 'subprocess']

function reply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: noCache })
}

function parameter(query: URLSearchParams, key: string): string {
  const value = query.get(key) ?? ''
  if (!identifier.test(value)) throw new Error(`Invalid ${key}.`)
  return value
}

async function bodyBytes(request: Request, limit: number): Promise<Buffer> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('The request did not supply a file.')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      request.signal.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > limit) throw new Error('The request exceeds DocWen DSH’s file size limit.')
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks)
}

export function apply(ctx: Host): void {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const data = path.resolve(home, 'docwen-dsh')
  const executable = process.env.DOCWEN_DSH_EXECUTABLE || (process.platform === 'win32' ? 'DocWenCLI.exe' : 'DocWenCLI')
  const disposed = new AbortController()
  const active = new Map<string, Promise<Result>>()
  const resultRoot = (sessionId: string) => path.join(data, hash(sessionId))

  async function convert(request: Request, query: URLSearchParams, sessionId: string, operation: 'export' | 'import'): Promise<Result> {
    const signal = AbortSignal.any([request.signal, disposed.signal, AbortSignal.timeout(5 * 60 * 1000)])
    const scope = await ctx.workspaceFiles.scopeOf(sessionId, signal)
    if (!scope) throw new Error('The conversation is not available.')
    const destination = resultRoot(sessionId)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const work = await mkdtemp(path.join(destination, '.staging-'))
    let safeToClean = true
    try {
      const inputRoot = path.join(work, 'input')
      const staging = path.join(work, 'engine')
      const published = path.join(work, 'result')
      const filesRoot = path.join(published, 'files')
      await Promise.all([mkdir(inputRoot), mkdir(staging), mkdir(filesRoot, { recursive: true })])
      const inputs = []
      let label: string
      let options: Json
      if (operation === 'export') {
        const messageId = parameter(query, 'messageId')
        const body = object(JSON.parse((await bodyBytes(request, 2048)).toString('utf8')))
        if (typeof body.proofread !== 'boolean') throw new Error('Choose whether to proofread the exported document.')
        const session = await ctx.sessionQuery.readSession(sessionId)
        if (!session) throw new Error('The conversation is not available.')
        const { markdown, refs } = completedReply(session.events, messageId)
        const source = Buffer.from(markdown)
        if (source.length > MAX_DOCUMENT) throw new Error('The reply exceeds the document size limit.')
        label = 'Conversation reply'
        inputs.push(await snapshot(inputRoot, source, 'Conversation reply.md', MARKDOWN, 'source'))
        options = body.proofread ? { proofread: {} } : {}
        const images = await replyImages(markdown, refs, ctx.attachments, scope.workspaceRoot, sessionId, signal)
        if (images.length) {
          const bindings = []
          for (const [index, image] of images.entries()) {
            const extension = Object.keys(IMAGE_TYPES).find(key => IMAGE_TYPES[key] === image.media)
            const logicalPath = `images/image-${index + 1}${extension}`
            bindings.push({ authored_token: image.token, logical_path: logicalPath })
            inputs.push(await snapshot(inputRoot, image.bytes, logicalPath, image.media, 'linked_resource'))
          }
          options.markdown_resource_bindings = { authored_sha256: hash(source), images: bindings }
        }
      } else {
        label = portablePath(query.get('filename'))
        if (label.includes('/') || !label.toLowerCase().endsWith('.docx')) throw new Error('Choose a .docx file.')
        const source = await bodyBytes(request, MAX_DOCUMENT)
        if (source.length < 4 || !source.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))) {
          throw new Error('The upload is not a Word document.')
        }
        inputs.push(await snapshot(inputRoot, source, label, DOCX, 'source'))
        options = { preserve_resources: true, image_mode: 'file', image_link_style: 'markdown_embed', recognize_text: false }
      }
      signal.throwIfAborted()
      const binary = await ctx.subprocess.resolveExecutable(executable, undefined, signal)
      const child = ctx.subprocess.spawn({
        argv: [binary, 'serve', '--stdio'], cwd: work, graceMs: 3000,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      })
      const terminal = await runMachine(child, operation === 'export' ? EXPORT : IMPORT, inputs, staging, options, signal)
      const bundle = await collectBundle(terminal.bundle, terminal.taskId, staging, filesRoot, operation === 'export' ? DOCX : MARKDOWN, signal)
      const result: Result = {
        ...bundle, id: randomUUID(), label, created: new Date().toISOString(),
        warnings: terminal.diagnostics.flatMap(item =>
          (item.severity === 'warning' || item.code === 'POSTPROCESS_PROOFREAD_SKIPPED') &&
          typeof item.message === 'string' ? [item.message] : []),
      }
      await writeFile(path.join(published, 'result.json'), JSON.stringify(result), { flag: 'wx' })
      signal.throwIfAborted()
      await rename(published, path.join(destination, result.id))
      return result
    } catch (error) {
      if (error instanceof UnconfirmedExit) safeToClean = false
      throw error
    } finally {
      if (safeToClean) await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const fetchResult = async (request: Request): Promise<Response> => {
      try {
        const query = new URL(request.url).searchParams
        const sessionId = parameter(query, 'sessionId')
        const action = query.get('action')
        if (request.method === 'POST') {
          if (action !== 'export' && action !== 'import') return reply({ error: 'Unknown document operation.' }, 400)
          if ((action === 'import') !== new URL(request.url).pathname.endsWith('/upload')) {
            return reply({ error: 'The document operation was sent to the wrong route.' }, 400)
          }
          if (request.headers.get('x-docwen-dsh') !== '1') return reply({ error: 'Invalid document request.' }, 403)
          const size = Number(request.headers.get('content-length') ?? 0)
          if (size > (action === 'export' ? 2048 : MAX_DOCUMENT)) return reply({ error: 'File is too large.' }, 413)
          if (active.has(sessionId)) return reply({ error: 'This conversation already has a running document operation.' }, 409)
          const task = convert(request, query, sessionId, action)
          active.set(sessionId, task)
          try {
            return reply(await task)
          } finally {
            active.delete(sessionId)
          }
        }
        const scope = await ctx.workspaceFiles.scopeOf(sessionId, request.signal)
        if (!scope) return reply({ error: 'Conversation not found.' }, 404)
        const root = resultRoot(sessionId)
        if (action === 'list') {
          const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return []
            throw error
          })
          const results = await Promise.all(names.filter(id => resultId.test(id)).map(id => readResult(path.join(root, id, 'result.json'))))
          return reply(results.sort((a, b) => b.created.localeCompare(a.created)))
        }
        if (!['file', 'sections', 'archive'].includes(action ?? '')) return reply({ error: 'Unknown result action.' }, 400)
        const id = query.get('resultId') ?? ''
        if (!resultId.test(id)) return reply({ error: 'Result not found.' }, 404)
        const result = await readResult(path.join(root, id, 'result.json'))
        const filesRoot = path.join(root, id, 'files')
        if (action === 'archive') {
          const files: Record<string, Uint8Array> = Object.create(null)
          for (const file of result.files) files[file.path] = await readResultFile(filesRoot, file, request.signal)
          return new Response(new Uint8Array(zipSync(files, { level: 0 })), {
            headers: { ...noCache, 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="docwen-result.zip"' },
          })
        }
        const file = result.files.find(item => item.id === (action === 'sections' ? result.primary : query.get('artifactId')))
        if (!file) return reply({ error: 'Result file not found.' }, 404)
        const bytes = await readResultFile(filesRoot, file, request.signal)
        if (action === 'sections') {
          if (file.media !== MARKDOWN) return reply({ error: 'This result has no Markdown sections.' }, 415)
          return reply(sections(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
        }
        const name = encodeURIComponent(path.posix.basename(file.path)).replace(/['()]/g, value => `%${value.charCodeAt(0).toString(16)}`)
        const presentation = query.get('inline') === '1' && file.media.startsWith('image/') ? 'inline' : 'attachment'
        return new Response(new Uint8Array(bytes), {
          headers: { ...noCache, 'Content-Type': file.media, 'Content-Disposition': `${presentation}; filename*=UTF-8''${name}` },
        })
      } catch (error) {
        if (request.signal.aborted) return reply({ error: 'The document operation was cancelled.' }, 499)
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        const message = missing ? 'A requested file or DocWen CLI could not be found.' : error instanceof Error ? error.message : 'The document operation failed.'
        return reply({ error: message }, missing ? 404 : 422)
      }
  }
  const unregister = ctx.connection.fetch.register({
    path: route, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: fetchResult,
  })
  const unregisterUpload = ctx.connection.fetch.register({
    path: `${route}/upload`, methods: ['POST'], requestBody: 'streaming', fetch: fetchResult,
  })
  ctx.effect(() => async () => {
    disposed.abort()
    await Promise.allSettled(active.values())
    await Promise.all([unregister(), unregisterUpload()])
  }, 'docwen-dsh: stop active document operations and release routes')
}
