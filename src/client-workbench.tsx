import { useEffect, useState } from 'react'
import type { Result } from './documents.js'
import { OptionFields } from './client-options.js'
import { api, available, capName, compatible, fileMedia, identifier, jobsFor, LAYOUT_MERGE, resultItem, shifted, sourceSlot, workbenchOptions,
  type Attachment, type Catalog, type Item, type Options, type Text } from './client-model.js'
import type { SessionBinding } from './client-session.js'

const raster = new Set(['image/png', 'image/gif', 'image/jpeg', 'image/webp', 'image/bmp'])
const plain = new Set(['text/markdown', 'text/plain'])
export function FilePreview({ sessionId, item, t }: { sessionId: string; item: Item; t: Text }) {
  const [view, setView] = useState<{ text?: string; image?: string; error?: string }>({})
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setView({})
    async function load() {
      const source = item.source
      let blob: Blob
      const limit = 2 * 1024 * 1024
      if (item.bytes !== undefined && item.bytes > limit) throw new Error(t('Preview limit: 2 MiB.', '预览上限为 2 MiB。'))
      if (source.kind === 'upload') blob = source.file
      else {
        let url: string
        if (source.kind === 'result') url = api(sessionId, 'file', { resultId: source.resultId, artifactId: source.artifactId })
        else if (source.kind === 'workspace') url = api(sessionId, 'source-preview', { kind: source.kind, path: source.path })
        else url = api(sessionId, 'source-preview', { kind: source.kind, attachmentId: source.attachmentId })
        const response = await fetch(url, { signal: controller.signal })
        if (!response.ok) throw new Error((await response.json()).error ?? 'DocWen HTTP ' + response.status)
        if (Number(response.headers.get('content-length')) > limit) throw new Error(t('Preview limit: 2 MiB.', '预览上限为 2 MiB。'))
        blob = await response.blob()
      }
      if (blob.size > limit) throw new Error(t('Preview limit: 2 MiB.', '预览上限为 2 MiB。'))
      if (controller.signal.aborted) return
      if (raster.has(item.media)) {
        objectUrl = URL.createObjectURL(blob)
        setView({ image: objectUrl })
      } else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer())
        if (!controller.signal.aborted) setView({ text })
      }
    }
    void load().catch(error => { if (!controller.signal.aborted) setView({ error: String(error) }) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [sessionId, item, t])
  if (view.image) return <img style={{ maxWidth: '100%', maxHeight: '16rem' }} alt={item.label} src={view.image}/>
  return <pre style={{ maxHeight: '15rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{view.error ?? view.text ?? t('Loading…', '正在载入…')}</pre>
}

export function Workbench({ binding, catalog, attachments, results, busy, t }: {
  binding: SessionBinding; catalog: Catalog; attachments: Attachment[]; results: Result[]; busy: boolean; t: Text
}) {
  const [items, setItems] = useState<Item[]>([])
  const [path, setPath] = useState('')
  const [selected, setSelected] = useState('')
  const [options, setOptions] = useState<Options>({})
  const [preview, setPreview] = useState('')
  const choices = catalog.capabilities.filter(cap => compatible(cap, items))
  const operation = choices.find(c => c.capability_id === selected)
  const jobs = operation ? jobsFor(operation, items, options) : []
  const layout = items.some(i => ['application/vnd.ofd', 'application/vnd.ms-xpsdocument'].includes(i.media))
    && items.length >= 2 && items.every(i => ['application/vnd.ofd', 'application/vnd.ms-xpsdocument', 'application/pdf'].includes(i.media))
  const pdfMerge = catalog.capabilities.some(c => c.capability_id !== LAYOUT_MERGE && available(c) &&
    c.operation === 'merge' && c.output_media_types.includes('application/pdf') && sourceSlot(c)?.media_types.includes('application/pdf'))
  const mixed = catalog.capabilities.find(c => c.capability_id === LAYOUT_MERGE && available(c))
  const missingRoutes = [...new Set(items.map(i => i.media).filter(m => m !== 'application/pdf' &&
    !mixed?.input_shape.slots.find(s => s.role === 'source')?.media_types.includes(m)))]
    .map(m => (m === 'application/vnd.ofd' ? 'OFD' : 'XPS') + ' → PDF')
  function changeItems(next: Item[]) {
    setItems(next)
    if (selected && !catalog.capabilities.some(c => c.capability_id === selected && compatible(c, next))) {
      setSelected('')
      setOptions({})
    }
  }
  const attached = (id: string) => {
    const value = attachments.find(a => a.id === id)
    if (value) changeItems([...items, { key: identifier(), label: value.name, media: fileMedia(value.name, value.mediaType),
      source: { kind: 'attachment', attachmentId: value.id } }])
  }
  const saved = (id: string) => {
    if (!id) return
    const [resultId, artifactId]: string[] = JSON.parse(id)
    const result = results.find(r => r.id === resultId)
    const file = result?.files.find(f => f.id === artifactId)
    if (result && file) changeItems([...items, resultItem(result, file)])
  }
  return <fieldset disabled={busy}>
    <legend>{t('File processing', '文件处理')}</legend>
    <p><label>{t('Local files', '本机文件')} <input type="file" multiple onChange={e => {
      const files = Array.from(e.target.files ?? [])
      changeItems([...items, ...files.map(file => ({ key: identifier(), label: file.name, media: fileMedia(file.name, file.type), bytes: file.size,
        source: { kind: 'upload' as const, file } }))])
      e.target.value = ''
    }}/></label></p>
    <form onSubmit={e => {
      e.preventDefault()
      const name = path.trim()
      if (!name) return
      changeItems([...items, { key: identifier(), label: name, media: fileMedia(name), source: { kind: 'workspace', path: name }}])
      setPath('')
    }}>
      <label>{t('Workspace file', '工作区文件')} <input value={path} placeholder={t('Relative path', '相对路径')}
        onChange={e => setPath(e.target.value)}/></label> <button type="submit" disabled={!path.trim()}>{t('Add', '添加')}</button>
    </form>
    {attachments.length > 0 && <p><label>{t('Session attachment', '会话附件')} <select aria-label={t('Session attachment', '会话附件')} value="" onChange={e => attached(e.target.value)}>
      <option value="">{t('Choose an attachment…', '选择附件…')}</option>
      {attachments.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label></p>}
    {results.length > 0 && <p><label>{t('Saved file', '已有结果文件')} <select aria-label={t('Saved file', '已有结果文件')} value="" onChange={e => saved(e.target.value)}>
      <option value="">{t('Choose a result…', '选择结果…')}</option>
      {results.map(r => <optgroup key={r.id} label={r.label}>{r.files.map(f =>
        <option key={f.id} value={JSON.stringify([r.id, f.id])}>{f.path}</option>)}</optgroup>)}</select></label></p>}
    {items.length > 0 && <ol>{items.map((item, i) => <li key={item.key}>
      {item.label} {' '}
      <button type="button" disabled={!i} onClick={() => changeItems(shifted(items, i, -1))}>{t('Up', '上移')}</button>{' '}
      <button type="button" disabled={i === items.length - 1} onClick={() => changeItems(shifted(items, i, 1))}>{t('Down', '下移')}</button>{' '}
      <button type="button" onClick={() => changeItems(items.filter(v => v.key !== item.key))}>{t('Remove', '移除')}</button>{' '}
      {(raster.has(item.media) || plain.has(item.media)) && <button type="button" aria-expanded={preview === item.key}
        onClick={() => setPreview(preview === item.key ? '' : item.key)}>{t('Preview', '预览')}</button>}
      {preview === item.key && <FilePreview item={item} sessionId={binding.sessionId} t={t}/>}
      </li>)}</ol>}
    {items.length > 0 && <form onSubmit={e => { e.preventDefault(); if (jobs.length) void binding.submit(jobs) }}>
      <label>{t('Operation', '操作')} <select aria-label={t('Operation', '操作')} value={operation?.capability_id ?? ''} onChange={e => {
        setSelected(e.target.value); setOptions(workbenchOptions(choices.find(c => c.capability_id === e.target.value)))
      }}><option value="">{t('Choose an operation…', '选择操作…')}</option>
        {choices.map(c => <option key={c.capability_id} value={c.capability_id}>{capName(c, t)}</option>)}
      </select></label>
      {!choices.length && <p>{t('This DocWen installation offers no operation for this combination of files.',
        '当前 DocWen 没有可处理这组文件的操作。')}</p>}
      {layout && !choices.some(c => c.capability_id === LAYOUT_MERGE || c.operation === 'merge' && c.output_media_types.includes('application/pdf')) &&
        <p>{t('Unavailable in this DocWen installation: ', '当前 DocWen 缺少可用操作：')}
          {pdfMerge ? missingRoutes.join(', ') : t('PDF merge','PDF 合并')}</p>}
      {operation && <div key={operation.capability_id}>
        <OptionFields t={t} schema={operation.options_schema} options={options} setOptions={setOptions} catalog={catalog}/>
        {items.length < (sourceSlot(operation)?.min_items ?? 1) && <p>{t('More source files are required.', '请再添加要处理的文件。')}</p>}
        <button type="submit" disabled={!jobs.length}>{jobs.length > 1 ? t('Run batch', '批量处理') : t('Run', '开始处理')}</button>
      </div>}
    </form>}
  </fieldset>
}
