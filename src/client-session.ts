import type { Result } from './documents.js'
import { api, HttpFailure, identifier, json, shifted, wireIntent, type Attachment, type Catalog, type Job, type Reply } from './client-model.js'

export interface Active { id: string; progress?: number | { completed?: number; total?: number; message?: string } }
interface State {
  results: Result[]
  catalog?: Catalog
  attachments: Attachment[]
  jobs: Job[]
  replies: Reply[]
  active: Active | null
  running: boolean
  busyId?: string
  stopping: boolean
  error?: string
}
function finish(job: Job, status: 'done' | 'cancelled', resultId?: string): Job {
  // Retrying only needs input bytes for failed rows. Finished rows keep their display metadata.
  const intent = job.intent.action === 'process' ? { ...job.intent, inputs: [] } : job.intent
  return { ...job, intent, status, resultId }
}

export class SessionBinding {
  private listeners = new Set<() => void>()
  private state: State = { results: [], attachments: [], jobs: [], replies: [], active: null, running: false, stopping: false }
  private revision = 0
  private sequence = 0
  private disposed = false
  private lifecycle = new AbortController()
  private request?: AbortController
  private loading?: Promise<void>
  constructor(readonly sessionId: string) {}
  snapshot = () => this.state
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private set(changes: Partial<State>) {
    if (this.disposed) return
    this.state = { ...this.state, ...changes }
    this.listeners.forEach(fn => fn())
  }
  private url(action: string, fields: Record<string, string> = {}, upload = false) {
    return api(this.sessionId, action, fields, upload)
  }
  refreshCatalog = async (force = false) => {
    if (this.state.catalog && !force) return
    if (this.loading) return this.loading
    this.loading = json<Catalog>(this.url('catalog'), { signal: this.lifecycle.signal })
      .then(catalog => this.set({ catalog, error: undefined })).catch(error => this.set({ error: String(error) }))
      .finally(() => { this.loading = undefined })
    return this.loading
  }
  refreshResults = async (signal = this.lifecycle.signal) => {
    const revision = this.revision
    try {
      const results = await json<Result[]>(this.url('list'), { signal })
      if (!signal.aborted && revision === this.revision) this.set({ results })
    } catch (error) { if (!signal.aborted) this.set({ error: String(error) }) }
  }
  refreshAttachments = async (signal: AbortSignal) => {
    try {
      const attachments = await json<Attachment[]>(this.url('attachments'), { signal })
      if (!signal.aborted) this.set({ attachments })
    } catch (error) { if (!signal.aborted) this.set({ error: String(error) }) }
  }
  refreshActive = async (signal: AbortSignal) => {
    const generation = ++this.sequence
    try {
      const active = await json<Active | null>(this.url('active'), { signal })
      if (signal.aborted || this.disposed || generation !== this.sequence) return
      const previous = this.state.active
      if (active || previous) this.set({ active })
      if (previous && !active && !this.state.running) await this.refreshResults(signal)
    } catch (error) { if (!signal.aborted) this.set({ error: String(error) }) }
  }
  toggle(reply: Reply) {
    const existing = this.state.replies
    this.set({ replies: existing.some(r => r.id === reply.id) ? existing.filter(r => r.id !== reply.id) : [...existing, reply] })
  }
  moveReply(index: number, delta: number) { this.set({ replies: shifted(this.state.replies, index, delta) }) }
  private async savedResult(taskId: string, signal: AbortSignal): Promise<Result | undefined> {
    if (signal.aborted) return
    try {
      const saved = await json<Result>(this.url('result', { resultId: taskId }), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      })
      if (!signal.aborted && saved?.id === taskId) return saved
    } catch { /* A missing or unavailable result does not prove the task failed. */ }
  }
  private acceptResult(result: Result) {
    this.revision++
    this.set({ results: [result, ...this.state.results.filter(r => r.id !== result.id)] })
  }
  submit = async (jobs: Job[], retry = false) => {
    if (this.disposed || this.state.running || this.state.active || !jobs.length) return
    const queue = retry ? jobs.map(j => (j.status === 'failed' || j.status === 'uncertain') ? { ...j, status: 'queued' as const, error: undefined } : j) : [...jobs]
    if (!queue.some(j => j.status === 'queued')) return
    this.set({ jobs: queue, running: true, stopping: false, error: undefined })
    try {
      for (let index = 0; index < queue.length; index++) {
        if (this.disposed || queue[index].status !== 'queued') continue
        if (this.state.stopping) { queue[index] = finish(queue[index], 'cancelled'); continue }
        const previousId = retry ? queue[index].taskId : undefined
        const taskId = previousId ?? identifier()
        const request = new AbortController()
        this.request = request
        const signal = AbortSignal.any([this.lifecycle.signal, request.signal])
        queue[index] = { ...queue[index], taskId, status: 'running' }
        this.set({ jobs: [...queue], busyId: taskId })
        try {
          // Read back the exact attempt before a manual retry. If the result appears
          // between this lookup and the POST, the host also fences the same ID.
          let result = previousId ? await this.savedResult(taskId, signal) : undefined
          if (!result && this.state.stopping) {
            queue[index] = finish(queue[index], 'cancelled')
            continue
          }
          if (!result) {
            signal.throwIfAborted()
            const { body, multipart } = wireIntent(queue[index].intent)
            result = await json<Result>(this.url('run', { taskId }, multipart), {
              method: 'POST', headers: multipart ? { 'x-docwen-dsh': '1' } : { 'x-docwen-dsh': '1', 'content-type': 'application/json' },
              body, signal,
            })
            if (result?.id !== taskId) throw new Error('DocWen returned an unexpected task result.')
          }
          this.acceptResult(result)
          queue[index] = finish(queue[index], 'done', taskId)
        } catch (error) {
          const saved = await this.savedResult(taskId, this.lifecycle.signal)
          if (saved) {
            this.acceptResult(saved)
            queue[index] = finish(queue[index], 'done', taskId)
          } else if (this.state.stopping && error instanceof HttpFailure && error.status < 500) {
            queue[index] = finish(queue[index], 'cancelled')
          } else {
            const rejected = error instanceof HttpFailure && [400, 403, 404, 413, 422].includes(error.status)
            queue[index] = { ...queue[index], status: rejected ? 'failed' : 'uncertain', error: String(error) }
          }
        } finally {
          this.request = undefined
          ++this.sequence
          this.set({ busyId: undefined, active: null, jobs: [...queue] })
        }
      }
    } finally { this.set({ running: false, stopping: false, jobs: [...queue] }) }
  }
  cancel = async () => {
    const taskId = this.state.busyId ?? this.state.active?.id
    if (!taskId || this.state.stopping) return
    this.set({ stopping: true })
    try {
      const result = await this.post('cancel', { taskId })
      if (!result.ok) {
        // The upload may still be arriving at the host, before a task is registered.
        if (this.state.busyId === taskId) this.request?.abort()
        await this.refreshResults()
      }
    } catch (error) { this.set({ error: String(error), stopping: false }) }
    finally { if (!this.state.running) this.set({ stopping: false }) }
  }
  async remove(resultId: string) {
    try {
      const data = await this.post('delete', { resultId })
      if (!data.ok) throw new Error('DocWen HTTP: delete failed.')
      this.revision++
      this.set({ results: this.state.results.filter(r => r.id !== resultId) })
    } catch (error) { this.set({ error: String(error) }) }
  }
  private post(action: string, params: unknown) {
    return json<{ ok: boolean }>(this.url(action), { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-docwen-dsh': '1' }, body: JSON.stringify(params), signal: this.lifecycle.signal })
  }
  dispose() { this.disposed = true; this.lifecycle.abort(); this.listeners.clear() }
}
