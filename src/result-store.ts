import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileWithin, hash, readResult, readResultFile, type Result, type ResultPage } from './documents.js'

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
export const sessionKey = /^[\w.:-]{1,180}$/u
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const PAGE_SIZE = 24
type ResultKey = { time: number; id: string }
const newestFirst = (left: ResultKey, right: ResultKey) => right.time - left.time || right.id.localeCompare(left.id)

function pageKey(cursor: string): ResultKey {
  if (cursor.length > 64) throw new Error('Invalid result page cursor.')
  const [timestamp, id, extra] = cursor.split(':')
  const time = Number(timestamp)
  if (extra !== undefined || !/^\d+$/u.test(timestamp) || !Number.isSafeInteger(time) || !uuid.test(id ?? ''))
    throw new Error('Invalid result page cursor.')
  return { time, id }
}

async function directory(parent: string, name: string, create: boolean): Promise<string> {
  const target = path.join(parent, name)
  if (create) await mkdir(target, { recursive: true, mode: 0o700 })
  if (!(await lstat(target)).isDirectory() || (await realpath(target)) !== target)
    throw new Error('The document storage directory was redirected.')
  return target
}

export class ResultStore {
  constructor(readonly home: string) {}
  async root(session: string, create = false): Promise<string> {
    if (!sessionKey.test(session)) throw new Error('Invalid session identity.')
    if (create) await mkdir(this.home, { recursive: true, mode: 0o700 })
    return directory(await directory(await realpath(this.home), 'docwen-dsh', create), hash(session), create)
  }
  async staging(session: string) {
    return mkdtemp(path.join(await this.root(session, true), '.staging-'))
  }
  async exists(session: string, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid document result identity.')
    try {
      await lstat(path.join(await this.root(session), id))
      return true
    } catch (error) {
      if (absent(error)) return false
      throw error
    }
  }
  async publish(session: string, from: string, result: Result, signal: AbortSignal) {
    const root = await this.root(session)
    await writeFile(path.join(from, 'result.json'), JSON.stringify(result), { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    await rename(from, path.join(root, result.id))
  }
  async get(session: string, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid document result identity.')
    const folder = await directory(await this.root(session), id, false)
    const result = await readResult(await fileWithin(folder, path.join(folder, 'result.json')))
    if (result.id !== id) throw new Error('The saved result has an unexpected identity.')
    return { result, files: await directory(folder, 'files', false) }
  }
  async list(session: string, signal: AbortSignal, before?: string): Promise<ResultPage> {
    const boundary = before === undefined ? undefined : pageKey(before)
    let root: string, names: string[]
    try {
      root = await this.root(session)
      names = await readdir(root)
    } catch (error) {
      if (absent(error)) return { results: [] }
      throw error
    }
    // The new result directory's write time comes from creating result.json
    // immediately before publication. Stat all names, parse only one page.
    const candidates: ResultKey[] = []
    for (const id of names) {
      signal.throwIfAborted()
      if (!uuid.test(id)) continue
      const stat = await lstat(path.join(root, id)).catch(error => {
        if (!absent(error)) throw error
      })
      if (!stat?.isDirectory()) continue
      const key = { time: Math.trunc(stat.mtimeMs), id }
      if (!boundary || newestFirst(key, boundary) > 0) candidates.push(key)
    }
    candidates.sort(newestFirst)
    const results: Result[] = []
    let scanned = 0
    while (results.length < PAGE_SIZE && scanned < candidates.length) {
      signal.throwIfAborted()
      const { id } = candidates[scanned++]
      try {
        results.push((await this.get(session, id)).result)
      } catch {
        // A missing or corrupt manifest must not hide healthy groups. A concurrent deletion can disappear.
        if (!(await lstat(path.join(root, id)).catch(() => undefined))) continue
        results.push({
          id,
          label: 'Unavailable result',
          created: '',
          primary: '',
          files: [],
          warnings: ['This saved result is incomplete.'],
        })
      }
    }
    const last = candidates[scanned - 1]
    return { results, next: last && scanned < candidates.length ? `${last.time}:${last.id}` : undefined }
  }
  async read(session: string, id: string, artifact: string, signal: AbortSignal) {
    const { result, files } = await this.get(session, id)
    const file = result.files.find((f) => f.id === artifact)
    if (!file) throw new Error('The selected artifact does not belong to this result.')
    return { file, bytes: await readResultFile(files, file, signal) }
  }
  async remove(session: string, id: string) {
    if (!uuid.test(id)) throw new Error('Invalid document result identity.')
    const root = await this.root(session)
    const source = path.join(root, id)
    const trash = path.join(root, '.deleted-' + randomUUID())
    await rename(source, trash)
    await rm(trash, { recursive: true, force: true })
  }
}
