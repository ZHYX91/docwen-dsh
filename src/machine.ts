import type { Readable, Writable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const MARKDOWN = 'text/markdown'
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
  role: 'source' | 'linked_resource'
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
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let length: number | undefined
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)])
    while (pending.length) {
      if (length === undefined) {
        const end = pending.indexOf(END)
        if (end < 0 && pending.length <= MAX_HEADER) break
        const header = end < 0 || end > MAX_HEADER ? '' : pending.subarray(0, end).toString('ascii')
        const match = /^Content-Length: ([1-9][0-9]*)$/i.exec(header)
        length = Number(match?.[1])
        if (!Number.isSafeInteger(length) || length > MAX_FRAME) throw new Error('Invalid Machine frame length.')
        pending = pending.subarray(end + END.length)
      }
      if (pending.length < length) break
      const body = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, length))
      pending = pending.subarray(length)
      length = undefined
      const message = object(JSON.parse(body))
      if (message.jsonrpc !== '2.0') throw new Error('Invalid Machine message.')
      yield message
    }
  }
  if (pending.length || length !== undefined) throw new Error('Truncated Machine frame.')
}

function write(stream: Writable, message: Json): void {
  if (!stream.writable || stream.destroyed) throw new Error('DocWen closed its input.')
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
  stream.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]))
}

export async function runMachine(
  child: ManagedProcess,
  capabilityId: typeof EXPORT | typeof IMPORT,
  inputs: Input[],
  staging: string,
  requested: Json,
  signal: AbortSignal,
): Promise<{ taskId: string; bundle: Json; diagnostics: Json[] }> {
  let taskId: string | undefined
  let success = false
  let hardStop: NodeJS.Timeout | undefined
  let stderrBytes = 0
  const done = child.done.catch(() => ({ exitCode: null }))
  const input = child.stdin
  const output = child.stdout
  const cancel = () => {
    if (taskId && input) {
      try { write(input, { id: 'cancel', method: 'task/cancel', params: { task_id: taskId } }) } catch { /* fall through to termination */ }
    }
    hardStop ??= setTimeout(() => child.terminate(), 4000).unref()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    if (!input || !output) throw new Error('The DSH subprocess provider did not return both DocWen pipes.')
    input.on('error', () => child.terminate())
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > 64 * 1024) child.terminate()
    })
    const frames = messages(output)
    const next = async () => {
      const frame = await frames.next()
      if (frame.done) {
        signal.throwIfAborted()
        throw new Error('DocWen closed its Machine stream before completing the task.')
      }
      return frame.value
    }
    let requestId = 0
    const call = async (method: string, params: Json) => {
      signal.throwIfAborted()
      const id = ++requestId
      write(input, { id, method, params })
      const response = await next()
      if (response.id !== id) throw new Error(`Unexpected response to ${method}.`)
      if (response.error) throw new Error(`${method}: ${text(object(response.error).message)}`)
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

    const discovery = await call('capability/list', {})
    const capability = objects(discovery.capabilities).find(item => item.capability_id === capabilityId)
    if (capability?.availability !== 'available') throw new Error(`DocWen cannot run ${capabilityId} in this installation.`)
    const properties = object(object(capability.options_schema).properties)
    const options = { ...requested }
    if (capabilityId === EXPORT && !Object.hasOwn(options, 'template_name')) {
      const templates = objects((await call('resource/list', { kind: 'templates' })).resources)
      const template = templates.find(item => item.target === 'docx' && item.is_default === true)
      if (template) options.template_name = text(template.id)
    }
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(properties, key)) throw new Error(`The installed DocWen does not support ${key} for this operation.`)
    }
    const plan = await call('task/plan', {
      capability_id: capabilityId, inputs, options,
      output: { staging_root: { kind: 'local_path', path: staging }, staging_policy: 'require_empty' },
    })
    const accepted = await call('task/execute', { plan_id: text(plan.plan_id) })
    if (accepted.state !== 'accepted') throw new Error('DocWen rejected the task.')
    taskId = text(accepted.task_id)
    if (signal.aborted) cancel()
    let sequence = 0
    while (true) {
      const message = await next()
      if (message.id === 'cancel') continue
      const params = object(message.params)
      if (params.task_id !== taskId || typeof params.sequence !== 'number' || params.sequence <= sequence) {
        throw new Error('DocWen sent a notification for the wrong task or sequence.')
      }
      sequence = params.sequence
      if (message.method === 'task/progress') continue
      signal.throwIfAborted()
      if (message.method === 'task/cancelled') throw new Error('DocWen cancelled the task.')
      if (message.method === 'task/failed') throw new Error(text(object(params.error).message))
      if (message.method !== 'task/completed') throw new Error('Unexpected DocWen task notification.')
      const result = { taskId, bundle: object(params.bundle), diagnostics: objects(params.diagnostics) }
      success = true
      return result
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    clearTimeout(hardStop)
    input?.end()
    const exit = await Promise.race([done, delay(1500, null, { ref: false })])
    if (!exit || !success) child.terminate()
    const stopped = await child.waitForExit(AbortSignal.timeout(6000)).catch(() => false)
    if (!stopped) throw new UnconfirmedExit()
    if (success && (await done).exitCode !== 0) throw new Error('DocWen did not exit cleanly after returning its result.')
  }
}
