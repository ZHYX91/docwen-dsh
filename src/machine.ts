import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export { DOCX, MARKDOWN } from './media.js'
export const EXPORT = 'convert.markdown_source.to_docx'
export const IMPORT = 'convert.docx.to_markdown'

type Json = Record<string, unknown>

export function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a Machine object.')
  }
  return value as Json
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Expected a nonempty Machine string.')
  return value
}

export function objects(value: unknown): Json[] {
  if (!Array.isArray(value)) throw new Error('Expected a Machine array.')
  return value.map(object)
}

export interface Input {
  input_id: string
  locator: { kind: 'local_path'; path: string }
  role: string
  kind: 'document' | 'resource'
  logical_path: string
  media_type: string
  size_bytes: number
  sha256: string
}

export interface ManagedProcess {
  stdin?: Writable
  stdout?: Readable
  stderr?: Readable
  done: Promise<{ exitCode: number | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

export class UnconfirmedExit extends Error {
  constructor() {
    super('DocWen process cleanup could not be confirmed. Its private staging directory was retained.')
  }
}

const MAX_FRAME = 16 * 1024 * 1024
const MAX_HEADER = 1024
const END = Buffer.from('\r\n\r\n')

async function* messages(stream: Readable): AsyncGenerator<Json> {
  const header = Buffer.alloc(MAX_HEADER)
  let used = 0
  let body: Buffer | undefined
  for await (const incoming of stream) {
    const chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming)
    let offset = 0
    while (offset < chunk.length) {
      if (!body) {
        if (used === MAX_HEADER) throw new Error('Invalid Machine frame header.')
        header[used++] = chunk[offset++]
        if (used < END.length || !header.subarray(used - END.length, used).equals(END)) continue
        const match = /^Content-Length: ([1-9][0-9]*)$/i.exec(header.subarray(0, used - END.length).toString('latin1'))
        const length = Number(match?.[1])
        if (!Number.isSafeInteger(length) || length > MAX_FRAME) throw new Error('Invalid Machine frame length.')
        body = Buffer.allocUnsafe(length)
        used = 0
      }
      const count = Math.min(body.length - used, chunk.length - offset)
      chunk.copy(body, used, offset, offset + count)
      offset += count
      used += count
      if (used !== body.length) continue
      const message = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
      if (message.jsonrpc !== '2.0') throw new Error('Invalid Machine message.')
      body = undefined
      used = 0
      yield message
    }
  }
  if (used || body) throw new Error('Truncated Machine frame.')
}

function write(stream: Writable, message: Json): void {
  if (!stream.writable || stream.destroyed) throw new Error('DocWen closed its input.')
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
  if (body.length > MAX_FRAME) throw new Error('The request exceeds the Machine frame limit.')
  stream.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

interface Session {
  call(method: string, params: Json): Promise<Json>
  next(): Promise<Json>
  accepted(id: string): void
}

async function withMachine<T>(
  child: ManagedProcess, signal: AbortSignal, work: (session: Session) => Promise<T>,
): Promise<T> {
  const { stdin: input, stdout: output } = child
  const done = child.done.catch(() => ({ exitCode: null }))
  let task: string | undefined
  let failed = true
  // Interrupt a pending frame read even if a broken child never closes its pipes.
  let interrupt!: (error: unknown) => void
  const interrupted = new Promise<never>((_resolve, reject) => { interrupt = reject })
  void interrupted.catch(() => {})
  const abort = () => {
    if (task && input) {
      try { write(input, { id: 'cancel', method: 'task/cancel', params: { task_id: task } }) } catch { /* close below */ }
    }
    interrupt(signal.reason)
  }
  const onPipeError = () => interrupt(new Error('The DocWen process pipe failed.'))
  let stderrBytes = 0
  const onStderr = (chunk: Buffer) => {
    stderrBytes += chunk.length
    if (stderrBytes > 64 * 1024) interrupt(new Error('DocWen exceeded the diagnostic output limit.'))
  }
  signal.addEventListener('abort', abort, { once: true })
  input?.on('error', onPipeError)
  child.stderr?.on('data', onStderr)
  try {
    signal.throwIfAborted()
    if (!input || !output) throw new Error('The DSH subprocess provider did not return both DocWen pipes.')
    const frames = messages(output)
    const next = async () => {
      const frame = await Promise.race([frames.next(), interrupted])
      if (frame.done) throw new Error('DocWen closed its Machine stream before completion.')
      return frame.value
    }
    let requestId = 0
    const call = async (method: string, params: Json) => {
      signal.throwIfAborted()
      const id = ++requestId
      write(input, { id, method, params })
      const response = await next()
      if (response.id !== id) throw new Error(`Unexpected response to ${method}.`)
      if (response.error) {
        const err = object(response.error)
        const detail = objectOrEmpty(objectOrEmpty(err.data).task_error)
        const code = typeof detail.code === 'string' ? ` (${detail.code})` : ''
        throw new Error(`${method}${code}: ${text(err.message)}`)
      }
      return object(response.result)
    }
    const hello = await call('initialize', {
      protocol: { name: 'docwen.machine', major: 2, minor: 0 },
      client: { name: 'DocWen DSH', version: '0.1.0' },
      features: { progress: true, cancellation: true },
    })
    const protocol = object(hello.protocol)
    if (protocol.name !== 'docwen.machine' || protocol.major !== 2 || protocol.minor !== 0 ||
        object(hello.server).name !== 'DocWen' || hello.artifact_bundle_schema !== 'docwen.artifact_bundle.v3') {
      throw new Error('DocWen Machine v2 and Artifact Bundle v3 are required.')
    }
    const result = await work({ call, next, accepted: id => { task = id } })
    signal.throwIfAborted()
    failed = false
    return result
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      input?.end()
      const exit = await Promise.race([done, delay(1500, null, { ref: false })])
      if (!exit) child.terminate()
      const stopped = await Promise.race([
        child.waitForExit(AbortSignal.timeout(6000)).catch(() => false), delay(6000, false, { ref: false }),
      ])
      if (!stopped) throw new UnconfirmedExit()
      if (!failed && (exit ?? await Promise.race([done, delay(500, null, { ref: false })]))?.exitCode !== 0) {
        throw new Error('DocWen did not exit cleanly.')
      }
      signal.throwIfAborted()
    } finally {
      input?.off('error', onPipeError)
      child.stderr?.off('data', onStderr)
    }
  }
}

function objectOrEmpty(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

export interface MachineCatalog {
  capabilities: Json[]
  templates: Json[]
  numberingSchemes: Json[]
  optimizations: Json[]
}

async function resources(session: Session, kind: string): Promise<Json[]> {
  return objects((await session.call('resource/list', { kind })).resources)
}

export async function discoverMachine(child: ManagedProcess, signal: AbortSignal): Promise<MachineCatalog> {
  return withMachine(child, signal, async session => ({
    capabilities: objects((await session.call('capability/list', {})).capabilities),
    templates: await resources(session, 'templates'),
    numberingSchemes: await resources(session, 'numbering-schemes'),
    optimizations: await resources(session, 'optimizations'),
  }))
}

export async function runMachine(
  child: ManagedProcess, capabilityId: string, inputs: Input[], staging: string, requested: Json,
  signal: AbortSignal, onProgress?: (percent: number) => void,
): Promise<{ taskId: string; bundle: Json; diagnostics: Json[] }> {
  return withMachine(child, signal, async session => {
    const discovery = await session.call('capability/list', {})
    const capability = objects(discovery.capabilities).find(item => item.capability_id === capabilityId)
    if (capability?.availability !== 'available' && capability?.availability !== 'limited') {
      throw new Error(`DocWen cannot run ${capabilityId} in this installation.`)
    }
    const properties = object(object(capability.options_schema).properties)
    const options = { ...requested }
    if (capabilityId === EXPORT && !Object.hasOwn(options, 'template_name') && Object.hasOwn(properties, 'template_name')) {
      const templates = await resources(session, 'templates')
      const template = templates.find(item => item.target === 'docx' && item.is_default === true)
      if (template) options.template_name = text(template.id)
    }
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`The installed DocWen does not support ${key} for this operation.`)
    }
    const plan = await session.call('task/plan', {
      capability_id: capabilityId, inputs, options,
      output: { staging_root: { kind: 'local_path', path: staging }, staging_policy: 'require_empty' },
    })
    if (plan.requires_confirmation === true) throw new Error('This DocWen plan requires explicit confirmation.')
    const accepted = await session.call('task/execute', { plan_id: text(plan.plan_id) })
    if (accepted.state !== 'accepted') throw new Error('DocWen rejected the task.')
    const taskId = text(accepted.task_id)
    session.accepted(taskId)
    let sequence = 0
    while (true) {
      const message = await session.next()
      const params = object(message.params)
      if (params.task_id !== taskId || typeof params.sequence !== 'number' ||
          !Number.isSafeInteger(params.sequence) || params.sequence <= sequence) {
        throw new Error('DocWen sent a notification for the wrong task or sequence.')
      }
      sequence = params.sequence
      if (message.method === 'task/progress') {
        if (typeof params.completed === 'number' && Number.isFinite(params.completed) &&
            typeof params.total === 'number' && Number.isFinite(params.total) && params.total > 0 &&
            params.completed >= 0 && params.completed <= params.total) {
          onProgress?.(Math.round(100 * params.completed / params.total))
        }
        continue
      }
      if (message.method === 'task/cancelled') throw new Error('DocWen cancelled the task.')
      if (message.method === 'task/failed') throw new Error(text(object(params.error).message))
      if (message.method !== 'task/completed') throw new Error('Unexpected DocWen task notification.')
      return { taskId, bundle: object(params.bundle), diagnostics: objects(params.diagnostics) }
    }
  })
}
