import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerEntries, type EntryApi, type EntryHost } from '../src/entries.js'
import { completedReply, readWorkspaceFile, type WorkspaceFiles } from '../src/history.js'

const signal = new AbortController().signal
const file = { id: 'word', path: 'Report.docx', sha256: 'f'.repeat(64), media: 'application/test', bytes: 50 }
const result = { id: 'result-1', label: 'Report', created: '', primary: file.id, files: [file], warnings: [] }
const session = (id: string) => ({
  id, appended: [] as unknown[], append(event: string, data: unknown) { this.appended.push({ event, data }) },
})

function mount() {
  type Command = Parameters<NonNullable<EntryHost['commands']>['register']>[0]
  type Tool = Parameters<NonNullable<EntryHost['tools']>['register']>[0]
  let command!: Command
  let tool!: Tool
  let notify!: Parameters<EntryHost['on']>[1]
  const calls: Parameters<EntryApi['run']>[] = []
  const ctx: EntryHost = {
    inject(_services, callback) { callback(ctx) },
    commands: { register(value) { command = value } }, tools: { register(value) { tool = value } },
    agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 2, lastTurn: 8 }) },
    on(_event, listener) { notify = listener },
  }
  const api: EntryApi = {
    async list() { return { results: [result] } },
    async catalog() { return { capabilities: [], templates: [], numberingSchemes: [], optimizations: [] } },
    async run(...input) { calls.push(input); return result },
    cancel() { return true },
    async delivery() { return [{ path: '/private/task/result/Report.docx' }] },
  }
  registerEntries(ctx, api)
  return { command, tool, calls, notify }
}

test('slash command processes only DSH-admitted files in submission order, outside a turn', async () => {
  const { command, calls } = mount()
  const own = session('cold-session')
  const attachments = ['b', 'a'].map(attachmentId => ({ type: 'file' as const, attachment: { attachmentId, bytes: 123, name: 'part.pdf' } }))
  const invoke = (rawInput: string) => command.handler({ agent: { session: own }, signal, attachments, rawInput })
  assert.equal(command.recordInput, false)
  assert.equal(command.input.attachments, true)
  assert.equal((await invoke(' process merge.pdf.documents')).kind, 'success')
  assert.deepEqual(calls[0], [own.id, {
    action: 'process', capabilityId: 'merge.pdf.documents', sources: [
      { kind: 'attachment', attachmentId: 'b' }, { kind: 'attachment', attachmentId: 'a' },
    ], options: {},
  }, signal, attachments])
  assert.equal((await invoke(' results')).kind, 'error')
  assert.equal(calls.length, 1)
  assert.deepEqual(own.appended, [])
})

test('model reports opaque result identity; the host presents only after authoritative success', async () => {
  const { tool, calls, notify } = mount()
  const own = session('actor')
  const exec = { agent: { session: own }, callId: 'call-1', signal }
  const args = { action: 'export', messageIds: ['reply-2', 'reply-1'], options: { proofread: {} } }
  const response = await tool.execute(args, exec)
  assert.deepEqual(calls[0], [own.id, args, signal, undefined])
  assert.doesNotMatch(JSON.stringify(response), /private\/task/u)
  assert.deepEqual(own.appended, [])
  notify(exec, { isError: true })
  notify(exec, {})
  assert.deepEqual(own.appended, [])
  const success = { ...exec, callId: 'call-2' }
  await tool.execute(args, success)
  notify(success, {})
  notify(success, {})
  assert.deepEqual(own.appended, [{ event: 'deliverables/presented', data: {
    turn: 8, callId: 'call-2', files: [{ path: '/private/task/result/Report.docx' }],
  } }])
})

test('model arguments cannot choose another session, supply host references, or name files outside the workspace', async () => {
  const { tool, calls } = mount()
  const exec = { agent: { session: session('s') }, callId: 'c', signal }
  const args = { action: 'process', capabilityId: 'validate.docx' }
  await assert.rejects(tool.execute({ ...args, sessionId: 'foreign' }, exec), /Unsupported/)
  for (const bad of [{ kind: 'workspace', path: 'C:\\other.docx' }, { kind: 'workspace', path: '../outside.docx' },
    { kind: 'workspace', path: '/private/a.docx' }, { kind: 'attachment', attachmentId: 'valid', ref: { name: 'spoof' } }]) {
    await assert.rejects(tool.execute({ ...args, sources: [bad] }, exec))
  }
  await assert.rejects(tool.execute({ action: 'results' }, { callId: 'c', signal }), /conversation/)
  assert.deepEqual(calls, [])
  await tool.execute({ ...args, sources: [{ kind: 'workspace', path: 'notes/accepted.docx' }] }, exec)
  assert.equal(calls.length, 1)
})

test('workspace snapshot checks canonical containment before content and rejects incomplete or changed reads', async () => {
  const scope = { sessionId: 's', workspaceRoot: '/a/work' }
  const stat = { absolutePath: '/a/work/good', bytes: 1, version: 'v' }
  let reads = 0
  const files: WorkspaceFiles = {
    scopeOf: async () => scope,
    stat: async () => stat,
    readBytes: async () => { reads++; return { ...stat, offset: 0, eof: true, data: new Uint8Array(1) } },
  }
  await assert.rejects(readWorkspaceFile(files, scope, '../outside', 1, signal))
  await assert.rejects(readWorkspaceFile({ ...files, stat: async () => ({ ...stat, absolutePath: '/outside' }) }, scope, 'link/child', 1, signal))
  assert.equal(reads, 0)
  const [byte] = await readWorkspaceFile(files, scope, 'good', 1, signal)
  assert.equal(byte, 0)
  const changed = { ...files, readBytes: async () => ({ ...stat, offset: 0, eof: true, data: new Uint8Array(1), version: 'new' }) }
  await assert.rejects(readWorkspaceFile(changed, scope, 'good', 1, signal), /changed/)
})

test('only the named committed visible reply in a completed turn can be exported', () => {
  const message = (id: string) => ({ type: 'assistant/message', surfaceOp: 'append', data: { message: {
    id, content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: id }],
  } } })
  const events = [{ type: 'turn/start' }, message('selected'), message('later')]
  const end = (kind: string) => ({ type: 'turn/end', data: { reason: { kind } } })
  assert.equal(completedReply([...events, end('completed')], 'selected').markdown, 'selected')
  for (const bad of ['aborted', 'blocked', 'error']) assert.throws(() => completedReply([...events, end(bad)], 'selected'))
  assert.throws(() => completedReply([message('selected'), end('completed')], 'selected'))
})
