import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export const name = 'docwen-test-history'
export const inject = ['sessions', 'attachments', 'connection', 'agents', 'tools', 'sessionQuery']

// Only installed into a disposable test profile. Use DSH's session and attachment
// stores so downstream consumers see committed events and a real stored image.
const redPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAYAAAAGCAIAAABvrngfAAAAEklEQVR4nGP8z4AOmDBEqCoEAHOtAQvMuQmAAAAAAElFTkSuQmCC'

export function apply(ctx) {
  const sessionId = process.env.DOCWEN_SMOKE_SESSION
  if (!sessionId) return
  let seeded = false
  let replyId
  // Exercise the installed tool executor at an open turn without a provider account.
  const stopToolProbe = ctx.connection.fetch.register({
    path: '/api/docwen-smoke-tool',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const agent = ctx.agents.get(sessionId)
      if (!agent || !replyId) return new Response(null, { status: 409 })
      const callId = 'docwen-test-' + randomUUID()
      const session = agent.session
      const split = new URL(request.url, 'http://localhost').searchParams.get('case') === 'split'
      const turn = split ? 3 : 2
      const options = split
        ? { action: 'process', capabilityId: 'split.pdf.every_page', sources: [{ kind: 'workspace', path: 'two-pages.pdf' }], options: {} }
        : { action: 'export', messageIds: [replyId], options: {} }
      session.append('turn/start', { turn })
      try {
        const batch = await ctx.tools.execute({
          agent,
          signal: request.signal,
          calls: [
            {
              type: 'tool-call',
              id: callId,
              name: 'docwen',
              arguments: JSON.stringify(options),
            },
          ],
        })
        const { events } = await ctx.sessionQuery.readSession(sessionId)
        const presentations = events.filter(
          (e) => e.type === 'deliverables/presented' && e.data.callId === callId,
        )
        return Response.json({
          successful: batch.results.length === 1 && batch.results[0].result.isError === false,
          deliveries: await Promise.all(presentations.map(async (e) => ({
            turn: e.data.turn, count: e.data.files.length,
            ...(split ? { files: await Promise.all(e.data.files.map(async (file) => ({
              name: path.basename(file.path),
              sha256: createHash('sha256').update(await readFile(file.path)).digest('hex'),
            }))) } : {}),
          }))),
        })
      } finally {
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    },
  })
  ctx.effect(() => stopToolProbe, 'Release the test tool-execution route')
  const unregister = ctx.connection.fetch.register({
    path: '/api/docwen-smoke-seed',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      const session = ctx.sessions.get(sessionId)
      if (seeded || !session) return new Response(null, { status: 409 })
      seeded = true
      const [attachment] = await ctx.attachments.saveImages([
        { data: Buffer.from(redPng, 'base64'), mediaType: 'image/png', name: 'session.png' },
      ])
      const messageId = randomUUID()
      replyId = messageId
      const markdown = [
        '# Release review',
        '',
        'The historic reply includes two pictures.',
        '',
        '![Session](dsh-attachment:' + attachment.attachmentId + ')',
        '',
        '![Workspace](figure.png)',
        '',
        '# Follow-up',
        '',
        'The second section.',
      ].join('\n')
      session.append('turn/start', { turn: 1 })
      session.append(
        'user/message',
        {
          id: randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: 'Review these images.' },
            { type: 'image', attachment },
          ],
        },
        { surfaceOp: 'append' },
      )
      session.append('step/start', { turn: 1, step: 1 })
      const stream = [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [], texts: [markdown] }]
      session.append(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          stream,
          message: {
            id: messageId,
            role: 'assistant',
            source: { kind: 'model', provider: 'fixture', model: 'fixture' },
            content: [{ type: 'text', text: markdown }],
          },
        },
        { surfaceOp: 'append' },
      )
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      return Response.json({ messageId })
    },
  })
  ctx.effect(() => unregister, 'Release the test fixture route')
}
