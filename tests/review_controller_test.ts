import assert from 'node:assert/strict'
import {
  ReviewController,
  REVIEW_START_LEAD_MS,
  reviewPositionMs,
  type ReviewResponseRecord,
  type ReviewTurnEnd,
} from '../main/review'
import {
  DEFAULT_REVIEW_CONFIG,
  EMPTY_IDENTITY,
  type PSlot,
  type ReviewConfig,
  type ReviewState,
  type ReviewViewingStats,
} from '../main/protocol'

function harness(config: Partial<ReviewConfig> = {}, conversationMs = 300_000) {
  let now = 1_000_000
  const published: ReviewState[] = []
  const responses: ReviewResponseRecord[] = []
  /** How each turn ended, from its review_advanced log row. */
  const segments: { advancedBy: ReviewTurnEnd; pauses: number; pauseTotalMs: number }[] = []
  const events: string[] = []
  const c = new ReviewController({
    now: () => now,
    publish: (s) => published.push(s),
    log: (e) => {
      events.push(e.event)
      if (e.event === 'review_advanced') {
        const d = e.detail as { by: ReviewTurnEnd; pauses: number; pauseTotalMs: number }
        segments.push({ advancedBy: d.by, pauses: d.pauses, pauseTotalMs: d.pauseTotalMs })
      }
    },
    writeResponse: (r) => responses.push(r),
    identity: (slot) => ({ ...EMPTY_IDENTITY, name: slot === 'P1' ? 'Ana' : 'Ben', participantId: `${slot}-id` }),
  })
  const err = c.start({ ...DEFAULT_REVIEW_CONFIG, ...config }, conversationMs, { P1: true, P2: true })
  return {
    c,
    err,
    published,
    responses,
    segments,
    events,
    advance(ms: number) {
      now += ms
      c.tick()
    },
    get now() {
      return now
    },
    readyBoth() {
      c.ready('P1', c.state.loadSeq)
      c.ready('P2', c.state.loadSeq)
    },
  }
}

const stats = (o: Partial<ReviewViewingStats> = {}): ReviewViewingStats => ({
  msAltered: 1000,
  msClean: 0,
  toggles: 0,
  edits: 3,
  versionNow: 'altered',
  firstTypedAtMs: null,
  ...o,
})

// ---- A full turn: load → play → write → both done → next turn ----
{
  const h = harness()
  assert.equal(h.err, null)
  assert.equal(h.c.state.segments.length, 4)
  assert.equal(h.c.state.status, 'loading')
  assert.equal(h.c.turnNumber, 1)

  // One ready is not enough; a stale loadSeq is ignored.
  h.c.ready('P1', h.c.state.loadSeq)
  h.c.ready('P2', h.c.state.loadSeq - 1)
  assert.equal(h.c.state.status, 'loading')
  h.c.ready('P2', h.c.state.loadSeq)
  assert.equal(h.c.state.status, 'playing')
  assert.equal(h.c.state.anchorServerMs, h.now + REVIEW_START_LEAD_MS, 'play starts slightly ahead')

  // Typing while it plays is kept as a draft; Done is refused until the clip ends.
  h.c.draft('P1', 1, 'nervous', stats())
  h.c.submit('P1', 1, 'nervous', stats())
  assert.equal(h.c.state.done.P1, false)
  assert.equal(h.responses.length, 0)

  h.advance(149_000)
  assert.equal(h.c.state.status, 'playing')
  h.advance(2000)
  assert.equal(h.c.state.status, 'writing')
  assert.equal(h.c.state.anchorPosMs, 150_000)

  h.c.submit('P1', 1, 'nervous at first', stats())
  assert.equal(h.c.state.done.P1, true)
  assert.equal(h.c.state.status, 'writing', 'waits for the partner')
  // A submit for the wrong turn is ignored.
  h.c.submit('P2', 2, 'x', stats())
  assert.equal(h.c.state.done.P2, false)
  h.c.submit('P2', 1, 'she seemed calm', stats({ toggles: 2 }))

  assert.equal(h.c.turnNumber, 2)
  assert.equal(h.c.state.status, 'loading')
  assert.equal(h.c.state.anchorPosMs, 0, 'turn 2 is P2 over the same window')
  assert.equal(h.c.state.segments[1].targetSeat, 'P2')

  const [r1, r2] = h.responses
  assert.equal(r1.writerSlot, 'P1')
  assert.equal(r1.responseType, 'self_report')
  assert.equal(r1.about.name, 'Ana')
  assert.equal(r1.text, 'nervous at first')
  assert.equal(r1.submittedBy, 'participant')
  assert.equal(r2.responseType, 'perceived')
  assert.equal(r2.stats.toggles, 2)
  assert.equal(h.segments.length, 1)
  assert.equal(h.segments[0].advancedBy, 'both_done')
  assert.equal(h.segments[0].pauses, 0)
}

// ---- Research pause holds both at the same spot and is counted ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 10_000)
  assert.equal(h.c.control('pause', 'researcher'), null)
  assert.equal(h.c.state.status, 'paused')
  assert.equal(h.c.state.anchorPosMs, 10_000)
  h.advance(5000)
  assert.equal(reviewPositionMs(h.c.state, h.now), 10_000, 'clock stays put while paused')
  assert.equal(h.c.control('resume', 'researcher'), null)
  assert.equal(h.c.state.status, 'loading', 'resume re-syncs both players first')
  h.readyBoth()
  assert.equal(h.c.state.status, 'playing')
  assert.equal(h.c.state.anchorPosMs, 10_000)
  h.advance(200_000)
  h.c.control('force-next', 'researcher')
  assert.equal(h.segments[0].pauses, 1)
  assert.equal(h.segments[0].pauseTotalMs, 5000 + REVIEW_START_LEAD_MS)
}

// ---- Participants may not pause unless the config allows it ----
{
  const h = harness()
  h.readyBoth()
  assert.equal(h.c.control('pause', 'P1'), 'Not allowed.')
  assert.equal(h.c.control('force-next', 'P1'), 'Not allowed.')
  const h2 = harness({ allowPause: true })
  h2.readyBoth()
  assert.equal(h2.c.control('pause', 'P2'), null)
  assert.equal(h2.c.state.holdReason, 'participant')
  assert.equal(h2.c.control('force-next', 'P2'), 'Not allowed.')
}

// ---- A disconnect sends both back to loading at the current position ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 30_000)
  h.c.connection('P2', false)
  assert.equal(h.c.state.status, 'loading')
  assert.equal(h.c.state.holdReason, 'disconnect')
  assert.equal(h.c.state.anchorPosMs, 30_000)
  // P1 being ready is not enough while P2 is gone.
  h.c.ready('P1', h.c.state.loadSeq)
  assert.equal(h.c.state.status, 'loading')
  h.c.connection('P2', true)
  h.c.ready('P2', h.c.state.loadSeq)
  assert.equal(h.c.state.status, 'playing')
  assert.equal(h.c.state.anchorPosMs, 30_000)
}

// ---- The researcher can start without a missing participant ----
{
  const h = harness()
  h.c.connection('P2', false)
  h.c.ready('P1', h.c.state.loadSeq)
  assert.equal(h.c.state.status, 'loading')
  assert.equal(h.c.control('play-now', 'researcher'), null)
  assert.equal(h.c.state.status, 'playing')
}

// ---- Buffering re-syncs; a stale buffering report is ignored ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 4000)
  h.c.buffering('P1', h.c.state.loadSeq - 1)
  assert.equal(h.c.state.status, 'playing')
  h.c.buffering('P1', h.c.state.loadSeq)
  assert.equal(h.c.state.status, 'loading')
  assert.equal(h.c.state.holdReason, 'buffering')
  assert.equal(h.c.state.anchorPosMs, 4000)
}

// ---- Force next saves whatever each person had typed ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 150_000)
  h.c.submit('P1', 1, 'done', stats())
  h.c.draft('P2', 1, 'half a thou', stats())
  h.c.control('force-next', 'researcher')
  assert.equal(h.responses.length, 2)
  assert.equal(h.responses[1].writerSlot, 'P2')
  assert.equal(h.responses[1].text, 'half a thou')
  assert.equal(h.responses[1].submittedBy, 'researcher_forced')
  assert.equal(h.segments[0].advancedBy, 'researcher')
  assert.equal(h.c.turnNumber, 2)
  // Drafts belong to their turn.
  assert.deepEqual(h.c.draftFor('P2'), { turn: 2, text: '', submitted: false })
}

// ---- Auto advance moves on 10 s after the clip ends ----
{
  const h = harness({ advance: 'auto' })
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 150_000)
  assert.equal(h.c.state.status, 'writing')
  assert.notEqual(h.c.state.autoAdvanceAtMs, null)
  h.advance(9000)
  assert.equal(h.c.turnNumber, 1)
  h.advance(1500)
  assert.equal(h.c.turnNumber, 2)
  assert.equal(h.responses.length, 2)
  assert.ok(h.responses.every((r) => r.submittedBy === 'auto'))
}

// ---- Restarting a turn replays it from its start ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 60_000)
  assert.equal(h.c.control('restart-turn', 'researcher'), null)
  assert.equal(h.c.state.status, 'loading')
  assert.equal(h.c.state.anchorPosMs, 0)
}

// ---- Running to the end ----
{
  const h = harness({}, 150_000)
  for (let turn = 1; turn <= 2; turn++) {
    h.readyBoth()
    h.advance(REVIEW_START_LEAD_MS + 150_000)
    for (const slot of ['P1', 'P2'] as PSlot[]) h.c.submit(slot, turn, `t${turn}`, stats())
  }
  assert.equal(h.c.state.status, 'done')
  assert.equal(h.responses.length, 4)
  assert.equal(h.segments.length, 2)
  assert.ok(h.events.includes('review_finished'))
  assert.equal(h.c.draftFor('P1'), null)
  h.c.stop()
  assert.equal(h.c.state.status, 'idle')
  assert.equal(h.c.active, false)
}

// ---- Ending mid-turn keeps what was written ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 150_000)
  h.c.submit('P1', 1, 'saved already', stats())
  h.c.draft('P2', 1, 'still typing', stats({ toggles: 3 }))
  h.c.stop()
  assert.equal(h.responses.length, 2)
  assert.equal(h.responses[1].writerSlot, 'P2')
  assert.equal(h.responses[1].text, 'still typing')
  assert.equal(h.responses[1].submittedBy, 'review_ended')
  assert.equal(h.responses[1].stats.toggles, 3)
  assert.equal(h.segments.length, 1)
  assert.equal(h.segments[0].advancedBy, 'review_ended')
  // Ending after the last turn adds nothing.
  const done = harness({}, 150_000)
  for (let turn = 1; turn <= 2; turn++) {
    done.readyBoth()
    done.advance(REVIEW_START_LEAD_MS + 150_000)
    for (const slot of ['P1', 'P2'] as PSlot[]) done.c.submit(slot, turn, 'x', stats())
  }
  done.c.stop()
  assert.equal(done.responses.length, 4)
  assert.equal(done.segments.length, 2)
}

// ---- A participant cannot resume the researcher's pause ----
{
  const h = harness({ allowPause: true })
  h.readyBoth()
  h.c.control('pause', 'researcher')
  assert.equal(h.c.control('resume', 'P1'), 'Paused by the researcher.')
  assert.equal(h.c.state.status, 'paused')
  assert.equal(h.c.control('resume', 'researcher'), null)
  // …but either participant can resume a participant's pause.
  h.readyBoth()
  h.c.control('pause', 'P1')
  assert.equal(h.c.control('resume', 'P2'), null)
}

// ---- Moving on mid-clip does not count as a pause in the next turn ----
{
  const h = harness()
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 3000)
  h.c.control('force-next', 'researcher')
  h.readyBoth()
  h.advance(REVIEW_START_LEAD_MS + 150_000)
  h.c.control('force-next', 'researcher')
  assert.equal(h.segments[1].pauses, 0)
  assert.equal(h.segments[1].pauseTotalMs, 0)
}

// ---- Too short to review ----
{
  const h = harness({}, 200)
  assert.equal(h.err, 'The recording is too short to review.')
  assert.equal(h.c.active, false)
}

console.log('review controller checks passed')
