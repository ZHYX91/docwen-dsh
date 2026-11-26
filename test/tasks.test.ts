import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { hash } from '../src/documents.js'
import { bindImagePaths, layoutPlan, MIXED, PDF, withLayoutMerge } from '../src/inputs.js'
import { ResultStore } from '../src/result-store.js'
import { DocumentTasks, type TaskPorts } from '../src/tasks.js'

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
function harness(root: string, mode: 'ok' | 'fail' | 'cancel') {
  const planned: string[] = []
  let cancel = () => {}
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
        return true
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
  return { service, planned }
}

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
        assert.deepEqual(await service.list('other', signal), [])
        assert.deepEqual(await readdir(await service.store.root('s')), [id])
        const bad = randomUUID(),
          badDir = path.join(await service.store.root('s'), bad)
        await mkdir(badDir)
        await writeFile(path.join(badDir, 'result.json'), '{')
        const reopened = await service.list('s', signal)
        assert.deepEqual(
          reopened.map((g) => g.id),
          [id, bad],
        )
        await service.store.remove('s', bad)
        await service.store.remove('s', id)
      } else {
        await assert.rejects(result, mode === 'fail' ? /OFD conversion failed/ : /conversation was closed/)
        assert.deepEqual(planned, [convert.capability_id])
      }
      assert.deepEqual(await readdir(await service.store.root('s')), [])
      assert.equal(service.active('s'), null)
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
