import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { DOCX, MARKDOWN, object, objects, text, type Input } from './machine.js'

export const MAX_DOCUMENT = 32 * 1024 * 1024
export const MAX_RESULT = 96 * 1024 * 1024
export const IMAGE_TYPES: Record<string, string> = {
  '.bmp': 'image/bmp', '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
}
export const IMAGE_MEDIA = new Set(Object.values(IMAGE_TYPES))

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
): Promise<Input> {
  const id = randomUUID()
  const logicalPath = portablePath(name)
  const location = path.join(directory, id + path.posix.extname(logicalPath))
  await writeFile(location, bytes, { flag: 'wx' })
  return {
    input_id: id, locator: { kind: 'local_path', path: location },
    role, kind: role === 'source' ? 'document' : 'resource',
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

export interface ResultFile {
  id: string
  path: string
  media: string
  sha256: string
  bytes: number
}

export interface Result {
  id: string
  label: string
  created: string
  primary: string
  files: ResultFile[]
  warnings: string[]
}

export async function collectBundle(
  bundle: Record<string, unknown>, taskId: string, staging: string, destination: string,
  preferredMedia: typeof DOCX | typeof MARKDOWN, signal: AbortSignal,
): Promise<Pick<Result, 'files' | 'primary'>> {
  const producer = object(bundle.producer)
  if (bundle.schema !== 'docwen.artifact_bundle.v3' || bundle.task_id !== taskId ||
      producer.name !== 'DocWen' || producer.machine_protocol !== 'docwen.machine.v2' ||
      (bundle.layout_schema !== 'docwen.artifact_layout.v1' &&
       !(preferredMedia === MARKDOWN && bundle.layout_schema === 'docwen.document_node.v1'))) {
    throw new Error('DocWen returned an incompatible artifact bundle.')
  }
  const artifacts = objects(bundle.artifacts)
  const entries = objects(bundle.entries)
  const preferred = entries.filter(entry => entry.preferred === true)
  if (!artifacts.length || artifacts.length > 128 || preferred.length !== 1 ||
      preferred[0].role !== 'primary' || (preferredMedia === DOCX && artifacts.length !== 1)) {
    throw new Error('DocWen did not return the expected document and resources.')
  }
  const primary = text(preferred[0].artifact_id)
  const root = await realpath(staging)
  const ids = new Set<string>()
  const paths = new Set<string>()
  const locators = new Set<string>()
  const files: ResultFile[] = []
  let total = 0
  for (const artifact of artifacts) {
    signal.throwIfAborted()
    const id = text(artifact.artifact_id)
    const media = text(artifact.media_type)
    const relative = portablePath(artifact.logical_path)
    const locator = portablePath(artifact.locator)
    const digest = text(artifact.sha256)
    const bytes = artifact.size_bytes
    if (ids.has(id) || paths.has(relative.toLowerCase()) || locators.has(locator.toLowerCase()) ||
        !/^[0-9a-f]{64}$/u.test(digest) || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) ||
        bytes < 0 || bytes > MAX_DOCUMENT ||
        (id === primary ? artifact.kind !== 'document' || media !== preferredMedia :
          artifact.kind !== 'resource' || !IMAGE_MEDIA.has(media))) {
      throw new Error('An artifact has invalid identity, type, size, or destination.')
    }
    ids.add(id)
    paths.add(relative.toLowerCase())
    locators.add(locator.toLowerCase())
    total += bytes
    if (total > MAX_RESULT) throw new Error('The result group exceeds DocWen DSH’s size limit.')
    const source = await fileWithin(root, path.join(root, ...locator.split('/')))
    const output = path.join(destination, ...relative.split('/'))
    await mkdir(path.dirname(output), { recursive: true })
    await copyFile(source, output)
    const data = await readLimited(output, bytes, signal)
    if (data.length !== bytes || hash(data) !== digest) throw new Error('An output does not match its verified digest.')
    files.push({ id, path: relative, media, sha256: digest, bytes })
  }
  if (!ids.has(primary) || entries.some(entry => !ids.has(text(entry.artifact_id)))) {
    throw new Error('The artifact bundle references a missing file.')
  }
  const relations = objects(bundle.relations)
  const resources = new Set(relations.map(relation => {
    if (relation.type !== 'resource_of' || relation.target_artifact_id !== primary ||
        relation.source_artifact_id === primary || !ids.has(text(relation.source_artifact_id))) {
      throw new Error('A result contains an unsupported document relationship.')
    }
    return text(relation.source_artifact_id)
  }))
  if (resources.size !== relations.length || resources.size !== files.length - 1) {
    throw new Error('A result image is missing its document relationship.')
  }
  return { files, primary }
}

export async function readResultFile(root: string, file: ResultFile, signal: AbortSignal): Promise<Buffer> {
  const physicalRoot = await realpath(root)
  const locator = await fileWithin(physicalRoot, path.resolve(physicalRoot, portablePath(file.path)))
  const bytes = await readLimited(locator, file.bytes, signal)
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('The saved file has changed or is incomplete.')
  return bytes
}

export async function readResult(file: string): Promise<Result> {
  return JSON.parse(await readFile(file, 'utf8')) as Result
}
