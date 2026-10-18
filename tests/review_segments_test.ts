import assert from 'node:assert/strict'
import { buildSegments, parseReviewConfig, resolveMediaAt, reviewPositionMs } from '../main/review'
import { DEFAULT_REVIEW_CONFIG, type ReviewState } from '../main/protocol'

const cfg = { segmentSec: 150, minTailSec: 30, firstSeat: 'P1' as const }
const min = (m: number, s = 0) => (m * 60 + s) * 1000
const spans = (d: number, c = cfg) =>
  buildSegments(d, c).map((s) => `${s.index}:${s.targetSeat}:${s.startMs / 1000}-${s.endMs / 1000}`)

// Exact multiple: two windows, four turns, alternating P1/P2 over the same stretch.
assert.deepEqual(spans(min(5)), ['1:P1:0-150', '2:P2:0-150', '3:P1:150-300', '4:P2:150-300'])

// A long tail stays its own (shorter) window.
assert.deepEqual(spans(min(7, 10)).slice(-2), ['5:P1:300-430', '6:P2:300-430'])

// A short tail (20 s < 30 s) is folded into the window before it.
assert.deepEqual(spans(min(5, 20)), ['1:P1:0-150', '2:P2:0-150', '3:P1:150-320', '4:P2:150-320'])

// Exactly the tail limit is kept as its own window.
assert.equal(buildSegments(min(5, 30), cfg).length, 6)

// A call shorter than one window is one window of its whole length,
// even when it is shorter than the tail limit.
assert.deepEqual(spans(min(0, 20)), ['1:P1:0-20', '2:P2:0-20'])

// Nothing to review.
assert.deepEqual(buildSegments(0, cfg), [])
assert.deepEqual(buildSegments(500, cfg), [])
assert.deepEqual(buildSegments(Number.NaN, cfg), [])

// P2 first.
assert.deepEqual(spans(min(2), { ...cfg, firstSeat: 'P2' }), ['1:P2:0-120', '2:P1:0-120'])

// Window numbers.
assert.deepEqual(
  buildSegments(min(5), cfg).map((s) => s.window),
  [1, 1, 2, 2],
)

// ---- Media lookup ----
const parts = [
  { url: '/a', offsetMs: 40, durationMs: 60_000 },
  // reconnect: second file starts after a 5 s gap
  { url: '/b', offsetMs: 65_040, durationMs: 100_000 },
]
assert.deepEqual(resolveMediaAt(parts, 1000), { part: parts[0], localMs: 960 })
assert.equal(resolveMediaAt(parts, 10), null, 'before the recording started')
assert.equal(resolveMediaAt(parts, 62_000), null, 'gap between parts')
assert.deepEqual(resolveMediaAt(parts, 70_040), { part: parts[1], localMs: 5000 })
assert.equal(resolveMediaAt(parts, 165_040), null, 'end is exclusive')
// Overlap: the later-starting part wins.
const overlap = [
  { url: '/a', offsetMs: 0, durationMs: 10_000 },
  { url: '/b', offsetMs: 8000, durationMs: 10_000 },
]
assert.equal(resolveMediaAt(overlap, 9000)?.part.url, '/b')

// ---- Shared clock ----
const state = {
  status: 'playing',
  segments: [{ index: 1, window: 1, targetSeat: 'P1', startMs: 0, endMs: 150_000 }],
  current: 0,
  anchorServerMs: 10_000,
  anchorPosMs: 5000,
} as unknown as ReviewState
assert.equal(reviewPositionMs(state, 12_000), 7000)
assert.equal(reviewPositionMs(state, 9000), 5000, 'holds at the anchor until the start time')
assert.equal(reviewPositionMs(state, 10_000_000), 150_000, 'capped at the end of the turn')
assert.equal(reviewPositionMs({ ...state, status: 'paused' }, 12_000), 5000)

// ---- Config from the network ----
assert.deepEqual(parseReviewConfig(undefined), DEFAULT_REVIEW_CONFIG)
const parsed = parseReviewConfig({
  viewMode: 'gallery',
  segmentSec: 5,
  minTailSec: -3,
  firstSeat: 'P2',
  allowPause: 'yes',
  advance: 'auto',
  showOriginal: true,
})
assert.equal(parsed.viewMode, 'gallery')
assert.equal(parsed.segmentSec, 10, 'clamped to the minimum')
assert.equal(parsed.minTailSec, 0)
assert.equal(parsed.firstSeat, 'P2')
assert.equal(parsed.allowPause, false, 'only a real boolean turns it on')
assert.equal(parsed.advance, 'auto')
assert.equal(parsed.showOriginal, true)
assert.equal(parseReviewConfig({ viewMode: 'grid' }).viewMode, DEFAULT_REVIEW_CONFIG.viewMode)

console.log('review segment checks passed')
