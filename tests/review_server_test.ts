// Three real WebSocket clients against a real SessionServer: start a review,
// play a turn, write, reconnect, force on, and check the CSVs.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
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

  admin.send({ type: 'study-schedule-arm', presetId: 'smile-subtle', firstSeat: 'P2' })
  assert.equal((await admin.take('study-schedule-state', m => m.state.status === 'armed')).state.firstSeat, 'P2')
  admin.send({ type: 'set-phase', phase: 'live' })
  assert.equal((await admin.take('study-schedule-state', m => m.state.status === 'running')).state.block, 0)
  await p1.take('phase', (m) => m.phase === 'live')
  admin.send({ type: 'apply-preset', slot: 'P1', presetId: 'smile-strong', effects: { alpha: 0.5, voiceSemitones: 0, voiceSmile: 0 } })
  assert.match((await admin.take('study-schedule-error')).reason, /armed or active/)
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

  // The pilot task locks the source pairing per viewer and saves questionnaire
  // and continuous samples before accepting an acknowledgement.
  admin.send({ type: 'review-start', config: { task: 'continuous', mediaPolicy: 'altered', segmentSec: 10 } })
  const ratingP1 = (await p1.take('review-media', m => m.media?.P1.clean.length === 1)).media
  const ratingP2 = (await p2.take('review-media', m => m.media !== null)).media
  assert.equal(ratingP1.P1.clean.length, 1)
  assert.equal(ratingP1.P1.altered.length, 0)
  assert.equal(ratingP1.P2.altered.length, 1)
  assert.equal(ratingP1.P2.clean.length, 0)
  assert.equal(ratingP2.P2.clean.length, 1)
  assert.equal(ratingP2.P1.altered.length, 1)
  assert.notEqual(ratingP1.P1.clean[0].url.split('/')[2], ratingP2.P1.altered[0].url.split('/')[2])
  const unlisted = ratingP1.P1.clean[0].url.replace(/\/\d+\.mp4$/, '/3.mp4')
  assert.equal((await fetch(`http://127.0.0.1:${port}${unlisted}`)).status, 404)
  state = (await p1.take('review-state', m => m.state.status === 'questionnaire')).state
  assert.equal(state.config.mediaPolicy, 'self-clean-partner-altered')
  p1.send({ type: 'review-control', action: 'restart-turn' })
  assert.match((await p1.take('review-error')).reason, /cannot be replayed/)
  admin.send({ type: 'review-control', action: 'force-next' })
  assert.match((await admin.take('review-error')).reason, /cannot be replayed/)
  const questionnaireAnswers = Object.fromEntries([
    'influence_partner', 'influenced_by_partner', 'predict_partner', 'flow', 'enjoyment',
    'fits_with_friends', 'friendship', 'comfort', 'self_focus', 'relative_talking',
  ].map(id => [id, id === 'relative_talking' ? 0 : 5]))
  p1.send({ type: 'rating-questionnaire', responses: questionnaireAnswers })
  p2.send({ type: 'rating-questionnaire', responses: questionnaireAnswers })
  state = (await p1.take('review-state', m => m.state.status === 'loading')).state
  p1.send({ type: 'review-ready', loadSeq: state.loadSeq })
  p2.send({ type: 'review-ready', loadSeq: state.loadSeq })
  await p1.take('review-state', m => m.state.status === 'playing')
  await sleep(900)
  p1.send({ type: 'rating-samples', turn: 1, samples: [{ sequence: 0, videoMs: 100, value: 52, touched: true }] })
  assert.equal((await p1.take('rating-ack')).sequence, 0)
  p1.send({ type: 'rating-samples', turn: 1, samples: [{ sequence: 0, videoMs: 100, value: 52, touched: true }] })
  assert.equal((await p1.take('rating-ack')).sequence, 0)
  admin.send({ type: 'set-phase', phase: 'ended' })
  await p1.take('phase', m => m.phase === 'ended')
  admin.send({ type: 'review-start', config: { task: 'continuous' } })
  assert.match((await admin.take('review-error')).reason, /already started/)

  await sleep(100)
  await server.stop()

  const ratingDir = path.join(logger.dir, 'review_3')
  const ratingAnswers = await readFile(path.join(ratingDir, 'questionnaire.csv'), 'utf-8')
  const ratingSamples = await readFile(path.join(ratingDir, 'samples.csv'), 'utf-8')
  assert.equal(ratingAnswers.trim().split('\n').length, 21)
  assert.equal(ratingSamples.trim().split('\n').length, 2, 'retry does not duplicate saved samples')

  const csv = async (...parts: string[]) => {
    const lines = (await readFile(path.join(logger.dir, ...parts), 'utf-8')).trim().split('\n')
    const header = cells(lines[0])
    return lines.slice(1).map((line) => {
      const c = cells(line)
      return Object.fromEntries(header.map((h, k) => [h, c[k]]))
    })
  }

  // Each review gets its own folder; nothing about the review sits loose at the top.
  const top = await readdir(logger.dir)
  assert.ok(top.includes('review') && top.includes('review_2'))
  assert.ok(!top.some((f) => f.startsWith('review_') && f.endsWith('.csv')), 'no loose review files')
  assert.ok(!top.includes('review.json'))

  const answers = await csv('review', 'answers.csv')
  assert.equal(answers.length, 2 + 2 + 2, 'turn 1 answers + turn 2 forced + turn 3 ended mid-turn')
  assert.deepEqual(answers[0], {
    pair_id: 'D7',
    turn: '1',
    clip_from: '0:00',
    clip_to: '0:10',
    whose_video: 'Ana-pid',
    written_by: 'Ana-pid',
    question: 'their own feelings',
    answer: 'a bit tense, then fine',
    how_saved: 'pressed Done',
    date: answers[0].date,
    time: answers[0].time,
    view: 'gallery',
    seconds_on_original_video: '0',
    switches_between_videos: '1',
  })
  assert.equal(answers[1].question, "their partner's feelings")
  assert.equal(answers[1].written_by, 'Ben-pid')
  assert.equal(answers[2].how_saved, 'researcher moved on')
  assert.equal(answers[2].turn, '2')
  assert.equal(answers[2].whose_video, 'Ben-pid')
  assert.equal(answers[4].how_saved, 'review ended early')
  assert.equal(answers[4].turn, '3')

  const second = await csv('review_2', 'answers.csv')
  assert.equal(second.length, 2)
  assert.equal(second[0].seconds_on_original_video, '', 'blank when the original was not shown')
  assert.equal(second[0].switches_between_videos, '')

  const settings = await readFile(path.join(logger.dir, 'review', 'settings.txt'), 'utf-8')
  assert.match(settings, /View:\s+gallery/)
  assert.match(settings, /Turn length:\s+10 seconds/)
  assert.match(settings, /Goes first:\s+Ana \(P1\)/)
  assert.match(settings, /Original video shown:\s+yes/)
  assert.match(settings, /Conversation reviewed:\s+0:25, in 6 turns/)
  assert.match(await readFile(path.join(logger.dir, 'review_2', 'settings.txt'), 'utf-8'), /Original video shown:\s+no/)

  const events = await readFile(path.join(logger.dir, 'events.csv'), 'utf-8')
  for (const e of ['moved_to_review', 'review_started', 'review_turn_started', 'review_clip_finished', 'review_ended', 'review_closed']) {
    assert.ok(events.includes(e), `events.csv has ${e}`)
  }
  assert.ok(events.includes('blocked_action'), 'participant review-start is logged as blocked')
  assert.equal(events.split('conversation_ended').length - 1, 1, 'leaving a review is not logged as the call ending')
  assert.ok(events.includes('""by"":""both_done"",""pauses"":1'), 'turn 1 summary: done by both, held once by the disconnect')
} finally {
  for (const c of clients) c.ws.close()
  await server.stop().catch(() => {})
}

console.log('review server checks passed')
