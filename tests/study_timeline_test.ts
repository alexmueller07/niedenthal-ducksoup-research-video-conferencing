import assert from 'node:assert/strict'
import { StudyTimeline, STUDY_BLOCK_MS } from '../main/studyTimeline'

const applied: { block: number; target: string | null; alpha: number }[] = []
const missed: [number, number][] = []
const timeline = new StudyTimeline({
  apply: (block, target, alpha) => applied.push({ block, target, alpha }),
  publish: () => {},
  skipped: (from, to) => missed.push([from, to]),
})
assert.equal(timeline.arm('neutral', 'P1'), false)
assert.equal(timeline.start(1000), false)
assert.equal(timeline.arm('smile-subtle', 'P2'), true)
assert.equal(timeline.start(1000), true)
assert.deepEqual(applied[0], { block: 0, target: null, alpha: 0 })
timeline.tick(1000 + STUDY_BLOCK_MS - 1)
assert.equal(applied.length, 1)
timeline.tick(1000 + STUDY_BLOCK_MS)
assert.deepEqual(applied[1], { block: 1, target: 'P2', alpha: 0.2 })
timeline.tick(1000 + STUDY_BLOCK_MS * 2)
assert.deepEqual(applied[2], { block: 2, target: null, alpha: 0 })
timeline.tick(1000 + STUDY_BLOCK_MS * 3)
assert.deepEqual(applied[3], { block: 3, target: 'P1', alpha: 0.2 })
timeline.tick(1000 + STUDY_BLOCK_MS * 4)
assert.deepEqual(applied[4], { block: 4, target: null, alpha: 0 })
assert.equal(timeline.state.status, 'complete')
timeline.tick(1000 + STUDY_BLOCK_MS * 5)
assert.equal(applied.length, 5)
assert.deepEqual(missed, [])

const afterStall: number[] = []
const slow = new StudyTimeline({ apply: block => afterStall.push(block), publish: () => {}, skipped: (from, to) => missed.push([from, to]) })
slow.arm('frown-subtle', 'P1')
slow.start(0)
slow.tick(STUDY_BLOCK_MS * 2 + 5)
assert.deepEqual(afterStall, [0, 2], 'stale manipulation is never briefly applied')
assert.deepEqual(missed, [[1, 1]])
slow.interrupt()
assert.equal(slow.state.status, 'interrupted')
assert.deepEqual(afterStall, [0, 2, 2], 'disconnect neutralizes both faces')
console.log('study timeline checks passed')
