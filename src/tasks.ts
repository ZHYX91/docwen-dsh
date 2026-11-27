import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  collectBundle,
  fileWithin,
  hash,
  IMAGE_MEDIA,
  IMAGE_TYPES,
  imageTargets,
  MAX_DOCUMENT,
  MAX_RESULT,
  portablePath,
  readResultFile,
  snapshot,
  type Result,
} from './documents.js'
import {
  completedReply,
  readWorkspaceFile,
  replyImages,
  type ImageStore,
  type WorkspaceFiles,
} from './history.js'
import {
  assignInputs,
  available,
  layoutPlan,
  mediaFor,
  MIXED,
  PDF,
  bindImagePaths,
  withLayoutMerge,
  visibleAttachments,
  type Admitted,
  type Json,
  type Source,
} from './inputs.js'
import {
  discoverMachine,
  DOCX,
  EXPORT,
  IMPORT,
  MARKDOWN,
  object,
  objects,
  runMachine,
  text,
  UnconfirmedExit,
  type Input,
  type MachineCatalog,
  type ManagedProcess,
} from './machine.js'
import { fileMedia } from './media.js'
import { ResultStore, sessionKey, uuid } from './result-store.js'

export interface TaskPorts {
  sessionQuery: { readSession(sessionId: string): Promise<{ events: Json[] } | undefined> }
  workspaceFiles: WorkspaceFiles
  attachments: ImageStore & { readFileStream(ref: Json, signal?: AbortSignal): AsyncIterable<Uint8Array> }
  subprocess: {
    resolveExecutable(command: string, env: undefined, signal: AbortSignal): Promise<string>
    spawn(spec: {
      argv: string[]
      cwd: string
      stdio: { stdin: 'pipe'; stdout: 'pipe'; stderr: 'pipe' }
      graceMs: number
    }): ManagedProcess
  }
}
type Scope = NonNullable<Awaited<ReturnType<WorkspaceFiles['scopeOf']>>>
export type OpenInput = { intent: Json; uploads?: Map<string, File> }
interface Operation {
  id: string
  progress: number
  control: AbortController
  done: Promise<Result>
}
export class Busy extends Error {}
const maxInputs = 64

function attachmentName(item: Admitted): string {
  const ref = item.attachment
  if (typeof ref.name === 'string' && ref.name)
    return portablePath(path.posix.basename(ref.name.replaceAll('\\', '/')))
  const extension = Object.keys(IMAGE_TYPES).find((key) => IMAGE_TYPES[key] === ref.mediaType)
  if (!extension) throw new Error('A selected attachment has no recognized filename or image type.')
  return 'image-' + hash(text(ref.attachmentId)).slice(0, 12) + extension
}

export class DocumentTasks {
  private running = new Map<string, Operation>()
  private closing = new AbortController()
  private catalogs = new Map<string, { at: number; value: MachineCatalog }>()
  private probes = new Set<Promise<MachineCatalog>>()
  constructor(
    readonly ports: TaskPorts,
    readonly store: ResultStore,
    readonly executable: string,
  ) {}

  async scope(id: string, signal: AbortSignal): Promise<Scope> {
    signal.throwIfAborted()
    if (!sessionKey.test(id)) throw new Error('Invalid session identity.')
    const scope = await this.ports.workspaceFiles.scopeOf(id, signal)
    if (!scope || scope.sessionId !== id) throw new Error('This conversation is unavailable.')
    return scope
  }
  private async events(id: string) {
    const session = await this.ports.sessionQuery.readSession(id)
    if (!session) throw new Error('This conversation is unavailable.')
    return session.events
  }
  private async child(cwd: string, signal: AbortSignal) {
    const bin = await this.ports.subprocess.resolveExecutable(this.executable, undefined, signal)
    signal.throwIfAborted()
    return this.ports.subprocess.spawn({
      argv: [bin, 'serve', '--stdio'],
      cwd,
      graceMs: 3000,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    })
  }
  async catalog(id: string, caller: AbortSignal) {
    const signal = AbortSignal.any([caller, this.closing.signal, AbortSignal.timeout(60_000)])
    await this.scope(id, signal)
    if (this.probes.size >= 4) throw new Busy('DocWen is checking other installations. Try again shortly.')
    const probe = (async () =>
      discoverMachine(await this.child(await this.store.root(id, true), signal), signal))()
    this.probes.add(probe)
    try {
      const value = await probe
      this.remember(id, value)
      return withLayoutMerge(value)
    } finally {
      this.probes.delete(probe)
    }
  }
  private remember(id: string, value: MachineCatalog) {
    this.catalogs.delete(id)
    this.catalogs.set(id, { at: Date.now(), value })
    if (this.catalogs.size > 16) this.catalogs.delete(this.catalogs.keys().next().value!)
  }
  async list(id: string, signal: AbortSignal) {
    await this.scope(id, signal)
    return this.store.list(id)
  }
  async preview(id: string, messageId: string, signal: AbortSignal) {
    await this.scope(id, signal)
    const { markdown } = completedReply(await this.events(id), messageId)
    if (Buffer.byteLength(markdown) > MAX_DOCUMENT)
      throw new Error('The reply exceeds the document size limit.')
    return { markdown, images: imageTargets(markdown).map((image) => image.url) }
  }
  async attachments(id: string, signal: AbortSignal) {
    await this.scope(id, signal)
    return visibleAttachments(await this.events(id)).map((item) => {
      const name = attachmentName(item)
      return {
        id: item.attachment.attachmentId,
        name,
        mediaType: fileMedia(
          name,
          typeof item.attachment.mediaType === 'string'
            ? item.attachment.mediaType
            : 'application/octet-stream',
        ),
      }
    })
  }
  active(id: string) {
    const task = this.running.get(id)
    return task ? { id: task.id, progress: task.progress } : null
  }
  cancel(id: string, taskId: string) {
    const task = this.running.get(id)
    if (!task || task.id !== taskId) return false
    task.control.abort(new Error('The document task was cancelled.'))
    return true
  }
  closeSession(id: string) {
    this.catalogs.delete(id)
    this.running.get(id)?.control.abort(new Error('The conversation was closed.'))
  }
  async dispose() {
    this.closing.abort(new Error('The DocWen plugin was stopped.'))
    await Promise.allSettled([...this.running.values()].map((t) => t.done))
    await Promise.allSettled(this.probes)
  }
  async delivery(id: string, resultId: string, signal: AbortSignal) {
    await this.scope(id, signal)
    const { result, files } = await this.store.get(id, resultId)
    const byId = new Map(result.files.map((file) => [file.id, file]))
    const primary = byId.get(result.primary)
    if (!primary) return []
    const entries = result.entries?.map((entry) => byId.get(entry.artifact_id))
    // A PDF split contains independent documents; a preferred entry is not
    // the entire result. Keep resource groups and legacy indexes on their
    // existing delivery path, with the full group available in the panel ZIP.
    const selected =
      entries && entries.length > 1 && entries.length === result.files.length &&
      entries.every((file) => file?.kind === 'document' && file.media === PDF)
        ? entries
        : [primary]
    const delivered = []
    for (const file of selected) {
      if (!file) throw new Error('A saved result entry is missing.')
      await readResultFile(files, file, signal)
      delivered.push({
        path: await fileWithin(files, path.join(files, portablePath(file.path))),
        description: result.label,
      })
    }
    signal.throwIfAborted()
    return delivered
  }
  run(id: string, intent: Json, signal: AbortSignal, admitted?: readonly Admitted[]) {
    return this.submit(id, randomUUID(), signal, async () => ({ intent }), admitted)
  }
  async submit(
    id: string,
    taskId: string,
    caller: AbortSignal,
    open: (signal: AbortSignal) => Promise<OpenInput>,
    admitted: readonly Admitted[] = [],
  ): Promise<Result> {
    if (!sessionKey.test(id) || !uuid.test(taskId)) throw new Error('Invalid document task identity.')
    if (this.running.has(id)) throw new Busy('This conversation already has a running document task.')
    if (this.running.size >= 4) throw new Busy('DocWen is busy. Try again after another task finishes.')
    const control = new AbortController()
    const signal = AbortSignal.any([
      caller,
      this.closing.signal,
      control.signal,
      AbortSignal.timeout(5 * 60_000),
    ])
    const done = this.scope(id, signal).then(async (scope) => {
      if (await this.store.exists(id, taskId))
        throw new Busy('This task already has a saved result. Reopen it from the session panel.')
      const { intent, uploads } = await open(signal)
      signal.throwIfAborted()
      return this.execute(id, taskId, scope, intent, uploads ?? new Map(), admitted, signal, (n) => {
        const task = this.running.get(id)
        if (task) task.progress = Math.max(task.progress, Math.min(99, n))
      })
    })
    this.running.set(id, { id: taskId, progress: 0, control, done })
    try {
      return await done
    } finally {
      this.running.delete(id)
    }
  }

  private async loadSource(
    scope: Scope,
    desc: Json,
    uploads: Map<string, File>,
    admitted: readonly Admitted[],
    signal: AbortSignal,
    limit = MAX_DOCUMENT,
  ): Promise<Source> {
    signal.throwIfAborted()
    let name: string, bytes: Uint8Array, media: string
    if (desc.kind === 'workspace') {
      const locator = text(desc.path)
      name = portablePath(path.posix.basename(locator.replaceAll('\\', '/')))
      media = mediaFor(name)
      bytes = await readWorkspaceFile(this.ports.workspaceFiles, scope, locator, limit, signal)
    } else if (desc.kind === 'upload') {
      const file = uploads.get(text(desc.field))
      if (!file || file.size > limit)
        throw new Error('The selected upload is missing or exceeds the file size limit.')
      name = portablePath(file.name)
      if (name.includes('/')) throw new Error('An uploaded filename must be a basename.')
      media = mediaFor(name)
      bytes = new Uint8Array(await file.arrayBuffer())
    } else if (desc.kind === 'result') {
      const result = await this.store.read(
        scope.sessionId,
        text(desc.resultId),
        text(desc.artifactId),
        signal,
      )
      name = result.file.path
      media = result.file.media
      bytes = result.bytes
    } else if (desc.kind === 'attachment') {
      const selected = admitted.find((item) => item.attachment.attachmentId === text(desc.attachmentId))
      if (!selected) throw new Error('The selected attachment does not belong to this conversation.')
      const ref = selected.attachment
      name = attachmentName(selected)
      media = selected.type === 'image' ? text(ref.mediaType) : mediaFor(name)
      if (
        typeof ref.bytes !== 'number' ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes < 0 ||
        ref.bytes > limit
      )
        throw new Error('The attachment exceeds the file size limit.')
      if (selected.type === 'image') bytes = (await this.ports.attachments.readImage(ref, signal)).data
      else {
        const chunks: Uint8Array[] = []
        let n = 0
        for await (const chunk of this.ports.attachments.readFileStream(ref, signal)) {
          signal.throwIfAborted()
          n += chunk.length
          if (n > ref.bytes) throw new Error('The session attachment changed size.')
          chunks.push(chunk)
        }
        bytes = Buffer.concat(chunks)
      }
      if (bytes.length !== ref.bytes) throw new Error('The session attachment is incomplete.')
    } else throw new Error('Unknown input source.')
    if (bytes.length > limit) throw new Error('The file exceeds the size limit.')
    return {
      name: desc.logicalPath === undefined ? name : portablePath(desc.logicalPath),
      bytes,
      media,
      role: typeof desc.role === 'string' ? desc.role : undefined,
    }
  }

  async previewSource(id: string, desc: Json, signal: AbortSignal) {
    if (!['workspace', 'attachment'].includes(String(desc.kind))) throw new Error('Invalid preview source.')
    const scope = await this.scope(id, signal)
    const items = desc.kind === 'attachment' ? visibleAttachments(await this.events(id)) : []
    return this.loadSource(scope, desc, new Map(), items, signal, 2 * 1024 * 1024)
  }

  private async replySources(id: string, scope: Scope, ids: unknown, signal: AbortSignal) {
    if (
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > maxInputs ||
      ids.some((m) => typeof m !== 'string' || !sessionKey.test(m)) ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Choose one or more distinct completed replies.')
    const events = await this.events(id)
    const parts: string[] = [],
      images: Source[] = [],
      bindings: Json[] = []
    let total = 0
    for (const messageId of ids) {
      const { markdown, refs } = completedReply(events, messageId)
      total += Buffer.byteLength(markdown)
      if (total > MAX_RESULT) throw new Error('The selected replies exceed the size limit.')
      const resolved = await replyImages(
        markdown,
        refs,
        this.ports.attachments,
        this.ports.workspaceFiles,
        scope,
        signal,
      )
      const replacements = new Map<string, string>()
      for (const image of resolved) {
        const ext = Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === image.media)
        if (!ext || images.length >= 64)
          throw new Error('Too many referenced images or an unsupported image type.')
        total += image.bytes.length
        if (total > MAX_RESULT) throw new Error('The selected replies and images exceed the size limit.')
        const name = `images/image-${images.length + 1}${ext}`
        replacements.set(image.token, name)
        images.push({ name, bytes: image.bytes, media: image.media, role: 'linked_resource' })
      }
      const bound = bindImagePaths(markdown, replacements)
      parts.push(bound.markdown)
      bindings.push(...bound.images)
    }
    const bytes = Buffer.from(parts.join('\n\n---\n\n'))
    if (bytes.length > MAX_DOCUMENT) throw new Error('The combined Markdown exceeds the document size limit.')
    return {
      sources: [{ name: 'Conversation.md', bytes, media: MARKDOWN, role: 'source' }, ...images],
      bindings: bindings.length ? { authored_sha256: hash(bytes), images: bindings } : undefined,
    }
  }

  /** Resolve authored Markdown images only from selected resources, the source workspace directory,
   * or the same previously verified Bundle. Local uploads never grant access to neighbouring files. */
  private async markdownSources(scope: Scope, descriptors: Json[], sources: Source[], signal: AbortSignal) {
    const index = sources.findIndex((s) => s.media === MARKDOWN && (!s.role || s.role === 'source'))
    if (index < 0) return
    const source = sources[index]
    const markdown = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)
    const targets = imageTargets(markdown)
    if (!targets.length) return
    if (targets.length > 64) throw new Error('The Markdown references more than 64 images.')
    const desc = descriptors[index]
    const paths = new Map<string, string>()
    const resources = new Map<string, Source>()
    let size = sources.reduce((n, s) => n + s.bytes.length, 0)
    for (const { token, url } of targets) {
      if (paths.has(token)) continue
      const relative = decodeURIComponent(url).replaceAll('\\', '/')
      if (!relative || /^(?:[a-z][a-z\d+.\-]*:|\/)/iu.test(relative) || relative.includes('\0')) {
        throw new Error('Markdown images must use a relative path to a selected or session resource.')
      }
      let image = resources.get(relative)
      if (!image) {
        const logical = path.posix.normalize(path.posix.join(path.posix.dirname(source.name), relative))
        const selected = sources.filter((s) => s !== source && s.name === logical && IMAGE_MEDIA.has(s.media))
        if (!selected.length && desc.kind === 'upload') {
          selected.push(
            ...sources.filter(
              (s) => s !== source && s.name === path.posix.basename(relative) && IMAGE_MEDIA.has(s.media),
            ),
          )
        }
        if (selected.length > 1) throw new Error('A Markdown image has more than one matching resource.')
        image = selected[0]
        if (!image) {
          if (desc.kind === 'workspace') {
            const base = text(desc.path).replaceAll('\\', '/')
            const target = path.posix.join(path.posix.dirname(base), relative)
            image = await this.loadSource(
              scope,
              { kind: 'workspace', path: target },
              new Map(),
              [],
              signal,
              Math.min(MAX_DOCUMENT, MAX_RESULT - size),
            )
          } else if (desc.kind === 'result') {
            const group = await this.store.get(scope.sessionId, text(desc.resultId))
            const file = group.result.files.find((f) => f.path === logical && IMAGE_MEDIA.has(f.media))
            if (file)
              image = await this.loadSource(
                scope,
                { kind: 'result', resultId: desc.resultId, artifactId: file.id },
                new Map(),
                [],
                signal,
              )
          }
          if (!image)
            throw new Error('Select the image referenced by this Markdown file: ' + relative.slice(0, 120))
          if (!IMAGE_MEDIA.has(image.media))
            throw new Error('The selected Markdown resource is not a supported raster image.')
          size += image.bytes.length
          if (size > MAX_RESULT) throw new Error('The document and linked resources are too large.')
          sources.push(image)
        }
        image.role = 'linked_resource'
        resources.set(relative, image)
      }
      const num = sources.indexOf(image) + 1
      const ext = Object.keys(IMAGE_TYPES).find((key) => IMAGE_TYPES[key] === image.media)!
      paths.set(token, `images/asset-${num}${ext}`)
    }
    for (const image of new Set(resources.values())) {
      const ext = Object.keys(IMAGE_TYPES).find((key) => IMAGE_TYPES[key] === image.media)!
      image.name = `images/asset-${sources.indexOf(image) + 1}${ext}`
    }
    const bound = bindImagePaths(markdown, paths)
    source.bytes = Buffer.from(bound.markdown)
    return { authored_sha256: hash(source.bytes), images: bound.images }
  }

  private async execute(
    id: string,
    taskId: string,
    scope: Scope,
    intent: Json,
    uploads: Map<string, File>,
    admitted: readonly Admitted[],
    signal: AbortSignal,
    progress: (n: number) => void,
  ): Promise<Result> {
    const action = intent.action
    if (action !== 'export' && action !== 'process') throw new Error('Choose an export or file operation.')
    const capId = action === 'export' ? EXPORT : text(intent.capabilityId)
    const options = { ...object(intent.options ?? {}) }
    const work = await this.store.staging(id)
    let clean = true
    try {
      // This cache avoids a second process for each batch row. Every real stage still negotiates
      // and checks its live route and options on the same connection as task/plan and task/execute.
      const cached = this.catalogs.get(id)
      const catalog =
        cached && Date.now() - cached.at < 30_000
          ? cached.value
          : await discoverMachine(await this.child(work, signal), signal)
      if (catalog !== cached?.value) this.remember(id, catalog)
      const cap =
        capId === MIXED
          ? undefined
          : catalog.capabilities.find((c) => c.capability_id === capId && available(c))
      if (!cap && capId !== MIXED) throw new Error(`The installed DocWen cannot run ${capId}.`)
      let sources: Source[], label: string
      if (Object.hasOwn(options, 'markdown_resource_bindings'))
        throw new Error('Markdown image bindings are derived from the selected resources.')
      if (action === 'export') {
        const exportData = await this.replySources(id, scope, intent.messageIds, signal)
        sources = exportData.sources
        if (exportData.bindings) options.markdown_resource_bindings = exportData.bindings
        label = (intent.messageIds as string[]).length === 1 ? 'Conversation reply' : 'Conversation replies'
      } else {
        const raw = objects(intent.sources)
        if (!raw.length || raw.length > maxInputs) throw new Error('Choose between 1 and 64 input files.')
        const refs = raw.some((s) => s.kind === 'attachment')
          ? [...admitted, ...visibleAttachments(await this.events(id))]
          : []
        sources = []
        let total = 0
        for (const desc of raw) {
          const source = await this.loadSource(
            scope,
            desc,
            uploads,
            refs,
            signal,
            Math.min(MAX_DOCUMENT, MAX_RESULT - total),
          )
          total += source.bytes.length
          sources.push(source)
        }
        if (capId === EXPORT) {
          const bindings = await this.markdownSources(scope, raw, sources, signal)
          if (bindings) options.markdown_resource_bindings = bindings
        }
        label = raw.length === 1 ? sources[0].name : `${sources[0].name} (+${sources.length - 1})`
      }
      const plan =
        capId === MIXED
          ? layoutPlan(
              catalog.capabilities,
              sources.map((s) => s.media),
            )
          : undefined
      const finalCap = cap ?? plan!.merge
      const steps = (plan?.converters.filter(Boolean).length ?? 0) + 1
      let step = 0
      const perform = async (
        c: Json,
        files: Source[],
        opts: Json,
        expected: string | undefined,
        publish: boolean,
      ) => {
        signal.throwIfAborted()
        const root = path.join(work, 'step-' + step),
          inputsDir = path.join(root, 'input'),
          staging = path.join(root, 'engine')
        const output = path.join(work, publish ? 'result' : `intermediate-${step}`)
        await Promise.all([
          mkdir(inputsDir, { recursive: true }),
          mkdir(staging, { recursive: true }),
          mkdir(path.join(output, 'files'), { recursive: true }),
        ])
        const slots = assignInputs(c, files)
        const inputs: Input[] = []
        for (const [index, src] of files.entries()) {
          signal.throwIfAborted()
          const slot = slots[index]
          inputs.push(await snapshot(inputsDir, src.bytes, slot.name, src.media, slot.role, slot.kind))
        }
        const terminal = await runMachine(
          await this.child(root, signal),
          text(c.capability_id),
          inputs,
          staging,
          opts,
          signal,
          (percent) => progress(Math.floor((step * 100 + percent) / steps)),
        )
        const collected = await collectBundle(
          terminal.bundle,
          terminal.taskId,
          staging,
          path.join(output, 'files'),
          expected,
          signal,
        )
        step++
        return {
          collected,
          output,
          warnings: terminal.diagnostics.flatMap((d) =>
            (d.severity === 'warning' || d.code === 'POSTPROCESS_PROOFREAD_SKIPPED') &&
            typeof d.message === 'string'
              ? [d.message]
              : [],
          ),
        }
      }
      const warnings: string[] = []
      if (plan) {
        for (const [index, converter] of plan.converters.entries()) {
          if (!converter) continue
          const {
            collected,
            output,
            warnings: stageWarnings,
          } = await perform(converter, [sources[index]], {}, PDF, false)
          if (collected.files.length !== 1 || collected.files[0].media !== PDF)
            throw new Error('A layout conversion returned an unexpected result.')
          const bytes = await readResultFile(path.join(output, 'files'), collected.files[0], signal)
          sources[index] = { name: `layout-${index + 1}.pdf`, bytes, media: PDF }
          if (sources.reduce((n, s) => n + s.bytes.length, 0) > MAX_RESULT)
            throw new Error('Converted inputs exceed the merge size limit.')
          warnings.push(...stageWarnings)
        }
      }
      const {
        collected,
        output,
        warnings: finalWarnings,
      } = await perform(
        finalCap,
        sources,
        options,
        capId === EXPORT ? DOCX : capId === IMPORT ? MARKDOWN : undefined,
        true,
      )
      const result: Result = {
        ...collected,
        id: taskId,
        label,
        created: new Date().toISOString(),
        warnings: [...warnings, ...finalWarnings],
      }
      await this.store.publish(id, output, result, signal)
      return result
    } catch (error) {
      if (error instanceof UnconfirmedExit) clean = false
      throw error
    } finally {
      if (clean) await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
