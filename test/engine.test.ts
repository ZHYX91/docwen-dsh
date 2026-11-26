import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import { collectBundle, hash, readResult, snapshot } from '../src/documents.js'
import { discoverMachine, runMachine, type ManagedProcess } from '../src/machine.js'

type Json = Record<string, unknown>
const signal = new AbortController().signal

function peer(reply: (request: Json, send: (message: Json) => void) => void): ManagedProcess {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const done = new Promise<{ exitCode: number }>(resolve => {
    stdin.once('end', () => { stdout.end(); resolve({ exitCode: 0 }) })
  })
  const send = (message: Json) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }))
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`)
    // Header and payload independently cross transport boundaries.
    for (const piece of [header.subarray(0, 3), header.subarray(3), body.subarray(0, 7), body.subarray(7)]) stdout.write(piece)
  }
  stdin.on('data', (chunk: Buffer) => {
    const request = JSON.parse(chunk.subarray(chunk.indexOf('\r\n\r\n') + 4).toString())
    if (request.method === 'initialize') {
      return send({ id: request.id, result: { protocol: { name: 'docwen.machine', major: 2, minor: 0 },
        server: { name: 'DocWen' }, artifact_bundle_schema: 'docwen.artifact_bundle.v3' } })
    }
    reply(request, send)
  })
  return { stdin, stdout, done, terminate: () => { stdin.end() }, waitForExit: async () => { await done; return true } }
}

test('discovers all resource catalogs through a negotiated session', async () => {
  const seen: string[] = []
  const catalog = await discoverMachine(peer(({ id, method, params }, send) => {
    if (method === 'capability/list') return send({ id, result: { capabilities: [{ capability_id: 'validate.docx' }] } })
    assert.equal(method, 'resource/list')
    const { kind } = params as { kind: string }
    seen.push(kind)
    send({ id, result: { kind, resources: [{ id: kind }] } })
  }), signal)
  assert.deepEqual(seen, ['templates', 'numbering-schemes', 'optimizations'])
  assert.deepEqual(catalog, { capabilities: [{ capability_id: 'validate.docx' }], templates: [{ id: 'templates' }],
    numberingSchemes: [{ id: 'numbering-schemes' }], optimizations: [{ id: 'optimizations' }] })
})

test('runs a discovered limited capability and preserves input order, public options and progress', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'docwen-snap-'))
  try {
    const pdfs = await Promise.all(['z.pdf', 'a.pdf'].map(name => snapshot(tmp, Buffer.from(name), name, 'application/pdf', 'source', 'resource')))
    const progress: number[] = []
    const seen: string[] = []
    const id = 'merge.pdf.documents'
    const terminal = await runMachine(peer((request, send) => {
      const method = request.method as string
      seen.push(method)
      const respond = (result: Json) => send({ id: request.id, result })
      if (method === 'capability/list') return respond({ capabilities: [{ capability_id: id, availability: 'limited', options_schema: { properties: {} } }] })
      if (method === 'task/plan') {
        const params = request.params as Json
        assert.deepEqual(params.inputs, pdfs)
        assert.deepEqual(pdfs.map(f => [f.logical_path, f.kind]), [['z.pdf', 'resource'], ['a.pdf', 'resource']])
        assert.deepEqual(params.options, {})
        return respond({ plan_id: 'plan.1' })
      }
      assert.equal(method, 'task/execute')
      respond({ state: 'accepted', task_id: 'task.1' })
      send({ method: 'task/progress', params: { task_id: 'task.1', sequence: 1, completed: 37, total: 100 } })
      send({ method: 'task/completed', params: { task_id: 'task.1', sequence: 2, bundle: {}, diagnostics: [] } })
    }), id, pdfs, tmp, {}, signal, p => progress.push(p))
    assert.equal(terminal.taskId, 'task.1')
    assert.deepEqual(seen, ['capability/list', 'task/plan', 'task/execute'])
    assert.deepEqual(progress, [37])
  } finally { await rm(tmp, { recursive: true, force: true }) }
})

test('does not dispatch a capability that became unavailable after earlier discovery', async () => {
  const ids: unknown[] = []
  await assert.rejects(runMachine(peer(({ id, method }, send) => {
    ids.push(method)
    send({ id, result: { capabilities: [{ capability_id: 'validate.docx', availability: 'unavailable' }] } })
  }), 'validate.docx', [], 'staging', {}, signal), /cannot run validate.docx/)
  assert.deepEqual(ids, ['capability/list'])
})

test('preserves every ordered resource entry, physical-page relation and nested file even without a preferred entry', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'docwen-graph-'))
  try {
    const staging = path.join(tmp, 'engine')
    const output = path.join(tmp, 'files')
    await Promise.all([mkdir(staging), mkdir(output)])
    const contents = [['z', 'z.md', 'document', 'text/markdown'], ['a', 'pages/1.md', 'fragment', 'text/markdown'],
      ['i', 'pages/media/1.png', 'resource', 'image/png'], ['table', 'tables/2.csv', 'resource', 'text/csv']]
    const artifacts = await Promise.all(contents.map(async ([id, name, kind, media]) => {
      const payload = Buffer.from(name)
      await writeFile(path.join(staging, id), payload)
      return { artifact_id: id, logical_path: name, suggested_name: path.basename(name), locator: id,
        size_bytes: payload.length, sha256: hash(payload), kind, media_type: media }
    }))
    const entries = [{ artifact_id: 'table', role: 'worksheet', ordinal: 1, preferred: false },
      { artifact_id: 'z', role: 'primary', ordinal: 0, preferred: false }]
    const page = { fragment_kind: 'page', page_index: 1, page_count: 1, source_page: 1, ocr_status: 'success' }
    const relations = [
      { type: 'fragment_of', role: 'ocr_page', source_artifact_id: 'a', target_artifact_id: 'z', ordinal: 0, page_fragment: page },
      { type: 'resource_of', role: 'image', source_artifact_id: 'i', target_artifact_id: 'a', page_resource: { source_page: 1 } },
    ]
    const bundle = { bundle_id: 'bundle.1', task_id: 'task.1', schema: 'docwen.artifact_bundle.v3',
      layout_schema: 'docwen.artifact_layout.v1', producer: { name: 'DocWen', product_version: 'v', machine_protocol: 'docwen.machine.v2' },
      artifacts, entries, relations }
    await assert.rejects(collectBundle({ ...bundle, entries: entries.map(e => ({ ...e, preferred: true })) }, 'task.1', staging, output, undefined, signal), /preference/)
    assert.deepEqual(await readdir(output), [])
    await assert.rejects(collectBundle({ ...bundle, relations: [] }, 'task.1', staging, output, undefined, signal), /disconnected/)
    const collected = await collectBundle(bundle, 'task.1', staging, output, undefined, signal)
    assert.equal(collected.primary, 'z')
    assert.deepEqual(collected.entries.map(e => e.artifact_id), ['z', 'table'])
    assert.deepEqual(collected.relations, relations)
    for (const file of collected.files) assert.equal(await readFile(path.join(output, file.path), 'utf8'), file.path)
    const metadata = path.join(tmp, 'result.json')
    const saved = { ...collected, id: 'de200000-0000-4000-8000-000000000000', label: 'Review', warnings: [], created: new Date().toISOString() }
    await writeFile(metadata, JSON.stringify(saved))
    assert.deepEqual(await readResult(metadata), saved)
    const legacy = { id: saved.id, label: saved.label, warnings: [], created: saved.created, primary: 'z',
      files: [{ id: 'z', path: 'z.md', media: 'text/markdown', sha256: artifacts[0].sha256, bytes: 4 }] }
    await writeFile(metadata, JSON.stringify(legacy))
    assert.deepEqual(await readResult(metadata), legacy)
    await writeFile(metadata, JSON.stringify({ ...legacy, files: [{ ...legacy.files[0], path: '../outside' }] }))
    await assert.rejects(readResult(metadata), /nonportable/)
  } finally { await rm(tmp, { recursive: true, force: true }) }
})
