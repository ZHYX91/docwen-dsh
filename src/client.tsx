import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { Result, ResultFile } from './documents.js'
import { api, available, EXPORT, json, resultItem, type Catalog, type Job, type Options, type Reply, type Text } from './client-model.js'
import { OptionFields } from './client-options.js'
import { SessionBinding } from './client-session.js'
import { FilePreview, Workbench } from './client-workbench.js'

export const name = 'docwen-dsh-client'
export const inject = ['slots', 'locale']
interface Locale {
  getLocale(): { active: string }
  resolveText(value: { en: string; zh: string }): string
  subscribe(fn: () => void): () => void
}
type Scope = { binding: SessionBinding; locale: Locale }
type Composer = { insertQuote(markdown: string): boolean }
type View = Scope & { inputActions?: Composer }
interface Client {
  locale: Locale
  slots: {
    inject(slot: string, install: () => unknown): void
    register<Props>(definition: {
      name: string; id: string; order: number; label?: string
      inject(sessionId: string): Scope
    }, component: ComponentType<Props>): unknown
  }
  effect(callback: () => () => void, label: string): void
}
function useText(locale: Locale): Text {
  const subscribe = useCallback((fn: () => void) => locale.subscribe(fn), [locale])
  const active = useSyncExternalStore(subscribe, () => locale.getLocale().active)
  return useCallback((en, zh) => locale.resolveText({ en, zh }), [locale, active])
}
function useBinding(binding: SessionBinding) { return useSyncExternalStore(binding.subscribe, binding.snapshot) }
const previewStyle = { maxHeight: '14rem', overflow: 'auto', whiteSpace: 'pre-wrap' } as const
function ExportForm({ binding, catalog, replies, t }: { binding: SessionBinding; catalog: Catalog; replies: Reply[]; t: Text }) {
  const cap = catalog.capabilities.find(c => c.capability_id === EXPORT && available(c))
  const [options, setOptions] = useState<Options>(() => cap?.options_schema.properties?.proofread ? { proofread: {} } : {})
  const state = useBinding(binding)
  if (!cap) return <p>{t('Markdown-to-Word export is unavailable in this DocWen installation.', '当前 DocWen 未提供 Markdown 转 Word。')}</p>
  return <form onSubmit={e => {
    e.preventDefault()
    void binding.submit([{ label: replies.map(r => r.label).join(' · '), status: 'queued',
      intent: { action: 'export', messageIds: replies.map(r => r.id), options } }])
  }}>
    <fieldset disabled={state.running || !!state.active}>
      <legend>{t('Word export', '导出 Word')}</legend>
      <OptionFields schema={{ properties: Object.fromEntries(Object.entries(cap.options_schema.properties ?? {})
        .filter(([key]) => key === 'template_name' || key === 'proofread')) }}
        options={options} setOptions={setOptions} catalog={catalog} t={t}/>
      <details><summary>{t('Document options', '文档选项')}</summary>
        <OptionFields schema={{ properties: Object.fromEntries(Object.entries(cap.options_schema.properties ?? {})
          .filter(([key]) => key !== 'template_name' && key !== 'proofread')) }}
          options={options} setOptions={setOptions} catalog={catalog} t={t}/>
      </details>
      <button type="submit" disabled={!replies.length}>{replies.length > 1 ? t('Export combined Word document','合编并导出 Word') : t('Export Word','导出 Word')}</button>
    </fieldset>
  </form>
}
interface Preview { markdown: string; images: string[] }
function ExportAction({ binding, locale, messageId }: Scope & { messageId: string }) {
  const t = useText(locale)
  const state = useBinding(binding)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const dialogTitle = useId()
  const [loaded, setLoaded] = useState<{ sessionId: string; messageId: string; value: Preview }>()
  const preview = loaded?.sessionId === binding.sessionId && loaded?.messageId === messageId ? loaded.value : undefined
  const [error, setError] = useState('')
  useEffect(() => {
    setLoaded(undefined); setError('')
    if (!open) return
    const ctrl = new AbortController()
    void binding.refreshCatalog()
    void json<Preview>(api(binding.sessionId, 'preview', { messageId }), { signal: ctrl.signal })
      .then(v => { if (!ctrl.signal.aborted) setLoaded({ sessionId: binding.sessionId, messageId, value: v }) })
      .catch(e => { if (!ctrl.signal.aborted) setError(String(e)) })
    return () => ctrl.abort()
  }, [binding, open, messageId])
  const selected = state.replies.some(r => r.id === messageId)
  const reply = { id: messageId, label: preview?.markdown.trim().split('\n')[0].slice(0, 75) || messageId }
  const job = state.jobs.find(j => j.intent.action === 'export' && j.intent.messageIds.includes(messageId))
  const result = job?.resultId ? state.results.find(r => r.id === job.resultId) : undefined
  const primary = result?.files.find(f => f.id === result.primary)
  return <div>
    <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => {
      dialog.current?.showModal()
      setOpen(true)
    }}>{t('Export Word…','导出 Word…')}</button>
    <dialog ref={dialog} aria-labelledby={dialogTitle} onClose={event => setOpen(event.currentTarget.open)}
      style={{ boxSizing: 'border-box', width: 'min(36rem, calc(100vw - 2rem))',
        maxHeight: 'calc(100dvh - 2rem)', overflow: 'auto', margin: 'auto', overflowWrap: 'anywhere' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <h2 id={dialogTitle}>{t('Export reply to Word','将回复导出为 Word')}</h2>
        <button type="button" onClick={() => dialog.current?.close()}>{t('Close','关闭')}</button>
      </header>
      {open && <>
        {error && <p role="alert">{error}</p>}
        {preview && <>
          <details><summary>{t('Source Markdown and referenced images','源 Markdown 和引用图片')}</summary>
            <pre style={previewStyle}>{preview.markdown}</pre>
            {preview.images.length > 0 && <ul>{preview.images.map((image, i) => <li key={i}>{image}</li>)}</ul>}
          </details>
          <label><input type="checkbox" checked={selected} onChange={() => binding.toggle(reply)}/>
            {t('Include in combined export in the DocWen panel', '加入 DocWen 会话面板的合编列表')}</label>
          {state.catalog && <ExportForm binding={binding} catalog={state.catalog} replies={[reply]} t={t}/>}
        </>}
        {!preview && !error && <p role="status">{t('Loading reply…','正在读取回复…')}</p>}
        {state.error && <p role="alert">{state.error}</p>}
        {job && <p role="status">{statusText(job, t)} {job.error} {primary && result && <Download binding={binding} result={result} file={primary}/>}
          {job.status === 'running' && <button type="button" disabled={state.stopping} onClick={() => void binding.cancel()}>{t('Cancel','取消')}</button>}
        </p>}
      </>}
    </dialog>
  </div>
}
function statusText(job: Job, t: Text) {
  const statuses: Record<Job['status'], [string,string]> = { queued: ['Queued','等待中'], running: ['Running','处理中'],
    done: ['Completed','已完成'], failed: ['Failed','失败'], uncertain: ['Result not confirmed','结果未确认'], cancelled: ['Cancelled','已取消'] }
  return t(...statuses[job.status])
}
function Download({ binding, result, file }: { binding: SessionBinding; result: Result; file: ResultFile }) {
  return <a download href={api(binding.sessionId, 'file', { resultId: result.id, artifactId: file.id })}>{file.path}</a>
}
interface Section { title: string; markdown: string }
function DocumentSections({ binding, result, inputActions, t }: {
  binding: SessionBinding; result: Result; inputActions?: Composer; t: Text
}) {
  const [sections, setSections] = useState<Section[]>([])
  const [index, setIndex] = useState(0)
  const [feedback, setFeedback] = useState('')
  useEffect(() => {
    const ctrl = new AbortController()
    void json<Section[]>(api(binding.sessionId, 'sections', { resultId: result.id }), { signal: ctrl.signal })
      .then(v => { if (!ctrl.signal.aborted) setSections(v) })
      .catch(e => { if (!ctrl.signal.aborted) setFeedback(String(e)) })
    return () => ctrl.abort()
  }, [binding, result.id])
  const section = sections[index]
  return <div>
    {section && <>
      <label>{t('Section','章节')} <select aria-label={t('Section','章节')} value={index} onChange={e => { setIndex(Number(e.target.value)); setFeedback('') }}>
        {sections.map((s,i) => <option key={i} value={i}>{s.title}</option>)}</select></label>
      <pre style={previewStyle}>{section.markdown}</pre>
      {inputActions && <button type="button" onClick={() => setFeedback(inputActions.insertQuote(section.markdown)
        ? t('Added to the conversation draft.', '已添加到对话草稿。') : t('The draft could not accept this section.', '无法将该章节添加到草稿。'))}>
        {t('Add section to draft','将所选章节加入草稿')}</button>}
    </>}
    {feedback && <p role="status">{feedback}</p>}
  </div>
}
function ResultRow({ binding, result, inputActions, t }: {
  binding: SessionBinding; result: Result; inputActions?: Composer; t: Text
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const primary = result.files.find(f => f.id === result.primary)
  const [imageId, setImageId] = useState('')
  const images = result.files.filter(f => ['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(f.media))
  const image = images.find(f => f.id === imageId)
  return <li>
    {primary ? <><Download binding={binding} result={result} file={primary}/>{' '}
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t('Open result','打开结果')}</button></>
      : <span>{t('This saved result is incomplete. You can remove it.', '此结果不完整，无法打开，可以删除。')}</span>}{' '}
    <button type="button" onClick={() => setConfirm(!confirm)}>{t('Delete…','删除…')}</button>
    {confirm && <p>{t('Delete this saved result and its files?', '删除这份结果及其全部文件？')}{' '}
      <button type="button" onClick={() => { setConfirm(false); void binding.remove(result.id) }}>{t('Delete result', '确认删除')}</button>{' '}
      <button type="button" onClick={() => setConfirm(false)}>{t('Keep','保留')}</button></p>}
    {expanded && primary && <div>
      <p>{result.label} · <time dateTime={result.created}>{new Date(result.created).toLocaleString()}</time></p>
      <a download href={api(binding.sessionId, 'archive', { resultId: result.id })}>{t('Download all files (ZIP)','下载完整结果（ZIP）')}</a>
      {result.files.length > 1 && <ul>{result.files.map(f => <li key={f.id}><Download binding={binding} result={result} file={f}/></li>)}</ul>}
      {primary.media === 'text/markdown' && <DocumentSections binding={binding} result={result} inputActions={inputActions} t={t}/>}
      {images.length > 0 && <label>{t('Preview image', '预览图片')} <select aria-label={t('Preview image', '预览图片')} value={imageId} onChange={e => setImageId(e.target.value)}>
        <option value="">{t('Choose an image…', '选择图片…')}</option>
        {images.map(f => <option key={f.id} value={f.id}>{f.path}</option>)}
      </select></label>}
      {image && <ResultPreview key={image.id} result={result} file={image} binding={binding} t={t}/>}
    </div>}
    {primary && result.warnings.map((w,i) => <p key={i} role="status">{w}</p>)}
  </li>
}
function ResultPreview({ result, file, binding, t }: { result: Result; file: ResultFile; binding: SessionBinding; t: Text }) {
  const [item] = useState(() => resultItem(result, file))
  return <FilePreview item={item} sessionId={binding.sessionId} t={t}/>
}
function Panel({ binding, locale, inputActions }: View) {
  const state = useBinding(binding)
  const t = useText(locale)
  const busy = state.running || !!state.active
  useEffect(() => {
    const ctrl = new AbortController()
    void binding.refreshResults(ctrl.signal)
    void binding.refreshCatalog()
    void binding.refreshAttachments(ctrl.signal)
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      await binding.refreshActive(ctrl.signal)
      if (!ctrl.signal.aborted) timer = setTimeout(poll, binding.snapshot().active || binding.snapshot().running ? 800 : 6000)
    }
    void poll()
    return () => { ctrl.abort(); clearTimeout(timer) }
  }, [binding])
  const p = state.active?.progress
  const percent = typeof p === 'number' ? p : p?.total ? Math.round(100 * (p.completed ?? 0) / p.total) : undefined
  return <div>
    {state.error && <p role="alert">{state.error}</p>}
    <button type="button" onClick={() => {
      void binding.refreshCatalog(true); void binding.refreshResults(); void binding.refreshAttachments(AbortSignal.timeout(15000))
    }}>{t('Refresh', '刷新')}</button>
    {state.replies.length > 0 && <fieldset><legend>{t('Selected replies','待合编回复')}</legend>
      <ol>{state.replies.map((r,i) => <li key={r.id}>{r.label}{' '}
        <button type="button" disabled={!i} onClick={() => binding.moveReply(i,-1)}>{t('Up','上移')}</button>{' '}
        <button type="button" disabled={i === state.replies.length - 1} onClick={() => binding.moveReply(i,1)}>{t('Down','下移')}</button>{' '}
        <button type="button" onClick={() => binding.toggle(r)}>{t('Remove','移除')}</button>
      </li>)}</ol>
      {state.catalog && <ExportForm binding={binding} catalog={state.catalog} replies={state.replies} t={t}/>}
    </fieldset>}
    {state.catalog && <Workbench binding={binding} catalog={state.catalog} results={state.results} attachments={state.attachments} busy={busy} t={t}/>}
    {busy && <p role="status">{t('Processing…','正在处理…')} <progress value={percent} max={100}/>{' '}
      <button type="button" disabled={state.stopping} onClick={() => void binding.cancel()}>{t('Cancel','取消')}</button></p>}
    {state.jobs.length > 0 && <div><ul>{state.jobs.map((job,i) => <li key={i}>{job.label} · {statusText(job,t)} {job.error}</li>)}</ul>
      {state.jobs.some(j => j.status === 'failed' || j.status === 'uncertain') && <button type="button" disabled={busy}
        onClick={() => void binding.submit(state.jobs,true)}>{state.jobs.some(j => j.status === 'uncertain') ? t('Check and retry unfinished items','核对并重试未完成项')
          : t('Retry failed items','重试失败项')}</button>}</div>}
    {state.results.length > 0 && <><h4>{t('Saved results','已保存的结果')}</h4><ul>{state.results.map(result =>
      <ResultRow key={result.id} binding={binding} result={result} t={t} inputActions={inputActions}/>)}</ul></>}
  </div>
}
export function apply(ctx: Client): void {
  const sessions = new Map<string, WeakRef<SessionBinding>>()
  const cleanup = new FinalizationRegistry<string>(key => { if (!sessions.get(key)?.deref()) sessions.delete(key) })
  const bind = (sessionId: string): Scope => {
    let binding = sessions.get(sessionId)?.deref()
    if (!binding) {
      binding = new SessionBinding(sessionId)
      sessions.set(sessionId, new WeakRef(binding))
      cleanup.register(binding, sessionId)
    }
    return { binding, locale: ctx.locale }
  }
  ctx.effect(() => () => { sessions.forEach(ref => ref.deref()?.dispose()); sessions.clear() }, 'docwen-dsh: release session UI')
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'docwen-dsh-export', order: 30, inject: bind,
  }, ExportAction))
  ctx.slots.inject('conversation.session.panel.section', () => ctx.slots.register({
    name: 'conversation.session.panel.section', id: 'docwen-dsh', order: 40, label: 'DocWen', inject: bind,
  }, Panel))
}
