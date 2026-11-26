import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { compatible, fileMedia, jobsFor, shifted, wireIntent, workbenchOptions, type Capability, type Item, type Job } from '../src/client-model.js'
import { SessionBinding } from '../src/client-session.js'

const item = (name: string): Item => ({ key: name, label: name, media: fileMedia(name), source: { kind: 'workspace', path: name } })
const pdf = { role:'source', min_items:1, max_items:1, media_types:['application/pdf'] }
function capability(id: string, slots: Capability['input_shape']['slots']): Capability {
  return { capability_id:id, availability:'available', operation:'convert', input_shape:{ slots }, output_media_types:[], options_schema:{} }
}
test('one source per plan batches independently; many-source plans preserve user order in one task', () => {
  const sources = [item('2.pdf'), item('1.pdf'), item('3.pdf')]
  const caps = capability('split.pdf.every_page',[pdf])
  assert.deepEqual(jobsFor(caps,sources,{}).map(j => j.label), ['2.pdf','1.pdf','3.pdf'])
  const merged = capability('merge.pdf.documents',[{role:'source', min_items:2, media_types:pdf.media_types}])
  assert.deepEqual(jobsFor(merged,[sources[0]],{}),[])
  const ordered = shifted(sources, 2, -1)
  const [job] = jobsFor(merged,ordered,{})
  assert.deepEqual(JSON.parse(String(wireIntent(job.intent).body)).sources.map((s: { path:string }) => s.path),['2.pdf','3.pdf','1.pdf'])
  assert.deepEqual(sources.map(i=>i.label),['2.pdf','1.pdf','3.pdf'])
})
test('selection honours availability, source roles, and required non-source slots', () => {
  const cap = capability('convert', [pdf])
  assert.ok(!compatible(cap,[item('not.docx')]))
  assert.ok(!compatible({...cap, availability:'unavailable'},[item('yes.pdf')]))
  assert.ok(compatible({...cap, availability:'limited'},[item('yes.pdf')]))
  assert.ok(!compatible(capability('resolved',[pdf,{ ...pdf, role:'resolved',min_items:1 }]),[item('yes.pdf')]))
})
test('Markdown plus individually picked images is a single job with explicit roles, including mixed uploads', async () => {
  const cap = capability('convert.markdown_source.to_docx',[
    { ...pdf, media_types:['text/markdown'] }, {role:'linked_resource',min_items:0,media_types:['image/png']},
  ])
  const source = item('original.md')
  const photo: Item = {...item('local.png'),source:{ kind:'upload', file:new File(['PNG'], 'local.png',{type:'image/png'}) }}
  const other = item('assets/remote.png')
  const [job] = jobsFor(cap,[photo, source, other],{proofread:{}})
  const encoded = wireIntent(job.intent)
  assert.ok(encoded.multipart && encoded.body instanceof FormData)
  assert.deepEqual(JSON.parse(String(encoded.body.get('intent'))).sources,[
    {kind:'upload',field:'file0',role:'linked_resource'}, {kind:'workspace',path:'original.md',role:'source'},
    {kind:'workspace',path:'assets/remote.png',role:'linked_resource'},
  ])
  assert.equal(await (encoded.body.get('file0') as File).text(), 'PNG')
  assert.deepEqual(jobsFor(cap,[source,item('second.md'),photo],{}),[])
})
function delayed<T>() {
  let resolve!: (value:T) => void
  const promise = new Promise<T>(res => {resolve=res})
  return {promise,resolve}
}
function result(id:string) { return {id, label:id, primary:'main', created:'2026-01-01', files:[], warnings:[]} }
const exportJob = (id:string): Job => ({status:'queued',label:id,intent:{action:'export',messageIds:[id],options:{}}})
test('retry sends only failed rows, keeps successful files and preserves chronological results', async t => {
  const calls: string[] = []
  t.mock.method(globalThis,'fetch',async (_url:string,init: RequestInit) => {
    const id = JSON.parse(String(init.body)).messageIds[0]
    calls.push(id)
    if (id === 'one' && calls.length === 1) return Response.json({error:'failed'},{status:500})
    return Response.json(result(id))
  })
  const binding = new SessionBinding('session')
  await binding.submit([exportJob('one'),exportJob('two')])
  assert.deepEqual(binding.snapshot().jobs.map(j=>j.status),['failed','done'])
  await binding.submit(binding.snapshot().jobs,true)
  assert.deepEqual(calls,['one','two','one'])
  assert.deepEqual(binding.snapshot().results.map(r=>r.id),['one','two'])
})
test('cancelling uses the running session task ID and prevents every undispatched row', async t => {
  const running = delayed<Response>()
  let runId: string | null = null, cancelId: string | undefined, runs = 0
  t.mock.method(globalThis,'fetch', async (address:string,init:RequestInit) => {
    const query = new URL(address,'http://test').searchParams
    assert.equal(query.get('sessionId'),'only-this-session')
    assert.equal(new Headers(init.headers).get('x-docwen-dsh'),'1')
    if (query.get('action') === 'cancel') {
      cancelId = JSON.parse(String(init.body)).taskId
      running.resolve(Response.json({error:'Cancelled'},{status:409}))
      return Response.json({ok:true})
    }
    runs++; runId=query.get('taskId'); return running.promise
  })
  const binding = new SessionBinding('only-this-session')
  const submitted = binding.submit([exportJob('a'),exportJob('b')])
  await binding.cancel()
  await submitted
  assert.equal(cancelId, runId)
  assert.ok(cancelId)
  assert.equal(runs,1)
  assert.deepEqual(binding.snapshot().jobs.map(j=>j.status),['cancelled','cancelled'])
})

test('only a selection needing layout conversion offers the composite merge', () => {
  const mixed = capability('docwen-dsh.merge-layouts',[{role:'source',min_items:2,media_types:['application/pdf','application/vnd.ofd']}])
  assert.equal(compatible(mixed,[item('a.pdf'),item('b.pdf')]),false)
  assert.equal(jobsFor(mixed,[item('a.pdf'),item('b.ofd')],{}).length,1)
})
test('completed file rows release their upload references while failed rows remain retryable', async t => {
  let calls=0
  t.mock.method(globalThis,'fetch',async () => {
    calls++
    return calls === 1 ? Response.json(result('ok')) : Response.json({error:'failed'},{status:422})
  })
  const first: Item = {...item('a.pdf'),source:{kind:'upload', file:new File(['a'],'a.pdf')}}
  const second: Item = {...item('b.pdf'),source:{kind:'upload', file:new File(['b'],'b.pdf')}}
  const binding=new SessionBinding('s')
  await binding.submit(jobsFor(capability('split.pdf.every_page',[pdf]),[first, second],{}))
  const rows=binding.snapshot().jobs
  assert.deepEqual(rows.map(j => j.intent.action === 'process' ? j.intent.inputs.length : -1),[0,1])
})

test('Word imports select portable image output only when the installed Core supports it', () => {
  const docx = capability('convert.docx.to_markdown', [])
  docx.options_schema = {properties: {
    preserve_resources: {type:'boolean'},
    image_mode: {enum:['file', 'omit']},
    image_link_style: {enum:['wiki_embed', 'markdown_embed'], default:'wiki_embed'},
  }}
  assert.deepEqual(workbenchOptions(docx), {
    preserve_resources:true, image_mode:'file', image_link_style:'markdown_embed',
  })
  assert.deepEqual(workbenchOptions({...docx, capability_id:'validate.markdown'}), {})
  assert.deepEqual(workbenchOptions({...docx, options_schema:{properties:{image_mode:{enum:['omit']}}}}), {})
})
