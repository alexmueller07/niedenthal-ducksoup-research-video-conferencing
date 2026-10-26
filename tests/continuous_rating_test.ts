import assert from 'node:assert/strict'
import { ReviewController, REVIEW_START_LEAD_MS, buildSegments, parseReviewConfig } from '../main/review'
import { POST_CONVERSATION_ITEMS } from '../main/ratingTask'
import { EMPTY_IDENTITY, type PSlot, type RatingSample, type ReviewConfig, type ReviewResponseRecord } from '../main/protocol'

const config: ReviewConfig = parseReviewConfig({ task: 'continuous', mediaPolicy: 'altered', allowPause: true, advance: 'auto', segmentSec: 150 })
assert.equal(config.mediaPolicy, 'self-clean-partner-altered')
assert.equal(config.allowPause, false)
assert.equal(config.advance, 'both-done')
assert.equal(buildSegments(600_000, config).length, 4)
assert.deepEqual(buildSegments(600_000, config).map(s => s.targetSeat), ['P1', 'P2', 'P1', 'P2'])
assert.equal(buildSegments(470_000, config)[3].endMs, 470_000, 'short final part stays separate')

let now = 1_000_000
const savedQuestions: PSlot[] = []
const savedSamples: { slot: PSlot; turn: number; samples: RatingSample[] }[] = []
const responses: ReviewResponseRecord[] = []
const controller = new ReviewController({
  now: () => now,
  publish: () => {},
  log: () => {},
  identity: slot => ({ ...EMPTY_IDENTITY, participantId: slot }),
  writeQuestionnaire: slot => savedQuestions.push(slot),
  writeSamples: (slot, segment, samples) => savedSamples.push({ slot, turn: segment.index, samples }),
  writeResponse: record => responses.push(record),
})
assert.equal(controller.start(config, 600_000, { P1: true, P2: true }), null)
assert.equal(controller.state.status, 'questionnaire')
assert.equal(controller.control('restart-turn', 'researcher'), 'Rating tasks cannot be replayed or skipped.')
assert.equal(controller.control('play-now', 'researcher'), 'Rating tasks cannot be replayed or skipped.')
assert.equal(controller.control('force-next', 'researcher'), 'Rating tasks cannot be replayed or skipped.')
assert.equal(controller.control('pause', 'P1'), 'Rating tasks cannot be replayed or skipped.')

const questionnaire = Object.fromEntries(POST_CONVERSATION_ITEMS.map(([id]) => [id, id === 'relative_talking' ? -1 : 5]))
assert.equal(controller.questionnaire('P1', { ...questionnaire, flow: 11 }), false)
assert.equal(controller.questionnaire('P1', questionnaire), true)
assert.equal(controller.state.status, 'questionnaire')
assert.equal(controller.questionnaire('P1', questionnaire), false, 'duplicate response refused')
assert.equal(controller.questionnaire('P2', questionnaire), true)
assert.deepEqual(savedQuestions, ['P1', 'P2'])
assert.equal(controller.state.status, 'loading')

for (let turn = 1; turn <= 4; turn++) {
  const segment = controller.state.segments[turn - 1]
  assert.equal(segment.index, turn)
  controller.ready('P1', controller.state.loadSeq)
  assert.equal(controller.state.status, 'loading', 'wait for both screens')
  controller.ready('P2', controller.state.loadSeq)
  assert.equal(controller.state.status, 'playing')
  now += REVIEW_START_LEAD_MS + 2_000
  const first: RatingSample = { sequence: 0, videoMs: segment.startMs + 1000, value: 50, touched: false }
  assert.equal(controller.samples('P1', turn, [first]), 0)
  assert.equal(controller.samples('P1', turn, [first]), 0, 'retry does not duplicate rows')
  assert.equal(controller.samples('P1', turn, [{ sequence: 2, videoMs: segment.startMs + 1200, value: 60, touched: true }]), 0, 'missing sequence is not silently skipped')
  assert.equal(controller.samples('P1', turn, [{ sequence: 1, videoMs: segment.startMs + 1100, value: 60, touched: true }]), 1)
  assert.equal(controller.samples('P2', turn, [first]), 0)
  now += segment.endMs - segment.startMs
  controller.tick()
  assert.equal(controller.state.status, 'writing')
  controller.submit('P1', turn, 'I felt calm', { msAltered: 0, msClean: 0, toggles: 0, edits: 0, versionNow: 'altered', firstTypedAtMs: null }, 6)
  assert.equal(controller.state.status, 'writing')
  controller.submit('P2', turn, 'They seemed calm', { msAltered: 0, msClean: 0, toggles: 0, edits: 0, versionNow: 'altered', firstTypedAtMs: null }, 4)
}
assert.equal(controller.state.status, 'done')
assert.equal(responses.length, 8)
assert.deepEqual(responses.map(r => r.responseType), ['self_report', 'perceived', 'perceived', 'self_report', 'self_report', 'perceived', 'perceived', 'self_report'])
assert.equal(savedSamples.length, 12)
assert.equal(savedSamples.filter(s => s.slot === 'P1' && s.turn === 1).flatMap(s => s.samples).length, 2)
assert.equal(responses[0].elicitation, 6)
console.log('continuous rating checks passed')
