import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { collectBundle, hash, imageTargets, portablePath, readResultFile, sections } from '../src/documents.js'
import { completedReply, replyImages } from '../src/history.js'
import { IMPORT, MARKDOWN, runMachine } from '../src/machine.js'

test('finds only the selected completed reply and the attachments already available when it was written', () => {
  const old = { attachmentId: 'stored', mediaType: 'image/png', bytes: 4 }
  const events = [
    { type: 'turn/start' },
    { type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'image', attachment: old }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { message: {
      id: 'reply1', content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: '## Original reply' }],
    } } },
    { type: 'turn/end' },
    { type: 'turn/start' },
    { type: 'assistant/message', surfaceOp: 'append', data: { message: {
      id: 'reply2', content: [{ type: 'text', text: 'Incomplete reply' }],
    } } },
  ]
  assert.deepEqual(completedReply(events, 'reply1'), { markdown: '## Original reply', refs: [old] })
  assert.throws(() => completedReply(events, 'reply2'), /not a completed message/)
  assert.throws(() => completedReply(events, 'other-session'), /not a completed message/)
})

test('selects inline and reference-style images but leaves code and ordinary links alone', () => {
  const markdown = '![Photo](<a b.png>)\n\n![Other][photo]\n\n[photo]: refs/image.png\n\n`![Code](hidden.png)`\n[Link](something.png)'
  assert.deepEqual(imageTargets(markdown), [
    { token: '![Photo](<a b.png>)', url: 'a b.png' },
    { token: '![Other][photo]', url: 'refs/image.png' },
  ])
})

test('selects an immutable conversation image and a bounded workspace image independently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-images-'))
  const workspace = path.join(root, 'workspace')
  const signal = new AbortController().signal
  try {
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'workspace.png'), Buffer.from('workspace'))
    await writeFile(path.join(root, 'other.png'), Buffer.from('other'))
    const store = {
      imageHostPath: () => path.join(root, 'attachment.png'),
      readImage: async () => ({ data: Buffer.from('stored') }),
    }
    const refs = [{ attachmentId: 'stored', mediaType: 'image/png', bytes: 6 }]
    const actual = await replyImages('![Stored](dsh-attachment:stored)\n![Workspace](workspace.png)', refs, store, workspace, 'session', signal)
    assert.deepEqual(actual.map(image => Buffer.from(image.bytes).toString()), ['stored', 'workspace'])
    await assert.rejects(replyImages('![](../other.png)', refs, store, workspace, 'session', signal), /Cannot read/)
    await assert.rejects(replyImages('![](https://example.com/remote.png)', refs, store, workspace, 'session', signal), /not an available/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('collects a Markdown bundle with relative media and detects tampering before serving it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-bundle-'))
  const signal = new AbortController().signal
  const staging = path.join(root, 'engine')
  const output = path.join(root, 'result')
  const source = '# First\n\nKeep image ![](images/file.png)\n\n# Second\n\nPick only this.'
  try {
    await mkdir(staging)
    await mkdir(output)
    await writeFile(path.join(staging, 'main.md'), source)
    await writeFile(path.join(staging, 'photo.png'), 'png')
    const artifacts = [
      { artifact_id: 'main', kind: 'document', locator: 'main.md', logical_path: 'main.md',
        media_type: MARKDOWN, size_bytes: Buffer.byteLength(source), sha256: hash(source) },
      { artifact_id: 'img', kind: 'resource', locator: 'photo.png', logical_path: 'images/file.png',
        media_type: 'image/png', size_bytes: 3, sha256: hash('png') },
    ]
    const bundle = {
      task_id: 'task', schema: 'docwen.artifact_bundle.v3', layout_schema: 'docwen.artifact_layout.v1',
      producer: { name: 'DocWen', machine_protocol: 'docwen.machine.v2' }, artifacts,
      entries: [{ artifact_id: 'main', role: 'primary', preferred: true }],
      relations: [{ type: 'resource_of', source_artifact_id: 'img', target_artifact_id: 'main' }],
    }
    const result = await collectBundle(bundle, 'task', staging, output, MARKDOWN, signal)
    assert.equal(result.primary, 'main')
    const bytes = await readResultFile(output, result.files[0], signal)
    assert.deepEqual(sections(bytes.toString()).map(section => section.title), ['First', 'Second'])
    assert.equal(sections(bytes.toString())[1].markdown, '# Second\n\nPick only this.')
    await writeFile(path.join(output, 'images', 'file.png'), 'bad')
    await assert.rejects(readResultFile(output, result.files[1], signal), /changed/)
    assert.throws(() => portablePath('a/../main.md'))
    assert.throws(() => portablePath('nul.png'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancels the accepted task and waits for the process range before returning', async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const controller = new AbortController()
  const calls: string[] = []
  let exited = false
  let waited = false
  const done = new Promise<{ exitCode: number }>(resolve => {
    stdin.once('end', () => { stdout.end(); exited = true; resolve({ exitCode: 0 }) })
  })
  const send = (fields: Record<string, unknown>) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...fields })
    stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  stdin.on('data', (buffer: Buffer) => {
    const request = JSON.parse(buffer.toString().split('\r\n\r\n')[1])
    calls.push(request.method)
    const reply = (result: unknown) => send({ id: request.id, result })
    switch (request.method) {
      case 'initialize':
        reply({ protocol: { name: 'docwen.machine', major: 2, minor: 0 }, server: { name: 'DocWen' },
          artifact_bundle_schema: 'docwen.artifact_bundle.v3' })
        break
      case 'capability/list':
        reply({ capabilities: [{ capability_id: IMPORT, availability: 'available', options_schema: { properties: {} } }] })
        break
      case 'task/plan':
        reply({ plan_id: 'plan' })
        break
      case 'task/execute':
        reply({ task_id: 'task', state: 'accepted' })
        setImmediate(() => controller.abort(new Error('Cancelled by test')))
        break
      case 'task/cancel':
        assert.equal(request.params.task_id, 'task')
        reply({})
        send({ method: 'task/cancelled', params: { task_id: 'task', sequence: 1 } })
        break
      default:
        throw new Error('Unexpected Machine call')
    }
  })
  await assert.rejects(runMachine({
    stdin, stdout, done,
    terminate: () => { stdin.end() },
    waitForExit: async () => { await done; waited = true; return exited },
  }, IMPORT, [], 'stage', {}, controller.signal), /Cancelled by test/)
  assert.deepEqual(calls, ['initialize', 'capability/list', 'task/plan', 'task/execute', 'task/cancel'])
  assert.equal(waited, true)
})
