import type { Result, ResultFile } from './documents.js'

export const EXPORT = 'convert.markdown_source.to_docx'
export const IMPORT = 'convert.docx.to_markdown'
export const LAYOUT_MERGE = 'docwen-dsh.merge-layouts'

export type Options = Record<string, unknown>
export type Text = (en: string, zh: string) => string
export interface Schema {
  type?: string
  properties?: Record<string, Schema>
  required?: string[]
  default?: unknown
  enum?: (string | number)[]
  minimum?: number
  maximum?: number
  items?: Schema
  'x-docwen-resource-kind'?: string
  'x-docwen-resource-target'?: string
}
interface Slot { role: string; min_items: number; max_items?: number; media_types: string[] }
export interface Capability {
  capability_id: string
  availability: string
  input_shape: { slots: Slot[] }
  output_media_types: string[]
  options_schema: Schema
  operation: string
}
/** DSH section drafts and re-export consume CommonMark image references. */
export function workbenchOptions(capability?: Capability): Options {
  if (capability?.capability_id !== IMPORT) return {}
  const spec = capability.options_schema.properties ?? {}
  const options: Options = {}
  if (spec.preserve_resources?.type === 'boolean') options.preserve_resources = true
  if (spec.image_mode?.enum?.includes('file')) options.image_mode = 'file'
  if (spec.image_link_style?.enum?.includes('markdown_embed')) options.image_link_style = 'markdown_embed'
  return options
}
export interface Resource { id: string; name: string; target?: string; is_default?: boolean }
export interface Catalog { capabilities: Capability[]; templates: Resource[]; numberingSchemes: Resource[]; optimizations: Resource[] }
export interface Attachment { id: string; name: string; mediaType: string }
export type Source =
  | { kind: 'upload'; file: File }
  | { kind: 'workspace'; path: string }
  | { kind: 'attachment'; attachmentId: string }
  | { kind: 'result'; resultId: string; artifactId: string }
export interface Item { key: string; label: string; media: string; bytes?: number; source: Source; role?: 'source' | 'linked_resource' }
export interface Reply { id: string; label: string }
export type Intent =
  | { action: 'export'; messageIds: string[]; options: Options }
  | { action: 'process'; capabilityId: string; options: Options; inputs: Item[] }
export interface Job { label: string; intent: Intent; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'; error?: string; resultId?: string }

export { fileMedia } from './media.js'
export function identifier(): string {
  return crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, ch =>
    (Number(ch) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(ch) / 4)))).toString(16))
}
export function resultItem(result: Result, file: ResultFile): Item {
  return { key: identifier(), label: file.path, media: file.media, bytes: file.bytes, source: { kind: 'result', resultId: result.id, artifactId: file.id } }
}
export function shifted<T>(values: T[], index: number, delta: number): T[] {
  const to = index + delta
  if (index < 0 || index >= values.length || to < 0 || to >= values.length) return values
  const copy = [...values]
  ;[copy[index], copy[to]] = [copy[to], copy[index]]
  return copy
}
export function sourceSlot(cap: Capability): Slot | undefined {
  if (cap.input_shape.slots.some(s => s.role !== 'source' && s.min_items > 0)) return undefined
  return cap.input_shape.slots.find(s => s.role === 'source')
}
export function available(cap: Capability): boolean {
  return cap.availability === 'available' || cap.availability === 'limited'
}
function withResources(cap: Capability, items: Item[]): Item[] | undefined {
  const primary = sourceSlot(cap)
  const linked = cap.input_shape.slots.find(s => s.role === 'linked_resource')
  if (!primary || !linked || primary.max_items !== 1) return
  const mains = items.filter(item => primary.media_types.includes(item.media))
  const images = items.filter(item => !primary.media_types.includes(item.media))
  if (mains.length !== 1 || !images.length || !images.every(item => linked.media_types.includes(item.media))
    || images.length < linked.min_items || (linked.max_items !== undefined && images.length > linked.max_items)) return
  return items.map(item => ({ ...item, role: primary.media_types.includes(item.media) ? 'source' : 'linked_resource' }))
}
export function compatible(cap: Capability, items: Item[]): boolean {
  if (cap.capability_id === LAYOUT_MERGE && !items.some(i => i.media !== 'application/pdf')) return false
  const slot = sourceSlot(cap)
  return available(cap) && !!slot && (items.every(item => slot.media_types.includes(item.media)) || !!withResources(cap, items))
}
export function jobsFor(cap: Capability, items: Item[], options: Options): Job[] {
  const slot = sourceSlot(cap)
  if (!slot || !compatible(cap, items) || items.length < slot.min_items || !items.length) return []
  const linked = withResources(cap, items)
  const groups = linked ? [linked] : slot.max_items === 1 ? items.map(item => [item]) : [items]
  if (!linked && groups.some(group => slot.max_items !== undefined && group.length > slot.max_items)) return []
  return groups.map(inputs => ({ label: inputs.map(i => i.label).join(', '), status: 'queued',
    intent: { action: 'process', capabilityId: cap.capability_id, options, inputs } }))
}
export function wireIntent(intent: Intent): { body: BodyInit; multipart: boolean } {
  if (intent.action === 'export') return { body: JSON.stringify(intent), multipart: false }
  const form = new FormData()
  let multipart = false
  const sources = intent.inputs.map(({ source, role }, index) => {
    const assignment = role ? { role } : {}
    if (source.kind !== 'upload') return { ...source, ...assignment }
    multipart = true
    const field = 'file' + index
    form.append(field, source.file, source.file.name)
    return { kind: 'upload', field, ...assignment }
  })
  const value = JSON.stringify({ action: 'process', capabilityId: intent.capabilityId, options: intent.options, sources })
  if (!multipart) return { body: value, multipart: false }
  form.append('intent', value)
  return { body: form, multipart: true }
}
export function api(sessionId: string, action: string, fields: Record<string, string> = {}, upload = false): string {
  return 'api/docwen-dsh' + (upload ? '/upload' : '') + '?' + new URLSearchParams({ ...fields, sessionId, action })
}
export async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'DocWen HTTP ' + response.status)
  return data as T
}

export function capName(cap: Capability, t: Text): string {
  const id = cap.capability_id
  const names: Record<string, [string, string]> = {
    [EXPORT]: ['Markdown → Word','Markdown → Word'], [IMPORT]: ['Word → Markdown','Word → Markdown'],
    'validate.docx': ['Proofread Word (annotated copy)','校对 Word（批注副本）'],
    'validate.markdown': ['Proofread Markdown (report)','校对 Markdown（报告）'],
    'transform.markdown.heading_numbering': ['Change Markdown heading numbering','调整 Markdown 标题编号'],
    'merge.pdf.documents': ['Merge PDFs','合并 PDF'], 'merge.xlsx.tables': ['Merge spreadsheets','合并表格'],
    'merge.images.to_tiff': ['Merge images into TIFF','将多张图片合成 TIFF'],
    'split.pdf.every_page': ['Split PDF by page','逐页拆分 PDF'], 'split.pdf.partition': ['Split selected PDF pages','按页码拆分 PDF'],
    'convert.markdown_tables.to_csv': ['Extract Markdown tables as CSV','将 Markdown 表格提取为 CSV'],
    [LAYOUT_MERGE]: ['Merge PDF, OFD or XPS into PDF','将 PDF、OFD 或 XPS 合并为 PDF'],
  }
  const label = names[id]
  if (label) return t(...label)
  const opt = /^optimize\.([^.]+)\.([^.]+)\.to_(.+)$/.exec(id)
  if (opt) return (opt[1] === 'gongwen' ? t('Official document', '公文优化') : opt[1]) + ' · ' + opt[2].toUpperCase() + ' → ' + opt[3].toUpperCase()
  const convert = /^(?:convert|render)\.([^.]+)\.to_(.+)$/.exec(id)
  if (convert) return convert[1].toUpperCase() + ' → ' + convert[2].replaceAll('_',' ').toUpperCase()
  return id
}
