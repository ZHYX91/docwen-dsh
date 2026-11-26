import assert from 'node:assert/strict'
import { test } from 'node:test'
import { completedReply, visibleAttachments } from '../src/history.js'

type Json = Record<string, unknown>
const start = (turn: number) => ({ type: 'turn/start', data: { turn } })
const end = (turn: number, kind: string) => ({ type: 'turn/end', data: { turn, reason: { kind } } })
const asset = (attachmentId: string, mediaType = 'image/png') => ({ attachmentId, mediaType, bytes: 4 })
const image = (attachment: Json) => ({ type: 'image', attachment })
const text = (value: string) => ({ type: 'text', text: value })
const user = (turn: number, content: Json[], kind = 'user') => ({
  type: 'user/message', surfaceOp: 'append', data: { turn, step: 1, source: { kind }, content },
})
const reply = (turn: number, id: string, content: Json[], extra: Json = {}) => ({
  type: 'assistant/message', surfaceOp: 'append', data: { turn, step: 1, message: { id, content }, ...extra },
})

test('a reply can reuse earlier assistant images and excludes future, failed, and tool-only resources', () => {
  const supplied = asset('source')
  const first = asset('old-assistant')
  const own = asset('current-assistant')
  const file = asset('document', 'application/pdf')
  const later = asset('future')
  const events = [
    start(1), user(1, [image(supplied), { type: 'file', attachment: file }]),
    reply(1, 'tool-step', [image(asset('tool-only')), { type: 'tool-call' }]),
    reply(1, 'first', [image(first)]), end(1, 'completed'),
    start(2), reply(2, 'broken', [image(asset('failed'))]), end(2, 'error'),
    start(3), user(3, [image(asset('injected'))], 'retry'),
    reply(3, 'selected', [text('![Again](dsh-attachment:old-assistant)'), image(own)]),
    end(3, 'completed'),
    start(4), user(4, [image(later)]), reply(4, 'pending', [image(asset('in-flight'))]),
  ]
  assert.deepEqual(completedReply(events, 'selected'), {
    markdown: '![Again](dsh-attachment:old-assistant)\n\n![Image](dsh-attachment:current-assistant)',
    refs: [supplied, first, own],
  })
  assert.deepEqual(visibleAttachments(events), [
    { type: 'image', attachment: supplied }, { type: 'file', attachment: file },
    { type: 'image', attachment: first }, { type: 'image', attachment: own }, { type: 'image', attachment: later },
  ])
  for (const id of ['tool-step', 'broken', 'pending']) assert.throws(() => completedReply(events, id), /not a completed/)
})

test('a fork retains completed IDs and excludes its synthetically closed open tail and parent-only messages', () => {
  const old = asset('before-cut')
  const prefix = [
    start(1), reply(1, 'retained', [image(old)]), end(1, 'completed'),
    start(2), reply(2, 'cut', [image(asset('cut'))]),
  ]
  const parent = [...prefix, end(2, 'completed'), start(3), reply(3, 'parent-only', [text('Original')]), end(3, 'completed')]
  const child = [
    ...prefix, { type: 'session/end-seed', data: { inherited: true } }, end(2, 'forked'),
    start(3), reply(3, 'regenerated', [text('Replacement')]), end(3, 'completed'),
  ]
  assert.equal(completedReply(parent, 'parent-only').markdown, 'Original')
  assert.deepEqual(completedReply(child, 'retained'), completedReply(parent, 'retained'))
  assert.deepEqual(completedReply(child, 'regenerated'), { markdown: 'Replacement', refs: [old] })
  assert.deepEqual(visibleAttachments(child), [{ type: 'image', attachment: old }])
  for (const id of ['cut', 'parent-only']) assert.throws(() => completedReply(child, id))
  assert.throws(() => completedReply(parent, 'regenerated'))
})
