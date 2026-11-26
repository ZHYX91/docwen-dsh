import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { DOCX, MARKDOWN, object, objects, text, type Input } from './machine.js'

export const MAX_DOCUMENT = 32 * 1024 * 1024
export const MAX_RESULT = 96 * 1024 * 1024
export {IMAGE_TYPES, IMAGE_MEDIA} from './media.js'
export function hash(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function portablePath(value: unknown): string {
  const name = text(value)
  if (name.length > 1024 || name.split('/').some(segment =>
    segment === '' || segment === '.' || segment === '..' || /[\\:\x00-\x1f<>|"*?]/u.test(segment) ||
    /[. ]$/u.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment)
  )) throw new Error('DocWen returned a nonportable file path.')
  return name
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return Boolean(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

export async function fileWithin(root: string, candidate: string): Promise<string> {
  if (!contained(root, candidate)) throw new Error('The file is outside the allowed directory.')
  const info = await lstat(candidate)
  const resolved = await realpath(candidate)
  if (!info.isFile() || !contained(root, resolved)) throw new Error('The file is not an allowed regular file.')
  return resolved
}

export async function readLimited(file: string, limit: number, signal: AbortSignal): Promise<Buffer> {
  if ((await stat(file)).size > limit) throw new Error('The file exceeds DocWen DSH’s size limit.')
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of createReadStream(file, { signal })) {
    const data = Buffer.from(chunk)
    bytes += data.length
    if (bytes > limit) throw new Error('The file exceeds DocWen DSH’s size limit.')
    chunks.push(data)
  }
  return Buffer.concat(chunks)
}

export async function snapshot(
  directory: string, bytes: Uint8Array, name: string, media: string, role: Input['role'],
  kind: Input['kind'] = role === 'source' ? 'document' : 'resource',
): Promise<Input> {
  const id = randomUUID()
  const logicalPath = portablePath(name)
  const location = path.join(directory, id + path.posix.extname(logicalPath))
  await writeFile(location, bytes, { flag: 'wx' })
  return {
    input_id: id, locator: { kind: 'local_path', path: location },
    role, kind,
    logical_path: logicalPath, media_type: media, size_bytes: bytes.length, sha256: hash(bytes),
  }
}

interface ImageTarget {
  token: string
  url: string
}

export function imageTargets(markdown: string): ImageTarget[] {
  const tree = fromMarkdown(markdown)
  const definitions = new Map<string, string>()
  const images: { token: string; url?: string; reference?: string }[] = []
  const walk = (node: Nodes) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url)
    if (node.type === 'image' || node.type === 'imageReference') {
      const token = markdown.slice(node.position?.start.offset, node.position?.end.offset)
      images.push(node.type === 'image' ? { token, url: node.url } : { token, reference: node.identifier })
    }
    if ('children' in node) node.children.forEach(walk)
  }
  walk(tree)
  return images.map(image => {
    const url = image.url ?? definitions.get(image.reference ?? '')
    if (!url) throw new Error('An image reference has no destination.')
    return { token: image.token, url }
  })
}

export function sections(markdown: string): { title: string; markdown: string }[] {
  const headings = fromMarkdown(markdown).children.flatMap(node => {
    if (node.type !== 'heading' || node.position?.start.offset === undefined) return []
    const offset = node.position.start.offset
    const title = node.children.map(child => 'value' in child ? child.value : '').join('').trim()
    return [{ offset, title: title || 'Section' }]
  })
  if (!headings.length) return [{ title: 'Entire document', markdown }]
  const intro = markdown.slice(0, headings[0].offset)
  return [
    ...(intro.trim() ? [{ title: 'Introduction', markdown: intro }] : []),
    ...headings.map((item, index) => ({
      title: item.title, markdown: markdown.slice(item.offset, headings[index + 1]?.offset),
    })),
  ]
}

type Json = Record<string, unknown>
type ArtifactKind = 'document' | 'fragment' | 'resource'

export interface ResultFile {
  id: string
  path: string
  media: string
  sha256: string
  bytes: number
  kind?: ArtifactKind
  suggestedName?: string
}

export interface ResultEntry {
  artifact_id: string
  role: string
  ordinal: number
  preferred: boolean
}

export interface ResultRelation extends Json {
  type: string
  role: string
  source_artifact_id: string
  target_artifact_id: string
}

export interface Result {
  id: string
  label: string
  created: string
  primary: string
  files: ResultFile[]
  warnings: string[]
  entries?: ResultEntry[]
  relations?: ResultRelation[]
}

const MAX_FILES = 1024
const MAX_METADATA = 4 * 1024 * 1024
const ENTRY_ROLES = new Set(['primary', 'supplementary', 'ocr_page', 'section', 'worksheet', 'image', 'original'])
const RELATION_ROLES: Record<string, readonly string[]> = {
  attachment_of: ['attachment'], fragment_of: ['ocr_page', 'ocr_text', 'section', 'worksheet'],
  resource_of: ['image', 'original', 'preview', 'worksheet', 'manifest'], derived_from: ['source', 'original'],
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d._:-]{0,127}$/iu.test(value)) throw new Error('Invalid artifact identifier.')
  return value
}

function describeFile(id: unknown, relative: unknown, media: unknown, digest: unknown, bytes: unknown,
                      kind: unknown, suggested: unknown): ResultFile {
  if (typeof media !== 'string' || media.length > 255 || /[\x00-\x1f\x7f]/u.test(media) ||
      !/^[a-z\d!#$&^_.+-]+\/[a-z\d!#$&^_.+-]+(?:;.*)?$/iu.test(media) ||
      typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest) ||
      typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_DOCUMENT ||
      (kind !== undefined && kind !== 'document' && kind !== 'fragment' && kind !== 'resource')) {
    throw new Error('Invalid artifact type, digest or size.')
  }
  const suggestedName = suggested === undefined ? undefined : text(suggested)
  if (suggestedName !== undefined && (suggestedName === '.' || suggestedName === '..' || suggestedName.length > 255 ||
      /[\x00-\x1f\\/]/u.test(suggestedName))) throw new Error('Invalid artifact filename.')
  return { id: identifier(id), path: portablePath(relative), media, sha256: digest, bytes,
    ...(kind === undefined ? {} : { kind }), ...(suggestedName === undefined ? {} : { suggestedName }) }
}

function verifyPaths(paths: string[]): void {
  const files = new Set<string>()
  const directories = new Set<string>()
  for (const name of paths) {
    const parts = name.normalize('NFC').toLowerCase().split('/')
    const key = parts.join('/')
    if (files.has(key) || directories.has(key)) throw new Error('Conflicting artifact paths.')
    files.add(key)
    parts.pop()
    while (parts.length) {
      const directory = parts.join('/')
      if (files.has(directory)) throw new Error('Conflicting artifact directory.')
      directories.add(directory)
      parts.pop()
    }
  }
}

function verifyFiles(files: ResultFile[]): void {
  if (!files.length || files.length > MAX_FILES || new Set(files.map(file => file.id)).size !== files.length ||
      files.reduce((sum, file) => sum + file.bytes, 0) > MAX_RESULT) {
    throw new Error('Invalid or oversized result group.')
  }
  verifyPaths(files.map(file => file.path))
}

function graph(files: ResultFile[], rawEntries: unknown, rawRelations: unknown) {
  const byId = new Map(files.map(file => [file.id, file]))
  const ids = new Set(byId.keys())
  const entries = objects(rawEntries).map(item => {
    const id = identifier(item.artifact_id)
    if (!ids.has(id) || typeof item.ordinal !== 'number' || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0 ||
        typeof item.preferred !== 'boolean' || typeof item.role !== 'string' || !ENTRY_ROLES.has(item.role)) {
      throw new Error('Invalid bundle entry.')
    }
    const kind = byId.get(id)?.kind
    if ((item.role === 'ocr_page' && kind !== 'fragment') ||
        (item.role === 'image' && kind !== 'resource') ||
        (item.role === 'section' && kind !== 'document' && kind !== 'fragment')) throw new Error('Invalid entry kind.')
    return { artifact_id: id, ordinal: item.ordinal, preferred: item.preferred, role: item.role }
  }).sort((a, b) => a.ordinal - b.ordinal)
  const entryIds = new Set(entries.map(entry => entry.artifact_id))
  if (!entries.length || entryIds.size !== entries.length || new Set(entries.map(e => e.ordinal)).size !== entries.length ||
      entries.filter(e => e.preferred).length > 1) throw new Error('Invalid bundle entry order or preference.')

  const edges = new Map<string, string[]>()
  const neighbors = new Map<string, string[]>()
  for (const id of ids) { edges.set(id, []); neighbors.set(id, []) }
  const owners = new Set<string>()
  const relations = objects(rawRelations).map(item => {
    const source = identifier(item.source_artifact_id)
    const target = identifier(item.target_artifact_id)
    const type = text(item.type)
    const role = text(item.role)
    if (!ids.has(source) || !ids.has(target) || source === target || !Object.hasOwn(RELATION_ROLES, type) ||
        !RELATION_ROLES[type].includes(role)) throw new Error('Invalid artifact relationship.')
    const from = byId.get(source)!
    const to = byId.get(target)!
    const manifest = role === 'manifest' && from.media === 'application/vnd.docwen.document-node+json' &&
      from.suggestedName === 'docwen-node.json' && to.kind === 'resource' &&
      entries.some(entry => entry.artifact_id === target && entry.preferred)
    if ((type === 'attachment_of' && (from.kind !== 'document' || to.kind !== 'document')) ||
        (type === 'fragment_of' && (from.kind !== 'fragment' || to.kind !== 'document')) ||
        (type === 'resource_of' && (from.kind !== 'resource' || (to.kind !== 'document' && to.kind !== 'fragment' && !manifest)))) {
      throw new Error('Artifact kinds differ from their relationship.')
    }
    if (type === 'fragment_of' || type === 'attachment_of' || item.ordinal !== undefined) {
      if (typeof item.ordinal !== 'number' || !Number.isSafeInteger(item.ordinal) || item.ordinal < 0) {
        throw new Error('Invalid artifact relationship order.')
      }
    }
    if (type !== 'derived_from') {
      if (owners.has(source) || entryIds.has(source)) throw new Error('Inconsistent artifact ownership.')
      owners.add(source)
    }
    edges.get(source)!.push(target)
    neighbors.get(source)!.push(target)
    neighbors.get(target)!.push(source)
    return { ...item, type, role, source_artifact_id: source, target_artifact_id: target }
  })
  const visited = new Set<string>()
  const active = new Set<string>()
  function visit(id: string) {
    if (active.has(id)) throw new Error('Cyclic artifact relationship.')
    if (visited.has(id)) return
    active.add(id)
    for (const target of edges.get(id)!) visit(target)
    active.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
  const reachable = new Set(entryIds)
  for (const id of reachable) for (const target of neighbors.get(id)!) reachable.add(target)
  if (reachable.size !== ids.size) throw new Error('An artifact is disconnected from the result entries.')
  const primary = (entries.find(entry => entry.preferred) ?? entries[0]).artifact_id
  return { entries, relations, primary }
}

export async function collectBundle(
  bundle: Json, taskId: string, staging: string, destination: string, expectedMedia: string | undefined, signal: AbortSignal,
): Promise<Pick<Result, 'files' | 'primary'> & { entries: ResultEntry[]; relations: ResultRelation[] }> {
  signal.throwIfAborted()
  const producer = object(bundle.producer)
  identifier(bundle.bundle_id)
  text(producer.product_version)
  if (bundle.schema !== 'docwen.artifact_bundle.v3' || bundle.task_id !== taskId ||
      producer.name !== 'DocWen' || producer.machine_protocol !== 'docwen.machine.v2' ||
      !['docwen.artifact_layout.v1', 'docwen.document_node.v1'].includes(text(bundle.layout_schema))) {
    throw new Error('DocWen returned an incompatible artifact bundle.')
  }
  const artifacts = objects(bundle.artifacts)
  const files = artifacts.map(a => describeFile(a.artifact_id, a.logical_path, a.media_type, a.sha256, a.size_bytes,
    text(a.kind), text(a.suggested_name)))
  const locators = artifacts.map(a => portablePath(a.locator))
  verifyFiles(files)
  verifyPaths(locators)
  const resultGraph = graph(files, bundle.entries, bundle.relations)
  const first = files.find(file => file.id === resultGraph.primary)!
  if (expectedMedia && (first.media !== expectedMedia || first.kind !== 'document' ||
      !resultGraph.entries.some(entry => entry.artifact_id === first.id && entry.preferred && entry.role === 'primary') ||
      (expectedMedia === DOCX && files.length !== 1))) {
    throw new Error('DocWen did not return the expected primary document.')
  }

  const sourceRoot = await realpath(staging)
  const destRoot = await realpath(destination)
  for (const [index, file] of files.entries()) {
    signal.throwIfAborted()
    const source = await fileWithin(sourceRoot, path.join(sourceRoot, ...locators[index].split('/')))
    const data = await readLimited(source, file.bytes, signal)
    if (data.length !== file.bytes || hash(data) !== file.sha256) throw new Error('An output does not match its verified digest.')
    let directory = destRoot
    const parts = file.path.split('/')
    const name = parts.pop()!
    for (const part of parts) {
      directory = path.join(directory, part)
      try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) {
        throw new Error('The result directory has been redirected.')
      }
    }
    await writeFile(path.join(directory, name), data, { flag: 'wx', mode: 0o600, signal })
  }
  signal.throwIfAborted()
  return { files, ...resultGraph }
}

export async function readResultFile(root: string, file: ResultFile, signal: AbortSignal): Promise<Buffer> {
  const physicalRoot = await realpath(root)
  const locator = await fileWithin(physicalRoot, path.resolve(physicalRoot, portablePath(file.path)))
  const bytes = await readLimited(locator, file.bytes, signal)
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('The saved file has changed or is incomplete.')
  return bytes
}

export async function readResult(file: string): Promise<Result> {
  if (!(await lstat(file)).isFile()) throw new Error('Invalid DocWen result index.')
  const data = await readLimited(file, MAX_METADATA, AbortSignal.timeout(15_000))
  const row = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)))
  const id = text(row.id)
  const label = text(row.label)
  const created = text(row.created)
  const warnings = row.warnings
  if (!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/iu.test(id) || !Number.isFinite(Date.parse(created)) ||
      !Array.isArray(warnings) || !warnings.every(w => typeof w === 'string')) throw new Error('Invalid DocWen result index.')
  const files = objects(row.files).map(f => describeFile(f.id, f.path, f.media, f.sha256, f.bytes, f.kind, f.suggestedName))
  verifyFiles(files)
  const primary = identifier(row.primary)
  if (!files.some(f => f.id === primary)) throw new Error('Missing primary result file.')
  const savedGraph = row.entries === undefined && row.relations === undefined ? undefined : graph(files, row.entries, row.relations)
  if (savedGraph && primary !== savedGraph.primary) throw new Error('Inconsistent primary result file.')
  return { id, label, created, warnings, files, primary, ...savedGraph }
}
