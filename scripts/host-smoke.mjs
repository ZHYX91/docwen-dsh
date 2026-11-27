import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { unzipSync, strFromU8 } from 'fflate'

const exec = promisify(execFile)
const project = fileURLToPath(new URL('..', import.meta.url))
const bluePng =
  'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAGCAIAAABvrngfAAAAFElEQVR4nGNkYPjPgAqYGDAANYUAca8BC7fe9+IAAAAASUVORK5CYII='
const docxMedia = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function twoPagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 600] /Resources << >> >>',
  ]
  let text = '%PDF-1.4\n'
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(text)
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = Buffer.byteLength(text)
  text += 'xref\n0 5\n0000000000 65535 f \n'
  for (const offset of offsets) text += String(offset).padStart(10, '0') + ' 00000 n \n'
  return Buffer.from(text + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

async function npmCli() {
  const candidates = [process.env.npm_execpath]
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (process.platform === 'win32') candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'))
    else candidates.push(path.join(directory, 'npm'))
  }
  for (const candidate of candidates.filter(Boolean)) {
    try {
      return await realpath(candidate)
    } catch {
      /* Continue searching PATH. */
    }
  }
  throw Error('An npm installation is required.')
}

async function pack(source, destination, npm) {
  const { stdout } = await exec(
    process.execPath,
    [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: source },
  )
  return path.join(destination, JSON.parse(stdout)[0].filename)
}

async function boot(bin, cwd, env) {
  const child = spawn(
    process.execPath,
    [bin, '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const closed = once(child, 'close')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(Error('DSH did not become ready.')), 90000)
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill()
    const force = setTimeout(() => child.kill('SIGKILL'), 3000)
    try {
      await closed
    } finally {
      clearTimeout(force)
    }
  }
  try {
    const entryUrl = await new Promise((resolve, reject) => {
      let output = ''
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      child.once('error', reject)
      child.once('exit', (code) => reject(Error('DSH exited before startup (' + code + ').')))
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (chunk) => {
          output = (output + chunk.toString()).slice(-16384)
          const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/\?[^\s\x1b]+/u)
          if (url) resolve(url[0])
        })
    })
    const login = await fetch(entryUrl, { redirect: 'manual' })
    assert.equal(login.status, 303, 'DSH local browser sign-in')
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    assert.ok(cookie)
    const origin = new URL(entryUrl).origin
    function request(route, init = {}) {
      const headers = new Headers(init.headers)
      headers.set('cookie', cookie)
      headers.set('origin', origin)
      headers.set('x-docwen-dsh', '1')
      return fetch(new URL(route, origin), {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(120000),
        redirect: 'manual',
      })
    }
    return { entryUrl, request, stop }
  } catch (error) {
    await stop()
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function checked(response) {
  if (!response.ok)
    throw Error(
      'HTTP ' +
        response.status +
        ' on ' +
        new URL(response.url).pathname +
        ': ' +
        (await response.text()).slice(0, 700),
    )
  return response
}

export async function withInstalledHost(options, callback) {
  const packageDir = options.packageDir ?? project
  const root = await mkdtemp(path.join(os.tmpdir(), 'docwen-host-'))
  const workspace = path.join(root, 'workspace')
  const sessionId = 'session-' + randomUUID()
  let host
  try {
    const binary = options.dshBin ?? process.env.DSH_BIN
    const docwen = options.docwen ?? process.env.DOCWEN_DSH_EXECUTABLE
    assert.ok(
      binary && docwen,
      'Set DSH_BIN to the installed DSH JS executable and DOCWEN_DSH_EXECUTABLE to DocWen.',
    )
    const bin = binary.endsWith('.cmd')
      ? path.resolve(path.dirname(binary), '../@deepseek-ai/dsh/lib/bin.js')
      : await realpath(binary)
    await access(docwen)
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'figure.png'), Buffer.from(bluePng, 'base64'))
    const npm = await npmCli()
    const tarball = options.tarball ?? (await pack(packageDir, root, npm))
    const fixture = await pack(path.join(packageDir, 'test/fixtures/session-history'), root, npm)
    const env = {
      ...process.env,
      DSH_HOME: path.join(root, 'home'),
      DOCWEN_SMOKE_SESSION: sessionId,
      DOCWEN_DSH_EXECUTABLE: path.resolve(docwen),
      DOCWEN_RUNTIME_ROOT: path.join(root, 'runtime'),
    }
    await exec(process.execPath, [bin, 'plugin', '--profile', 'web', 'add', tarball, fixture], {
      cwd: workspace,
      env,
      timeout: 180000,
    })
    host = await boot(bin, workspace, env)
    const { request, entryUrl } = host
    async function rpc(method, args) {
      const response = await checked(
        await request('/api/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
        }),
      )
      const { result } = await response.json()
      assert.ok(result.ok, method + ' failed: ' + JSON.stringify(result.error))
      return result.value
    }
    const session = await rpc('session/create', { request: { sessionId, cwd: workspace } })
    assert.equal(session.sessionId, sessionId)
    const { messageId } = await (
      await checked(await request('/api/docwen-smoke-seed', { method: 'POST' }))
    ).json()
    const uri = (action, fields = {}, upload = false) =>
      '/api/docwen-dsh' +
      (upload ? '/upload' : '') +
      '?' +
      new URLSearchParams({ action, sessionId, ...fields })
    const getJSON = async (action, fields) => (await checked(await request(uri(action, fields)))).json()
    const post = async (action, fields, body) =>
      (
        await checked(
          await request(uri(action, fields), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        )
      ).json()
    const catalog = await getJSON('catalog')
    assert.ok(catalog.capabilities.some((cap) => cap.capability_id === 'convert.markdown_source.to_docx'))
    const preview = await getJSON('preview', { messageId })
    assert.match(preview.markdown, /historic reply/u)
    assert.equal(preview.images.length, 2)
    const template =
      catalog.templates.find((it) => it.target === 'docx' && it.is_default === true) ??
      catalog.templates.find((it) => it.target === 'docx')
    assert.ok(template, 'Discover an installed DOCX template.')
    const result = await post(
      'run',
      {},
      { action: 'export', messageIds: [messageId], options: { template_name: template.id } },
    )
    const docx = new Uint8Array(
      await (await checked(await request(uri('file', { resultId: result.id })))).arrayBuffer(),
    )
    const archive = unzipSync(docx)
    assert.match(strFromU8(archive['word/document.xml']), /historic reply/u)
    assert.equal(
      Object.keys(archive).filter((p) => p.startsWith('word/media/')).length,
      2,
      'Distinct attachment and workspace images',
    )
    const docxPath = path.join(workspace, 'historic-reply.docx')
    await writeFile(docxPath, docx)
    await callback({
      entryUrl,
      request,
      rpc,
      root,
      workspace,
      sessionId,
      messageId,
      docxPath,
      exported: result,
      catalog,
      uri,
    })
  } finally {
    try {
      if (host) await host.stop()
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 })
    }
  }
}

async function cancelPendingUpload(request, uri) {
  const taskId = randomUUID()
  const transport = new AbortController()
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0x50, 0x4b]))
    },
  })
  const upload = request(uri('import', { filename: 'incomplete.docx', taskId }, true), {
    method: 'POST',
    headers: { 'content-type': docxMedia },
    body,
    duplex: 'half',
    signal: transport.signal,
  }).then(
    (response) => response.status,
    () => null,
  )
  async function waitActive(predicate) {
    const deadline = AbortSignal.timeout(15000)
    for (;;) {
      deadline.throwIfAborted()
      const active = await (await checked(await request(uri('active'), { signal: deadline }))).json()
      if (predicate(active)) return
      await delay(30, undefined, { signal: deadline })
    }
  }
  try {
    await waitActive((active) => active?.id === taskId)
    const cancelled = await (
      await checked(
        await request(uri('cancel'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ taskId }),
        }),
      )
    ).json()
    assert.equal(cancelled.ok, true)
    // The server must release the slot before the client closes the incomplete upload.
    await waitActive((active) => active === null)
    const results = await (await checked(await request(uri('list')))).json()
    assert.ok(results.every((result) => result.id !== taskId))
  } finally {
    transport.abort()
    assert.ok((await upload) !== 200)
  }
}

async function verifyHost({
  request,
  rpc,
  sessionId,
  messageId,
  workspace,
  docxPath,
  uri,
  exported,
  catalog,
}) {
  const docx = await readFile(docxPath)
  const imported = await (
    await checked(
      await request(uri('import', { filename: 'historic-reply.docx' }, true), {
        method: 'POST',
        headers: { 'content-type': docxMedia },
        body: docx,
      }),
    )
  ).json()
  assert.ok(imported.files.filter((file) => file.media.startsWith('image/')).length === 2)
  const url = (action, fields = {}) => uri(action, { resultId: imported.id, ...fields })
  const sections = await (await checked(await request(url('sections')))).json()
  assert.ok(sections.some((section) => section.markdown.includes('second section')))
  const group = unzipSync(new Uint8Array(await (await checked(await request(url('archive')))).arrayBuffer()))
  for (const file of imported.files) assert.ok(Object.hasOwn(group, file.path))
  const markdown = strFromU8(group[imported.files.find((it) => it.id === imported.primary).path])
  for (const image of imported.files.filter((it) => it.media.startsWith('image/')))
    assert.ok(markdown.includes(path.posix.basename(image.path)))
  const reopened = await (await checked(await request(uri('list')))).json()
  assert.ok(reopened.some((item) => item.id === imported.id))
  assert.ok(reopened.some((item) => item.id === exported.id))
  const proofread = catalog.capabilities.find((cap) => cap.capability_id === 'validate.docx')
  if (proofread && ['available', 'limited'].includes(proofread.availability)) {
    const source = { kind: 'workspace', path: path.basename(docxPath) }
    const intent = {
      action: 'process',
      capabilityId: 'validate.docx',
      sources: [source],
      options: { enable_symbol_pairing: true },
    }
    const proof = await (
      await checked(
        await request(uri('run'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(intent),
        }),
      )
    ).json()
    assert.equal(proof.files.length, 1)
    assert.equal(proof.files[0].media, docxMedia)
    const copy = unzipSync(
      new Uint8Array(await (await checked(await request(uri('file', { resultId: proof.id })))).arrayBuffer()),
    )
    assert.match(strFromU8(copy['word/document.xml']), /historic reply/u)
    assert.deepEqual(await readFile(docxPath), docx)
    console.log('Discovered validate.docx returned one DOCX copy and preserved the workspace source.')
  } else {
    console.log('This Core does not advertise runnable validate.docx.')
  }
  const command = await rpc('commands/execute', {
    agentId: sessionId,
    line: '/docwen results',
    submittedAttachments: [],
  })
  assert.equal(command.result.kind, 'success', command.result.text)
  assert.ok(JSON.parse(command.result.text).results.some((item) => item.id === imported.id))
  const fork = await rpc('session/fork', { request: { sessionId } })
  assert.notEqual(fork.sessionId, sessionId)
  const forkPreview = await (
    await checked(await request(uri('preview', { sessionId: fork.sessionId, messageId })))
  ).json()
  assert.match(forkPreview.markdown, /historic reply/u)
  await cancelPendingUpload(request, uri)
  const other = await rpc('session/create', { request: { cwd: workspace } })
  assert.notEqual(other.sessionId, sessionId)
  assert.equal(
    (await request(uri('file', { sessionId: other.sessionId, resultId: imported.id }))).status,
    404,
  )
  const tool = await (await checked(await request('/api/docwen-smoke-tool', { method: 'POST' }))).json()
  assert.deepEqual(tool, { successful: true, deliveries: [{ turn: 2, count: 1 }] })
  console.log('The installed DSH tool executor presented one native deliverable in an open turn.')
  const inputPdf = twoPagePdf()
  const inputPdfPath = path.join(workspace, 'two-pages.pdf')
  await writeFile(inputPdfPath, inputPdf)
  const split = await (await checked(await request('/api/docwen-smoke-tool?case=split', { method: 'POST' }))).json()
  assert.equal(split.successful, true)
  assert.equal(split.deliveries.length, 1)
  const [delivery] = split.deliveries
  assert.equal(delivery.turn, 3)
  assert.equal(delivery.count, 2)
  const results = await (await checked(await request(uri('list')))).json()
  const splitResult = results.find((item) => item.files.length === 2 && item.files.every((file) => file.media === 'application/pdf'))
  assert.ok(splitResult, 'the complete split remains in Saved Results')
  const splitFiles = splitResult.entries.map((entry) => splitResult.files.find((file) => file.id === entry.artifact_id))
  const expected = []
  for (const file of splitFiles) {
    const download = await checked(await request(uri('file', { resultId: splitResult.id, artifactId: file.id })))
    const bytes = Buffer.from(await download.arrayBuffer())
    assert.equal(bytes.subarray(0, 5).toString(), '%PDF-')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256)
    expected.push({ name: path.posix.basename(file.path), sha256: file.sha256 })
  }
  assert.notEqual(expected[0].sha256, expected[1].sha256)
  assert.deepEqual(delivery.files, expected)
  assert.deepEqual(await readFile(inputPdfPath), inputPdf)
  console.log('One native DSH delivery contains both verified Core PDF parts, in producer order.')
  console.log(
    'Real DSH profile, completed reply, two image sources, templated DOCX, Markdown group, sections, slash command, forked history, upload cancellation and session isolation passed.',
  )
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await withInstalledHost({}, verifyHost)
}
