import path from 'node:path'
import { fileMedia } from './media.js'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { object, objects, text, type Input } from './machine.js'
import { portablePath } from './documents.js'

export type Json = Record<string, unknown>
export const MIXED = 'docwen-dsh.merge-layouts'
export const PDF = 'application/pdf'
const layouts = ['application/vnd.ofd', 'application/vnd.ms-xpsdocument']
export function mediaFor(name: string): string {
  const media = fileMedia(name)
  if (!media) throw new Error('This file type is not supported by the document workbench.')
  return media
}

export interface Source {
  name: string
  media: string
  bytes: Uint8Array
  role?: string
}
export interface Admitted {
  type: string
  attachment: Json
}

export function available(item: Json): boolean {
  return item.availability === 'available' || item.availability === 'limited'
}

export function inputSlots(capability: Json): Json[] {
  return objects(object(capability.input_shape).slots)
}

export function assignInputs(
  capability: Json,
  sources: Source[],
): { name: string; role: Input['role']; kind: Input['kind'] }[] {
  const slots = inputSlots(capability)
  const count = new Map<string, number>()
  const names = new Set<string>()
  const assigned = sources.map((source, index) => {
    const possible = slots.filter(
      (slot) => Array.isArray(slot.media_types) && slot.media_types.includes(source.media),
    )
    const slot = source.role
      ? possible.find((s) => s.role === source.role)
      : (possible.find((s) => s.role === 'source') ?? (possible.length === 1 ? possible[0] : undefined))
    if (!slot || (slot.kind !== 'document' && slot.kind !== 'resource'))
      throw new Error('A selected file does not match a declared input slot.')
    const role = text(slot.role) as Input['role']
    count.set(role, (count.get(role) ?? 0) + 1)
    let name = portablePath(source.name)
    // Independent inputs may have identical basenames. Linked resource paths are part of authored Markdown.
    if (names.has(name.toLowerCase()) && role === 'source') name = `inputs/${index + 1}/${name}`
    if (names.has(name.toLowerCase())) throw new Error('Two selected resources have the same logical path.')
    names.add(name.toLowerCase())
    return { name, role, kind: slot.kind as Input['kind'] }
  })
  for (const slot of slots) {
    const n = count.get(text(slot.role)) ?? 0
    if (
      typeof slot.min_items !== 'number' ||
      n < slot.min_items ||
      (typeof slot.max_items === 'number' && n > slot.max_items)
    ) {
      throw new Error(`The number of files selected for ${slot.role} does not match the capability.`)
    }
  }
  return assigned
}

/** Offer the plugin's multi-step action only for layouts that can actually reach PDF. */
export function withLayoutMerge<T extends { capabilities: Json[] }>(catalog: T): T {
  const supported: string[] = []
  let merge: Json | undefined
  for (const media of layouts) {
    try {
      const plan = layoutPlan(catalog.capabilities, [PDF, media])
      if (plan.converters.some(Boolean)) {
        supported.push(media)
        merge = plan.merge
      }
    } catch {
      /* A missing route leaves the corresponding layout unavailable. */
    }
  }
  if (!merge) return catalog
  return {
    ...catalog,
    capabilities: [
      ...catalog.capabilities,
      {
        ...merge,
        capability_id: MIXED,
        input_shape: {
          slots: [{ role: 'source', kind: 'resource', media_types: [PDF, ...supported], min_items: 2 }],
          undeclared_roles: 'reject',
        },
      },
    ],
  }
}

// Resolve only declared one-input, one-PDF conversions. The merge receives the original positional order.
export function layoutPlan(
  capabilities: Json[],
  media: string[],
): { merge: Json; converters: (Json | undefined)[] } {
  if (media.length < 2 || media.some((m) => m !== PDF && !layouts.includes(m)))
    throw new Error('Select at least two PDF, OFD or XPS files in merge order.')
  const runnable = capabilities.filter(available)
  const singlePDF = (c: Json) =>
    Array.isArray(c.output_media_types) &&
    c.output_media_types.length === 1 &&
    c.output_media_types[0] === PDF &&
    object(c.output_shape).cardinality === 'one'
  const sourceOnly = (c: Json, types: string[], single: boolean) => {
    const slots = inputSlots(c)
    const slot = slots.find((s) => s.role === 'source')
    return (
      slot &&
      slots.every((s) => s.role === 'source' || s.min_items === 0) &&
      types.every((t) => Array.isArray(slot.media_types) && slot.media_types.includes(t)) &&
      (single
        ? slot.max_items === 1 && slot.min_items === 1
        : Number(slot.min_items) <= types.length &&
          (slot.max_items == null || Number(slot.max_items) >= types.length))
    )
  }
  const mergeFor = (types: string[]) =>
    runnable.find((c) => c.operation === 'merge' && singlePDF(c) && sourceOnly(c, types, false))
  const direct = mergeFor(media)
  if (direct) return { merge: direct, converters: media.map(() => undefined) }
  const merge = mergeFor(media.map(() => PDF))
  if (!merge) throw new Error('This DocWen installation has no available PDF merge capability.')
  return {
    merge,
    converters: media.map((type) => {
      if (type === PDF) return undefined
      const converter = runnable.find(
        (c) =>
          (c.operation === 'convert' || c.operation === 'render') &&
          singlePDF(c) &&
          sourceOnly(c, [type], true) &&
          (!Array.isArray(object(c.options_schema).required) ||
            (object(c.options_schema).required as unknown[]).length === 0),
      )
      if (!converter) throw new Error(`This installation has no Machine conversion from ${type} to PDF.`)
      return converter
    }),
  }
}

/** Canonical inline destinations are interpreted by every supported Core. Preserve visible alt text,
 * including for reference-style images; never substitute inside code or ordinary links. */
export function bindImagePaths(markdown: string, paths: Map<string, string>) {
  const bindings = new Map<string, string>()

  const edits: [number, number, string][] = []
  function walk(node: Nodes) {
    if ((node.type === 'image' || node.type === 'imageReference') && node.position) {
      const start = node.position.start.offset,
        end = node.position.end.offset
      if (start !== undefined && end !== undefined) {
        const logical = paths.get(markdown.slice(start, end))
        if (logical) {
          const alt = (node.alt ?? '').replace(/[\\\[\]]/gu, (value) => '\\' + value)
          const next = `![${alt}](${logical})`
          edits.push([start, end, next])
          bindings.set(next, logical)
        }
      }
    } else if ('children' in node) node.children.forEach(walk)
  }
  walk(fromMarkdown(markdown))
  let offset = 0
  const pieces: string[] = []
  for (const [start, end, replacement] of edits) {
    pieces.push(markdown.slice(offset, start), replacement)
    offset = end
  }
  pieces.push(markdown.slice(offset))
  return {
    markdown: pieces.join(''),
    images: [...bindings].map(([authored_token, logical_path]) => ({ authored_token, logical_path })),
  }
}

export { visibleAttachments } from './history.js'
