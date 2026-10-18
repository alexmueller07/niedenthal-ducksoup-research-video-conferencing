// Three real WebSocket clients against a real SessionServer: start a review,
// play a turn, write, reconnect, force on, and check the CSVs.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'
import { SessionServer } from '../main/server'
import { SessionLogger } from '../main/logger'
import { EMPTY_IDENTITY } from '../main/protocol'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Split one CSV line, honouring quotes. */
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

async function client(url: string, role: 'admin' | 'participant', id: string) {
  const ws = new WebSocket(url)
  const messages: any[] = []
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const send = (msg: unknown) => ws.send(JSON.stringify(msg))
  /** Next message of this type matching the filter (older ones are discarded). */
  const take = async (type: string, filter = (_m: any) => true) => {
    for (let i = 0; i < 700; i++) {
      const index = messages.findIndex((m) => m.type === type && filter(m))
      if (index >= 0) return messages.splice(0, index + 1).pop()
      await sleep(20)
    }
    throw new Error(`${id}: timed out waiting for ${type}; got ${messages.map((m) => m.type)}`)
  }
  send({
    type: 'hello',
    role,
    identity: { ...EMPTY_IDENTITY, name: id, participantId: `${id}-pid`, dyadId: 'D7' },
    appVersion: 'test',
  })
  const welcome = await take('welcome')
  return { ws, send, take, messages, slot: welcome.slot as string }
}

const root = await mkdtemp(path.join(os.tmpdir(), 'review-session-'))
const logger = await SessionLogger.create(root)
const server = new SessionServer(0, logger)

// Stand-in recordings: P1 and P2, altered and clean, 25 s each.
const files: Record<string, string> = {}
for (const slot of ['P1', 'P2']) {
  for (const kind of ['altered', 'clean']) {
    const p = path.join(root, `${slot}_${kind}.mp4`)
    await writeFile(p, Buffer.alloc(2048, slot === 'P1' ? 1 : 2))
    files[`${slot}:${kind}`] = p
  }
}
server.setReviewFixture(
  Object.entries(files).map(([key, p]) => {
    const [slot, kind] = key.split(':') as ['P1' | 'P2', 'altered' | 'clean']
    return { slot, kind, path: p, offsetMs: slot === 'P2' ? 120 : 0, durationMs: 25_000 }
  }),
)
await server.start()
const port = (server as any).http.address().port
const url = `ws://127.0.0.1:${port}`
const clients: Awaited<ReturnType<typeof client>>[] = []

try {
  const admin = await client(url, 'admin', 'RA')
  clients.push(admin)
  let p1 = await client(url, 'participant', 'Ana')
  const p2 = await client(url, 'participant', 'Ben')
  clients.push(p1, p2)

  // Not before the conversation has ended.
  let avail = await admin.take('review-availability')
  assert.equal(avail.availability.canStart, false)
  admin.send({ type: 'review-start', config: {} })
  assert.match((await admin.take('review-error')).reason, /End the conversation/)

  admin.send({ type: 'set-phase', phase: 'live' })
  await p1.take('phase', (m) => m.phase === 'live')
  admin.send({ type: 'set-phase', phase: 'ended' })
  avail = await admin.take('review-availability', (m) => m.availability.canStart)
  assert.equal(avail.availability.conversationMs, 25_120)

  // A participant cannot start it; set-phase cannot jump into it.
  p1.send({ type: 'review-start', config: {} })
  p1.send({ type: 'set-phase', phase: 'review' })
  await sleep(100)
  assert.equal(server.currentPhase, 'ended')

  admin.send({
    type: 'review-start',
    config: { segmentSec: 10, minTailSec: 3, viewMode: 'gallery', showOriginal: true },
  })
  await p1.take('phase', (m) => m.phase === 'review')
  const media = (await p1.take('review-media')).media
  assert.equal(media.P1.altered.length, 1)
  assert.equal(media.P2.clean[0].offsetMs, 120)
  let state = (await p1.take('review-state')).state
  assert.equal(state.status, 'loading')
  // 25.12 s at 10 s windows: 0-10, 10-20, 20-25.12 → 6 turns.
  assert.equal(state.segments.length, 6)
  assert.equal(state.config.viewMode, 'gallery')

  // The recording is reachable over HTTP with the link from the media list.
  const video = await fetch(`http://127.0.0.1:${port}${media.P1.altered[0].url}`, {
    headers: { Range: 'bytes=0-9' },
  })
  assert.equal(video.status, 206)
  assert.equal((await video.arrayBuffer()).byteLength, 10)

  // set-phase cannot jump from the review back into a live call.
  admin.send({ type: 'set-phase', phase: 'live' })
  await sleep(100)
  assert.equal(server.currentPhase, 'review')

  // Both ready → playing.
  p1.send({ type: 'review-ready', loadSeq: state.loadSeq })
  p2.send({ type: 'review-ready', loadSeq: state.loadSeq })
  state = (await p2.take('review-state', (m) => m.state.status === 'playing')).state

  // Participants cannot pause unless allowed.
  p2.send({ type: 'review-control', action: 'pause' })
  assert.equal((await p2.take('review-error')).reason, 'Not allowed.')

  // P1 types, drops, and gets the draft back on reconnect. The turn waits.
  const stats = { msAltered: 500, msClean: 200, toggles: 1, edits: 4, versionNow: 'clean', firstTypedAtMs: Date.now() }
  p1.send({ type: 'review-draft', turn: 1, text: 'a bit tense', stats })
  await sleep(50)
  p1.ws.close()
  state = (await p2.take('review-state', (m) => m.state.holdReason === 'disconnect')).state
  assert.equal(state.status, 'loading')
  p1 = await client(url, 'participant', 'Ana')
  clients.push(p1)
  assert.equal(p1.slot, 'P1', 'same seat back')
  const draft = await p1.take('review-draft')
  assert.deepEqual([draft.turn, draft.text, draft.submitted], [1, 'a bit tense', false])
  state = (await p1.take('review-state')).state
  p1.send({ type: 'review-ready', loadSeq: state.loadSeq })
  p2.send({ type: 'review-ready', loadSeq: state.loadSeq })
  await p1.take('review-state', (m) => m.state.status === 'playing')

  // Viewing switches are logged.
  p1.send({ type: 'review-view', turn: 1, mode: 'gallery', person: 'both', version: 'both', positionMs: 1234 })

  // Wait for the 10 s clip to end, then both press Done.
  state = (await p1.take('review-state', (m) => m.state.status === 'writing')).state
  p1.send({ type: 'review-submit', turn: 1, text: 'a bit tense, then fine', stats })
  p2.send({ type: 'review-submit', turn: 1, text: 'Ana seemed relaxed', stats: { ...stats, toggles: 0 } })
  state = (await admin.take('review-state', (m) => m.state.current === 1)).state
  assert.equal(state.status, 'loading')
  assert.equal(state.segments[1].targetSeat, 'P2')

  // Researcher forces turn 2 along with nothing typed.
  admin.send({ type: 'review-control', action: 'force-next' })
  await admin.take('review-state', (m) => m.state.current === 2)

  // Ending the review turns the media link off and returns to ended.
  admin.send({ type: 'set-phase', phase: 'ended' })
  assert.equal((await p1.take('review-media')).media, null)
  await p1.take('phase', (m) => m.phase === 'ended')
  assert.equal(
    (await fetch(`http://127.0.0.1:${port}${media.P1.altered[0].url}`)).status,
    403,
  )

  // A second review with the original video off: participants are never even
  // given the original files; the researcher's preview still has them.
  admin.send({ type: 'review-start', config: { segmentSec: 10, minTailSec: 3, showOriginal: false } })
  const p2Media = (await p2.take('review-media', (m) => m.media !== null)).media
  const adminMedia = (await admin.take('review-media', (m) => m.media !== null)).media
  assert.equal(p2Media.P1.clean.length, 0)
  assert.equal(p2Media.P2.clean.length, 0)
  assert.equal(p2Media.P1.altered.length, 1)
  assert.equal(adminMedia.P1.clean.length, 1)
  assert.notEqual(
    adminMedia.P1.altered[0].url.split('/')[2],
    p2Media.P1.altered[0].url.split('/')[2],
    'participants and the researcher get different links',
  )
  for (const part of [...p2Media.P1.altered, ...p2Media.P2.altered]) {
    assert.match(part.url, /^\/review\/[0-9a-f]{32}\/\d+\.mp4$/, 'links do not say which file is which')
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}${adminMedia.P1.clean[0].url}`)).status, 200)
  // Ended straight away: both unanswered turn-1 rows are kept.
  admin.send({ type: 'set-phase', phase: 'ended' })
  await p2.take('phase', (m) => m.phase === 'ended')

  await sleep(100)
  await server.stop()

  const responses = (await readFile(path.join(logger.dir, 'review_responses.csv'), 'utf-8')).trim().split('\n')
  assert.equal(
    responses.length,
    1 + 2 + 2 + 2 + 2,
    'header + turn 1 answers + turn 2 forced + turn 3 ended mid-turn + review 2 ended at once',
  )
  const header = responses[0].split(',')
  const row = (line: string) => {
    const c = cells(line)
    return Object.fromEntries(header.map((h, i) => [h, c[i]]))
  }
  const r1 = row(responses[1])
  assert.equal(r1.review_number, '1')
  assert.equal(r1.pair_id, 'D7')
  assert.equal(r1.segment_number, '1')
  assert.equal(r1.about_seat, 'P1')
  assert.equal(r1.writer_seat, 'P1')
  assert.equal(r1.response_type, 'self_report')
  assert.equal(r1.view_mode, 'gallery')
  assert.equal(r1.version_at_submit, 'clean')
  assert.equal(r1.submitted_by, 'participant')
  assert.equal(r1.response_text, 'a bit tense, then fine')
  assert.equal(r1.toggle_count, '1')
  assert.equal(row(responses[2]).response_type, 'perceived')
  assert.equal(row(responses[3]).submitted_by, 'researcher_forced')
  assert.equal(row(responses[3]).segment_number, '2')
  assert.equal(row(responses[5]).submitted_by, 'review_ended')
  assert.equal(row(responses[5]).segment_number, '3')
  assert.equal(row(responses[7]).review_number, '2')
  assert.equal(row(responses[7]).submitted_by, 'review_ended')

  const segments = (await readFile(path.join(logger.dir, 'review_segments.csv'), 'utf-8')).trim().split('\n')
  assert.equal(segments.length, 1 + 3 + 1)
  assert.deepEqual(cells(segments[1]).slice(-3, -1), ['both_done', '1'], 'turn 1 was held once by the disconnect')
  assert.deepEqual(cells(segments[2]).slice(-3), ['researcher', '0', '0'])
  assert.equal(cells(segments[3]).slice(-3)[0], 'review_ended')
  assert.deepEqual(cells(segments[4]).slice(0, 2), ['2', '1'])

  const viewing = (await readFile(path.join(logger.dir, 'review_viewing.csv'), 'utf-8')).trim().split('\n')
  assert.equal(viewing.length, 2)
  const v = cells(viewing[1])
  assert.deepEqual([...v.slice(0, 4), ...v.slice(-4)], ['1', 'P1', 'Ana-pid', '1', '1234', 'gallery', 'both', 'both'])

  const info = JSON.parse(await readFile(path.join(logger.dir, 'review.json'), 'utf-8'))
  assert.equal(info.reviews.length, 2)
  assert.equal(info.reviews[0].reviewNumber, 1)
  assert.equal(info.reviews[1].config.showOriginal, false)
  assert.equal(info.reviews[0].segments.length, 6)
  assert.equal(info.reviews[0].recordings.length, 4)

  const events = await readFile(path.join(logger.dir, 'events.csv'), 'utf-8')
  for (const e of ['moved_to_review', 'review_started', 'review_turn_started', 'review_clip_finished', 'review_ended', 'review_closed']) {
    assert.ok(events.includes(e), `events.csv has ${e}`)
  }
  assert.ok(events.includes('blocked_action'), 'participant review-start is logged as blocked')
  assert.equal(events.split('conversation_ended').length - 1, 1, 'leaving a review is not logged as the call ending')
} finally {
  for (const c of clients) c.ws.close()
  await server.stop().catch(() => {})
}

console.log('review server checks passed')
