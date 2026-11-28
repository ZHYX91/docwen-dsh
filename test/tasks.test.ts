import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { collectBundle, hash } from '../src/documents.js'
import peerSplit from './fixtures/artifact-bundle.pdf-split.json' with { type: 'json' }
import { bindImagePaths, layoutPlan, MIXED, PDF, withLayoutMerge } from '../src/inputs.js'
import { ResultStore } from '../src/result-store.js'
import { DocumentTasks, type TaskPorts } from '../src/tasks.js'
import { receiveUploads } from '../src/uploads.js'

const OFD = 'application/vnd.ofd',
  XPS = 'application/vnd.ms-xpsdocument'
const slot = (m: string[], many = false) => ({
  role: 'source',
  kind: 'resource',
  media_types: m,
  min_items: many ? 2 : 1,
  ...(many ? {} : { max_items: 1 }),
})
const cap = (id: string, sources: string[], many = false) => ({
  capability_id: id,
  operation: many ? 'merge' : 'convert',
  input_shape: { slots: [slot(sources, many)] },
  availability: 'available',
  output_media_types: [PDF],
  output_shape: { cardinality: 'one', artifact_kinds: ['document'] },
  options_schema: { type: 'object', properties: {}, required: [] },
})
const merge = cap('merge.pdf.documents', [PDF], true),
  convert = cap('convert.ofd.to_pdf', [OFD])

test('discovers only real layout routes and prefers direct mixed merging', () => {
  assert.throws(() => layoutPlan([merge], [OFD, PDF]), /no Machine conversion/)
  assert.equal(withLayoutMerge({ capabilities: [merge] }).capabilities.length, 1)
  const catalog = withLayoutMerge({ capabilities: [merge, convert] })
  assert.equal(catalog.capabilities.at(-1)?.capability_id, MIXED)
  assert.throws(() => layoutPlan([merge, convert], [PDF, XPS]), /no Machine conversion/)
  const direct = cap('merge.layout.documents', [OFD, PDF], true)
  assert.deepEqual(layoutPlan([merge, convert, direct], [OFD, PDF]), {
    merge: direct,
    converters: [undefined, undefined],
  })
  assert.deepEqual(layoutPlan([merge, convert], [PDF, OFD, PDF]).converters, [undefined, convert, undefined])
})

test('binds referenced images without rewriting code, ordinary links or visible alt text', () => {
  const md = '![Photo][p]\n\n[p]: a.png\n\n`![Photo][p]`\n\n[Photo][p]'
  const actual = bindImagePaths(md, new Map([['![Photo][p]', 'images/a.png']]))
  assert.equal(actual.markdown, md.replace('![Photo][p]', '![Photo](images/a.png)'))
  assert.deepEqual(actual.images, [
    { authored_token: '![Photo](images/a.png)', logical_path: 'images/a.png' },
  ])
})

/** Simulate a future OFD adapter at the byte-framed Machine boundary. Actual PDF execution is
 * verified separately against Core; this fixture exercises deterministic failure/cancellation. */
function harness(root: string, mode: 'ok' | 'fail' | 'cancel' | 'awaiting-exit') {
  const planned: string[] = []
  let cancel = () => {}
  let exitConfirmed = mode !== 'awaiting-exit'
  const process = () => {
    const stdin = new PassThrough(),
      stdout = new PassThrough()
    const done = new Promise<{ exitCode: number }>((resolve) =>
      stdin.on('end', () => {
        stdout.end()
        resolve({ exitCode: 0 })
      }),
    )
    let task: {
      capability_id: string
      inputs: { locator: { path: string } }[]
      output: { staging_root: { path: string } }
    }
    const send = (frame: object) => {
      const body = JSON.stringify({ jsonrpc: '2.0', ...frame })
      stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }
    stdin.on('data', (chunk: Buffer) => {
      const r = JSON.parse(chunk.toString().split('\r\n\r\n')[1]),
        reply = (result: object) => send({ id: r.id, result })
      switch (r.method) {
        case 'initialize':
          return reply({
            server: { name: 'DocWen' },
            protocol: { name: 'docwen.machine', major: 2, minor: 0 },
            artifact_bundle_schema: 'docwen.artifact_bundle.v3',
          })
        case 'capability/list':
          return reply({ capabilities: [merge, convert] })
        case 'resource/list':
          return reply({ resources: [] })
        case 'task/plan':
          task = r.params
          planned.push(task.capability_id)
          return reply({ plan_id: 'p' })
        case 'task/cancel':
          return reply({})
        case 'task/execute': {
          reply({ state: 'accepted', task_id: 't' })
          const base = { task_id: 't', sequence: 1 }
          if (task.capability_id === convert.capability_id) {
            if (mode === 'fail')
              return send({
                method: 'task/failed',
                params: { ...base, error: { message: 'OFD conversion failed' } },
              })
            if (mode === 'cancel') {
              setImmediate(() => cancel())
              return
            }
          }
          const data = Buffer.concat(task.inputs.map((i) => readFileSync(i.locator.path)))
          writeFileSync(path.join(task.output.staging_root.path, 'document.pdf'), data)
          return send({
            method: 'task/completed',
            params: {
              ...base,
              diagnostics: [],
              bundle: {
                schema: 'docwen.artifact_bundle.v3',
                layout_schema: 'docwen.artifact_layout.v1',
                task_id: 't',
                bundle_id: 'bundle.t',
                producer: {
                  name: 'DocWen',
                  machine_protocol: 'docwen.machine.v2',
                  product_version: '0.23.2',
                },
                files: [],
                artifacts: [
                  {
                    artifact_id: 'out',
                    kind: 'document',
                    suggested_name: 'document.pdf',
                    logical_path: 'document.pdf',
                    locator: 'document.pdf',
                    size_bytes: data.length,
                    sha256: hash(data),
                    media_type: PDF,
                  },
                ],
                entries: [{ artifact_id: 'out', preferred: true, ordinal: 0, role: 'primary' }],
                relations: [],
              },
            },
          })
        }
        default:
          throw new Error('Unexpected request ' + r.method)
      }
    })
    return {
      stdin,
      stdout,
      done,
      terminate() {
        stdin.end()
      },
      async waitForExit() {
        await done
        return exitConfirmed
      },
    }
  }
  const ports: TaskPorts = {
    workspaceFiles: {
      scopeOf: async (sessionId) => ({ sessionId, workspaceRoot: root }),
      stat: async () => {
        throw Error()
      },
      readBytes: async () => {
        throw Error()
      },
    },
    sessionQuery: { readSession: async () => ({ events: [] }) },
    attachments: {
      readFileStream() {
        throw Error()
      },
      readImage() {
        throw Error()
      },
      imageHostPath: () => undefined,
    },
    subprocess: { resolveExecutable: async () => '/docwen', spawn: process },
  }
  const service = new DocumentTasks(ports, new ResultStore(root), 'docwen')
  cancel = () => service.closeSession('s')
  return { service, planned, confirmExit: () => { exitConfirmed = true } }
}

test('streams multipart files into the task directory under server-assigned paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-upload-'))
  const signal = new AbortController().signal
  const form = new FormData()
  form.set('file0', new File(['document'], '会议纪要.docx'))
  form.set('intent', '{"action":"process"}')
  const request = new Request('http://test/upload', { method: 'POST', body: form })
  try {
    const received = await receiveUploads(request, request.headers.get('content-type')!, root, signal)
    assert.equal(received.intent, '{"action":"process"}')
    assert.deepEqual(received.uploads.get('file0'), { name: '会议纪要.docx', path: path.join(root, 'file0'), size: 8 })
    assert.equal(await readFile(path.join(root, 'file0'), 'utf8'), 'document')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('paginates result metadata without duplicating entries after a newer publication', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-pages-'))
  const store = new ResultStore(root)
  const signal = new AbortController().signal
  const timestamp = Date.now()
  const add = async (i: number) => {
    const id = randomUUID()
    const folder = path.join(await store.root('s', true), id)
    await mkdir(path.join(folder, 'files'), { recursive: true })
    await writeFile(path.join(folder, 'result.json'), '{')
    await utimes(folder, new Date(timestamp + i * 1000), new Date(timestamp + i * 1000))
    return id
  }
  try {
    const ids = []
    for (let index = 0; index < 26; index++) ids.push(await add(index))
    const first = await store.list('s', signal)
    assert.deepEqual(first.results.map(result => result.id), ids.slice(2).reverse())
    assert.ok(first.next)
    const nextId = await add(26)
    const older = await store.list('s', signal, first.next)
    assert.deepEqual(older.results.map(result => result.id), ids.slice(0, 2).reverse())
    assert.equal(older.next, undefined)
    assert.equal((await store.list('s', signal)).results[0].id, nextId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('holds a session until the original Core process is confirmed stopped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-exit-'))
  const { service, confirmExit } = harness(root, 'awaiting-exit')
  const { routeHandler } = await import('../src/host.js')
  const dispatch = routeHandler(service)
  const taskId = randomUUID()
  const run = () => dispatch(new Request(`http://test/api/docwen-dsh?sessionId=s&action=run&taskId=${taskId}`, {
    method: 'POST', headers: { 'x-docwen-dsh': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'process', capabilityId: merge.capability_id }),
  }))
  try {
    const first = await run()
    assert.equal(first.status, 409)
    assert.equal((await first.json()).code, 'process_exit_unconfirmed')
    assert.deepEqual(await service.active('s'), { id: taskId, phase: 'awaiting_exit' })
    assert.equal((await run()).status, 409)
    confirmExit()
    assert.equal(await service.active('s'), null)
    assert.equal((await run()).status, 422)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

for (const mode of ['ok', 'fail', 'cancel'] as const)
  test('mixed layout task: ' + mode, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-layout-'))
    const { service, planned } = harness(root, mode),
      signal = new AbortController().signal,
      id = randomUUID()
    try {
      const files = ['z.pdf', 'b.ofd', 'a.pdf'].map(
        (name, i) => new File([String.fromCharCode(90 - i)], name),
      )
      const input = {
        intent: {
          action: 'process',
          capabilityId: MIXED,
          sources: files.map((_, i) => ({ kind: 'upload', field: String(i) })),
          options: {},
        },
        uploads: new Map(files.map((f, i) => [String(i), f])),
      }
      const result = service.submit('s', id, signal, async () => input)
      await assert.rejects(
        service.submit('s', randomUUID(), signal, async () => input),
        /already has a running/,
      )
      assert.equal(service.cancel('another-session', id), false)
      if (mode === 'ok') {
        const group = await result
        assert.equal(group.id, id)
        assert.deepEqual(planned, [convert.capability_id, merge.capability_id])
        assert.deepEqual(
          group.files.map((f) => f.path),
          ['document.pdf'],
        )
        assert.equal((await service.store.read('s', id, group.primary, signal)).bytes.toString(), 'ZYX')
        await assert.rejects(
          service.submit('s', id, signal, async () => input),
          /already has a saved/,
        )
        assert.deepEqual(await service.list('other', signal), { results: [] })
        assert.deepEqual(await readdir(await service.store.root('s')), [id])
        const bad = randomUUID(),
          badDir = path.join(await service.store.root('s'), bad)
        await mkdir(badDir)
        await writeFile(path.join(badDir, 'result.json'), '{')
        const { results: reopened } = await service.list('s', signal)
        assert.deepEqual(
          new Set(reopened.map((g) => g.id)),
          new Set([id, bad]),
        )
        await service.store.remove('s', bad)
        await service.store.remove('s', id)
      } else {
        await assert.rejects(result, mode === 'fail' ? /OFD conversion failed/ : /conversation was closed/)
        assert.deepEqual(planned, [convert.capability_id])
      }
      assert.deepEqual(await readdir(await service.store.root('s')), [])
      assert.equal(await service.active('s'), null)
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

test('archives verified members under their original relative names, with no successful partial ZIP', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-archive-'))
  const { service } = harness(root, 'ok')
  try {
    const { unzipSync } = await import('fflate')
    const { routeHandler } = await import('../src/host.js')
    const dispatch = routeHandler(service)
    const id = randomUUID(), staged = await service.store.staging('s')
    const md = Buffer.from('![synthetic](assets/图.png)\n')
    const image = Buffer.from('synthetic asset bytes')
    const members = [
      { id: 'note', path: 'note.md', media: 'text/markdown', data: md },
      { id: 'image', path: 'assets/图.png', media: 'image/png', data: image },
    ]
    const files = path.join(staged, 'files')
    await mkdir(path.join(files, 'assets'), { recursive: true })
    for (const member of members) await writeFile(path.join(files, member.path), member.data)
    await service.store.publish('s', staged, {
      id, label: 'Synthetic archive', primary: 'note', created: new Date().toISOString(), warnings: [],
      files: members.map(({ data, ...member }) => ({ ...member, bytes: data.length, sha256: hash(data) })),
    }, new AbortController().signal)
    const endpoint = 'http://dsh.internal/api/docwen-dsh?sessionId=s&action=archive&resultId=' + id
    const response = await dispatch(new Request(endpoint))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/zip')
    const zip = new Uint8Array(await response.arrayBuffer())
    assert.equal(response.headers.get('Content-Length'), String(zip.length))
    const entries = unzipSync(zip)
    assert.deepEqual(Object.keys(entries), members.map(m => m.path))
    for (const m of members) assert.deepEqual(Buffer.from(entries[m.path]), m.data)
    const openDownload = await dispatch(new Request(endpoint))
    const reader = openDownload.body!.getReader()
    assert.equal((await reader.read()).done, false)
    await reader.cancel()
    const published = await service.store.get('s', id)
    await writeFile(path.join(published.files, members[1].path), Buffer.alloc(image.length))
    const corrupt = await dispatch(new Request(endpoint))
    assert.equal(corrupt.status, 422)
    assert.match((await corrupt.json()).error, /changed|incomplete/)
    const controller = new AbortController()
    controller.abort()
    assert.equal((await dispatch(new Request(endpoint, { signal: controller.signal }))).status, 499)
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('handles the DSH web bridge origin and requires an explicit same-host mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-bridge-'))
  const { service } = harness(root, 'ok')
  try {
    const { routeHandler } = await import('../src/host.js')
    const dispatch = routeHandler(service)
    const request = (origin: string, marker = '1') =>
      new Request('http://dsh.internal/api/docwen-dsh?sessionId=s&action=cancel', {
        method: 'POST',
        headers: { host: '127.0.0.1:4180', origin, 'x-docwen-dsh': marker },
        body: JSON.stringify({ taskId: randomUUID() }),
      })
    const accepted = await dispatch(request('http://127.0.0.1:4180'))
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), { ok: false })
    assert.equal((await dispatch(request('http://localhost:4190'))).status, 403)
    assert.equal((await dispatch(request('http://127.0.0.1:4180', ''))).status, 403)
  } finally {
    await service.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

for (const preferred of [false, true]) {
  test(`native delivery includes ordered PDF peers (preferred second: ${preferred})`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-peer-delivery-'))
    const { service } = harness(root, 'ok')
    const signal = new AbortController().signal
    try {
      const staging = await service.store.staging('s')
      const outputs = path.join(staging, 'files')
      const producer = path.join(root, 'producer')
      await Promise.all([mkdir(outputs), mkdir(path.join(producer, 'parts'), { recursive: true })])
      const ids = peerSplit.entries.map(entry => entry.artifact_id)
      const expected = peerSplit.entries.map((_, index) => Buffer.from(`%PDF-1.7
% section ${index + 1}
`))
      const artifacts = await Promise.all(peerSplit.artifacts.map(async (item, index) => {
        await writeFile(path.join(producer, item.locator), expected[index])
        return { ...item, size_bytes: expected[index].length, sha256: hash(expected[index]) }
      }))
      const bundle = {
        ...peerSplit, artifacts: artifacts.reverse(),
        entries: peerSplit.entries.map((entry, index) => ({ ...entry, preferred: preferred && index === 1 })).reverse(),
      }
      const collection = await collectBundle(bundle, bundle.task_id, producer, outputs, undefined, signal)
      assert.equal(collection.primary, ids[preferred ? 1 : 0])
      const result = { ...collection, id: randomUUID(), label: 'Split PDF', created: new Date().toISOString(), warnings: [] }
      await service.store.publish('s', staging, result, signal)
      const files = await service.delivery('s', result.id, signal)
      assert.deepEqual(files.map(f => path.basename(f.path)), ['part-001.pdf', 'part-002.pdf'])
      assert.deepEqual(await Promise.all(files.map(f => readFile(f.path))), expected)
      assert.deepEqual(await Promise.all(peerSplit.artifacts.map(f => readFile(path.join(producer, f.locator)))), expected)

      await writeFile(files[1].path, 'Invalid second file')
      await assert.rejects(service.delivery('s', result.id, signal), /changed|integrity/i)
      assert.equal((await service.store.get('s', result.id)).result.files.length, 2)
    } finally {
      await service.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
}
