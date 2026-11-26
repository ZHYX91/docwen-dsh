import type { Result } from './documents.js'
import type { MachineCatalog } from './machine.js'

type Json = Record<string, unknown>
export type EntrySource =
  | { kind: 'workspace'; path: string }
  | { kind: 'result'; resultId: string; artifactId: string }
  | { kind: 'attachment'; attachmentId: string }
export type EntryIntent =
  | { action: 'export'; messageIds: string[]; options: Json }
  | { action: 'process'; capabilityId: string; sources: EntrySource[]; options: Json }
export type AdmittedAttachment = { type: 'file' | 'image'; attachment: Json }
type DeliveredFile = { path: string; description?: string }
export interface EntryApi {
  list(sessionId: string, signal: AbortSignal): Promise<Result[]>
  catalog(sessionId: string, signal: AbortSignal): Promise<MachineCatalog>
  run(sessionId: string, intent: EntryIntent, signal: AbortSignal, admitted?: readonly AdmittedAttachment[]): Promise<Result>
  cancel(sessionId: string, taskId: string): boolean
  delivery?(sessionId: string, resultId: string, signal: AbortSignal): Promise<DeliveredFile[]>
}

interface Session {
  id: string
  append(event: 'deliverables/presented', data: { turn: number; callId: string; files: DeliveredFile[] }): unknown
}
interface Invocation {
  agent: { session: Session }
  rawInput: string
  attachments: readonly AdmittedAttachment[]
  signal: AbortSignal
}
interface ToolCall {
  callId: string
  agent?: { session: Session }
  signal: AbortSignal
}
export interface EntryHost {
  inject(services: string[], callback: (scope: EntryHost) => void): unknown
  commands?: { register(definition: {
    name: string; description: string; input: { hint: string; attachments: boolean }; recordInput: boolean
    handler(invocation: Invocation): Promise<{ kind: 'success' | 'error'; text: string }>
  }): unknown }
  tools?: { register(definition: {
    name: string; description: string; parameters: Json
    output: { schema: Json; render(args: unknown, output: unknown): { type: 'text'; text: string }[] }
    execute(args: unknown, exec: ToolCall): Promise<Json>
  }): unknown }
  agents?: { turnBoundaryOf(session: Session): { openTurnStartSeq: number | null; lastTurn: number } }
  on(event: 'tools/result', listener: (exec: ToolCall, result: { isError?: boolean }) => void): unknown
}

const help = [
  '/docwen capabilities [capability-id] — discover operations, options and templates',
  '/docwen results — list saved results in this conversation',
  '/docwen export <message-id> [more IDs] — export completed replies in order',
  '/docwen process <capability-id> — process the files attached to this command in order',
  '/docwen run <JSON> — specify export or process options and ordered sources',
  '/docwen cancel <task-id> — cancel an active operation',
].join('\n')

function record(value: unknown, name: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected an object for ${name}.`)
  return value as Json
}
function keys(obj: Json, allowed: string[]) {
  if (Object.keys(obj).some(key => !allowed.includes(key))) throw new Error('Unsupported DocWen argument.')
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,180}$/u.test(value)) throw new Error('Invalid DocWen identifier.')
  return value
}
function bounded<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Choose between 1 and 32 items.')
  return value.map(parse)
}

function source(value: unknown): EntrySource {
  const s = record(value, 'source')
  if (s.kind === 'workspace') {
    keys(s, ['kind', 'path'])
    if (typeof s.path !== 'string' || !s.path || s.path.length > 1024 || /[\x00-\x1f]/u.test(s.path) ||
        /^[\\/]|^[a-z][a-z\d+.\-]*:/iu.test(s.path) || s.path.split(/[\\/]/u).includes('..')) {
      throw new Error('Choose a workspace-relative source file.')
    }
    return { kind: 'workspace', path: s.path }
  }
  if (s.kind === 'result') {
    keys(s, ['kind', 'resultId', 'artifactId'])
    return { kind: 'result', resultId: id(s.resultId), artifactId: id(s.artifactId) }
  }
  if (s.kind === 'attachment') {
    keys(s, ['kind', 'attachmentId'])
    return { kind: 'attachment', attachmentId: id(s.attachmentId) }
  }
  throw new Error('Unsupported DocWen source.')
}

function taskIntent(args: Json): EntryIntent {
  const options = args.options === undefined ? {} : record(args.options, 'options')
  if (args.action === 'export') {
    keys(args, ['action', 'messageIds', 'options'])
    return { action: 'export', messageIds: bounded(args.messageIds, id), options }
  }
  if (args.action === 'process') {
    keys(args, ['action', 'capabilityId', 'sources', 'options'])
    return { action: 'process', capabilityId: id(args.capabilityId), sources: bounded(args.sources, source), options }
  }
  throw new Error('Unknown DocWen action.')
}

function commandInput(raw: string, attached: readonly AdmittedAttachment[]): Json {
  if (raw.length > 65536) throw new Error('The DocWen command is too large.')
  const line = raw.trim()
  const [verb, ...words] = line.split(/\s+/u)
  if (attached.length && verb !== 'process') throw new Error('Use /docwen process <capability-id> with attached files.')
  if ((!verb || verb === 'help' || verb === 'results') && !words.length) return { action: verb || 'help' }
  if (verb === 'capabilities' && words.length <= 1) return { action: verb, ...(words[0] ? { capabilityId: words[0] } : {}) }
  if (verb === 'cancel' && words.length === 1) return { action: verb, taskId: words[0] }
  if (verb === 'export') return { action: verb, messageIds: words }
  if (verb === 'process' && words.length === 1 && attached.length) {
    return { action: verb, capabilityId: words[0], sources: attached.map(block => ({ kind: 'attachment', attachmentId: id(block.attachment.attachmentId) })) }
  }
  if (verb === 'run') {
    const parsed = record(JSON.parse(line.slice(3)), 'run')
    return taskIntent(parsed)
  }
  throw new Error(help)
}

function summary(result: Result) {
  return { id: result.id, label: result.label, primary: result.primary,
    files: result.files.map(file => ({ id: file.id, name: file.path, media: file.media, bytes: file.bytes })) }
}

function catalogView(catalog: MachineCatalog, capabilityId?: string): Json {
  if (capabilityId !== undefined) {
    const selected = catalog.capabilities.find(item => item.capability_id === capabilityId)
    if (!selected) throw new Error('This installation does not advertise that capability.')
    return { id: capabilityId, availability: selected.availability, inputs: selected.input_shape, outputs: selected.output_shape,
      options: selected.options_schema }
  }
  const names = (items: Json[]) => items.map(({ id, name }) => ({ id, name }))
  return { capabilities: catalog.capabilities.map(({ capability_id, availability }) => ({ id: capability_id, availability })),
    templates: names(catalog.templates), numberingSchemes: names(catalog.numberingSchemes), optimizations: names(catalog.optimizations) }
}

const parameters = {
  type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['capabilities', 'results', 'export', 'process', 'cancel'] },
    capabilityId: { type: 'string', description: 'Use an ID advertised by capabilities. Optional to describe one capability.' },
    taskId: { type: 'string' }, messageIds: { type: 'array', items: { type: 'string' }, description: 'Completed historical reply IDs, in requested order.' },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind'], properties: {
      kind: { type: 'string', enum: ['workspace', 'attachment', 'result'] }, path: { type: 'string', description: 'Requested workspace-relative file.' },
      attachmentId: { type: 'string' }, resultId: { type: 'string' }, artifactId: { type: 'string' },
    } } }, options: { type: 'object', additionalProperties: true, description: 'Options declared for the selected capability.' },
  },
}

export function registerEntries(ctx: EntryHost, api: EntryApi): void {
  async function invoke(session: Session, args: Json, signal: AbortSignal, admitted?: readonly AdmittedAttachment[]) {
    signal.throwIfAborted()
    if (args.action === 'help') { keys(args, ['action']); return { value: { help } } }
    if (args.action === 'results') {
      keys(args, ['action'])
      return { value: { results: (await api.list(session.id, signal)).map(summary) } }
    }
    if (args.action === 'capabilities') {
      keys(args, ['action', 'capabilityId'])
      const requested = args.capabilityId === undefined ? undefined : id(args.capabilityId)
      return { value: catalogView(await api.catalog(session.id, signal), requested) }
    }
    if (args.action === 'cancel') {
      keys(args, ['action', 'taskId'])
      return { value: { cancellationRequested: api.cancel(session.id, id(args.taskId)) } }
    }
    const result = await api.run(session.id, taskIntent(args), signal, admitted)
    return { value: { result: summary(result) }, result }
  }

  ctx.inject(['commands'], scope => scope.commands?.register({
    name: 'docwen', description: 'Process documents in this conversation without a model call.',
    input: { hint: 'help, capabilities, results, export, process, run or cancel', attachments: true }, recordInput: false,
    async handler({ agent, rawInput, attachments, signal }) {
      try {
        const args = commandInput(rawInput, attachments)
        const { value, result } = await invoke(agent.session, args, signal, attachments)
        return { kind: 'success', text: result ? `Saved ${result.label} (${result.id}). Open DocWen in the session panel.`
          : 'help' in value ? String(value.help) : JSON.stringify(value, null, 2) }
      } catch (error) {
        signal.throwIfAborted()
        return { kind: 'error', text: error instanceof Error ? error.message : 'The DocWen operation failed.' }
      }
    },
  }))

  ctx.inject(['tools', 'agents'], scope => {
    const pending = new WeakMap<ToolCall, { session: Session; turn: number; files: DeliveredFile[] }>()
    scope.tools?.register({
      name: 'docwen', description: 'Discover local DocWen operations, export committed replies, process selected files in order, and list saved results. Use only inputs requested by the user. Generated files are available in the DocWen session panel.',
      parameters, output: { schema: { type: 'object', additionalProperties: true },
        render: (_args, output) => [{ type: 'text', text: JSON.stringify(output) }] },
      async execute(raw, exec) {
        const session = exec.agent?.session
        if (!session) throw new Error('DocWen requires a conversation.')
        const boundary = scope.agents?.turnBoundaryOf(session)
        const { value, result } = await invoke(session, record(raw, 'arguments'), exec.signal)
        if (result && boundary && boundary.openTurnStartSeq !== null && api.delivery) {
          try {
            const files = await api.delivery(session.id, result.id, exec.signal)
            if (files.length) pending.set(exec, { session, turn: boundary.lastTurn, files })
          } catch {
            exec.signal.throwIfAborted() // The completed result remains accessible in the panel.
          }
        }
        return value
      },
    })
    scope.on('tools/result', (exec, outcome) => {
      const delivery = pending.get(exec)
      pending.delete(exec)
      if (delivery && !outcome.isError && !exec.signal.aborted) delivery.session.append('deliverables/presented', {
        turn: delivery.turn, callId: exec.callId, files: delivery.files,
      })
    })
  })
}
