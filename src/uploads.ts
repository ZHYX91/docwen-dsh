import { Busboy } from '@fastify/busboy'
import { createWriteStream } from 'node:fs'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { MAX_DOCUMENT, MAX_FILES_PER_TASK, MAX_RESULT } from './limits.js'

export const MAX_JSON = 256 * 1024
const MAX_MULTIPART = MAX_RESULT + 1024 * 1024

export class TooLarge extends Error {}

export interface StagedUpload { name: string; path: string; size: number }

export async function receiveUploads(request: Request, contentType: string, root: string, signal: AbortSignal) {
  if (!request.body) throw new Error('The request contains no input.')
  if (Number(request.headers.get('content-length') ?? 0) > MAX_MULTIPART)
    throw new TooLarge('The upload exceeds the total request size limit.')

  const parser = new Busboy({
    headers: { 'content-type': contentType },
    preservePath: true,
    limits: { fields: 1, files: MAX_FILES_PER_TASK, fileSize: MAX_DOCUMENT + 1,
      fieldSize: MAX_JSON + 1, fieldNameSize: 64, headerSize: 8192 },
  })
  const stop = new AbortController()
  const inputSignal = AbortSignal.any([signal, stop.signal])
  const uploads = new Map<string, StagedUpload>()
  const writes: Promise<void>[] = []
  let intent: string | undefined
  let payloadSize = 0
  let wireSize = 0
  const fail = (error: unknown) => stop.abort(error)
  parser.on('fieldsLimit', () => fail(new Error('The request must contain exactly one operation.')))
  parser.on('filesLimit', () => fail(new TooLarge('The request contains too many files.')))
  parser.on('field', (key, value, truncatedName, truncatedValue) => {
    if (key !== 'intent' || truncatedName || intent !== undefined)
      fail(new Error('Invalid file operation.'))
    else if (truncatedValue || Buffer.byteLength(value) > MAX_JSON)
      fail(new TooLarge('The file operation exceeds the request size limit.'))
    else intent = value
  })
  parser.on('file', (key, input, name) => {
    if (!/^file\d{1,2}$/u.test(key) || !name || uploads.has(key)) {
      input.resume()
      fail(new Error('Invalid or duplicate file upload.'))
      return
    }
    const file = { name, path: path.join(root, key), size: 0 }
    uploads.set(key, file)
    input.on('limit', () => fail(new TooLarge('An upload exceeds the file size limit.')))
    const measure = new Transform({ transform(chunk: Buffer, _encoding, next) {
      file.size += chunk.length
      payloadSize += chunk.length
      if (file.size > MAX_DOCUMENT || payloadSize > MAX_RESULT)
        next(new TooLarge('The upload exceeds the file size limit.'))
      else next(null, chunk)
    } })
    const sink = createWriteStream(file.path, { flags: 'wx', mode: 0o600 })
    writes.push(pipeline(input, measure, sink, { signal: inputSignal }).catch(fail))
  })

  const measureRequest = new Transform({ transform(chunk: Buffer, _encoding, next) {
    wireSize += chunk.length
    if (wireSize > MAX_MULTIPART) next(new TooLarge('The upload exceeds the total request size limit.'))
    else next(null, chunk)
  } })
  try {
    await pipeline(Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>),
      measureRequest, parser, { signal: inputSignal })
  } catch (error) {
    fail(error)
  } finally {
    await Promise.all(writes)
  }
  signal.throwIfAborted()
  stop.signal.throwIfAborted()
  if (intent === undefined) throw new Error('Missing file operation.')
  return { intent, uploads }
}
