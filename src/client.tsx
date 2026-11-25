import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentType } from 'react'
import type { Result, ResultFile } from './documents.js'

export const name = 'docwen-dsh-client'
export const inject = ['slots']

type Scope = { binding: Binding }
type Composer = { insertQuote(markdown: string): boolean }
type View = Scope & { inputActions?: Composer }
type Section = { title: string; markdown: string }

interface Binding {
  sessionId: string
  subscribe(listener: () => void): () => void
  snapshot(): State
  load(signal: AbortSignal): Promise<void>
  run(action: 'export' | 'import', fields: Record<string, string>, body: Blob | string): Promise<void>
  cancel(): void
}

interface State {
  results: Result[]
  running: boolean
  error?: string
}

interface Client {
  slots: {
    inject(slot: string, install: () => unknown): void
    register<Props>(definition: {
      name: string; id: string; order: number; label?: string
      inject(sessionId: string): Scope
    }, component: ComponentType<Props>): unknown
  }
  effect(callback: () => () => void, label: string): void
}

function url(sessionId: string, action: string, fields: Record<string, string> = {}): string {
  return `api/docwen-dsh${action === 'import' ? '/upload' : ''}?${new URLSearchParams({ ...fields, sessionId, action })}`
}

async function json<Value>(input: string, options?: RequestInit): Promise<Value> {
  const response = await fetch(input, options)
  const data = await response.json()
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `DocWen DSH HTTP ${response.status}`)
  return data as Value
}

function sessionBinding(sessionId: string): Binding {
  const listeners = new Set<() => void>()
  let state: State = { results: [], running: false }
  let current: AbortController | undefined
  let revision = 0
  const set = (changes: Partial<State>) => {
    state = { ...state, ...changes }
    listeners.forEach(listener => listener())
  }
  return {
    sessionId,
    snapshot: () => state,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    load: async signal => {
      const startedAt = revision
      try {
        const results = await json<Result[]>(url(sessionId, 'list'), { signal })
        if (!signal.aborted && startedAt === revision) set({ results })
      } catch (error) {
        if (!signal.aborted) set({ error: String(error) })
      }
    },
    run: async (action, fields, body) => {
      if (current) return
      const control = new AbortController()
      current = control
      set({ running: true, error: undefined })
      try {
        const result = await json<Result>(url(sessionId, action, fields), {
          body, signal: control.signal, method: 'POST', headers: { 'x-docwen-dsh': '1' },
        })
        revision += 1
        set({ results: [result, ...state.results.filter(item => item.id !== result.id)] })
        if (action === 'export') requestDownload(url(sessionId, 'file', { resultId: result.id, artifactId: result.primary }))
      } catch (error) {
        set({ error: control.signal.aborted ? 'Cancelled. Check saved results for any completed operation.' : String(error) })
      } finally {
        current = undefined
        set({ running: false })
      }
    },
    cancel: () => current?.abort(),
  }
}

function requestDownload(href: string): void {
  const link = document.createElement('a')
  link.href = href
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

function ExportAction({ binding, messageId }: Scope & { messageId: string }) {
  const state = useSyncExternalStore(binding.subscribe, binding.snapshot)
  const [used, setUsed] = useState(false)
  return <span>
    <button type="button" disabled={state.running} title="Use the default DocWen template and proofreading settings"
      onClick={() => {
        setUsed(true)
        void binding.run('export', { messageId }, JSON.stringify({ proofread: true }))
      }}>Export Word</button>
    {used && state.running && <button type="button" onClick={binding.cancel}>Cancel</button>}
    {used && state.error && <span role="status"> {state.error}</span>}
  </span>
}

function Download({ binding, result, file }: { binding: Binding; result: Result; file: ResultFile }) {
  return <a download href={url(binding.sessionId, 'file', { resultId: result.id, artifactId: file.id })}>
    {file.path}
  </a>
}

function DocumentSections({ binding, result, inputActions }: View & { result: Result }) {
  const [sections, setSections] = useState<Section[]>([])
  const [index, setIndex] = useState(0)
  const [feedback, setFeedback] = useState('')
  useEffect(() => {
    const control = new AbortController()
    void json<Section[]>(url(binding.sessionId, 'sections', { resultId: result.id }), { signal: control.signal })
      .then(value => { if (!control.signal.aborted) setSections(value) })
      .catch(error => { if (!control.signal.aborted) setFeedback(String(error)) })
    return () => { control.abort() }
  }, [binding.sessionId, result.id])
  const section = sections[index]
  return <div>
    {section && <>
      <label>Section <select value={index} onChange={event => {
        setIndex(Number(event.target.value))
        setFeedback('')
      }}>
        {sections.map((item, position) => <option key={position} value={position}>{item.title}</option>)}
      </select></label>
      <pre style={{ maxHeight: '12rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{section.markdown}</pre>
      {inputActions && <button type="button" onClick={() => {
        setFeedback(inputActions.insertQuote(section.markdown) ? 'Added to the conversation draft.' : 'The draft could not accept this section.')
      }}>Add section to draft</button>}
    </>}
    {feedback && <p role="status">{feedback}</p>}
  </div>
}

function ResultRow({ binding, result, inputActions }: View & { result: Result }) {
  const [expanded, setExpanded] = useState(false)
  const primary = result.files.find(file => file.id === result.primary)
  if (!primary) return null
  const markdown = primary.media === 'text/markdown'
  return <li>
    <Download binding={binding} result={result} file={primary} />
    {markdown && <>
      {' '}<a download href={url(binding.sessionId, 'archive', { resultId: result.id })}>Download Markdown and images</a>
      {' '}<button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Review sections</button>
      {expanded && <>
        <DocumentSections binding={binding} result={result} inputActions={inputActions} />
        {result.files.filter(file => file.media.startsWith('image/')).map(file =>
          <img key={file.id} alt={file.path} loading="lazy" style={{ maxWidth: '100%' }}
            src={url(binding.sessionId, 'file', { resultId: result.id, artifactId: file.id, inline: '1' })} />,
        )}
      </>}
    </>}
    {result.warnings.map((warning, index) => <p key={index} role="status">{warning}</p>)}
  </li>
}

function Panel({ binding, inputActions }: View) {
  const state = useSyncExternalStore(binding.subscribe, binding.snapshot)
  useEffect(() => {
    const control = new AbortController()
    void binding.load(control.signal)
    return () => { control.abort() }
  }, [binding])
  return <div>
    <label>Import Word <input type="file" accept=".docx"
      disabled={state.running} onChange={event => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) void binding.run('import', { filename: file.name }, file)
      }} /></label>
    {state.running && <p role="status">Converting document… <button type="button" onClick={binding.cancel}>Cancel</button></p>}
    {state.error && <p role="status">{state.error}</p>}
    <ul>{state.results.map(result => <ResultRow key={result.id} binding={binding} inputActions={inputActions} result={result} />)}</ul>
  </div>
}

export function apply(ctx: Client): void {
  const sessions = new Map<string, Binding>()
  const bind = (sessionId: string): Scope => {
    let binding = sessions.get(sessionId)
    if (!binding) {
      binding = sessionBinding(sessionId)
      sessions.set(sessionId, binding)
    }
    return { binding }
  }
  ctx.effect(() => () => {
    sessions.forEach(binding => binding.cancel())
    sessions.clear()
  }, 'docwen-dsh: release session UI')
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'docwen-dsh-export', order: 30, inject: bind,
  }, ExportAction))
  ctx.slots.inject('conversation.session.panel.section', () => ctx.slots.register({
    name: 'conversation.session.panel.section', id: 'docwen-dsh', order: 40, label: 'DocWen', inject: bind,
  }, Panel))
}
