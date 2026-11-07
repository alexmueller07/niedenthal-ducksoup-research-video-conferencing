import assert from 'node:assert/strict'
import { StudyFlow, buildStudySteps, publicStudyState, STUDY_BLOCK_MS } from '../main/studyFlow'
import type { StudyFlowState } from '../main/protocol'

const calls: string[] = []
const banners: string[] = []
let ready: string | null = null
let published: StudyFlowState | null = null
const flow = new StudyFlow({
  publish: s => { published = s },
  conversation: (running, alpha, block) => calls.push(`${running ? 'start' : 'stop'}:${block}:${alpha}`),
  banner: t => banners.push(t),
  ready: () => ready,
  log: () => {},
})

assert.deepEqual(buildStudySteps('negative').map(s => s.label),
  ['PSS, BMIS (Qualtrics)', 'Block 1 intro', 'Block 1', 'Rate last 5 mins', 'Block 2 intro', 'Block 2', 'Rate last 5 mins', 'TikTok task'])
assert.deepEqual(buildStudySteps('negative').filter(s => s.kind === 'conversation').map(s => s.valence), ['negative', 'positive'])

// Cannot start or arm with bad input.
assert.match(flow.start(0) ?? '', /Set up/)
assert.ok(flow.arm({ firstValence: 'positive', manipulatedBlock: 1, presetId: 'neutral' }))
assert.ok(flow.arm({ firstValence: 'positive', manipulatedBlock: 3 as any, presetId: 'smile-subtle' }))
assert.ok(flow.arm({ firstValence: 'positive', manipulatedBlock: 1, presetId: 'smile-subtle' }, 5))
assert.equal(flow.arm({ firstValence: 'negative', manipulatedBlock: 2, presetId: 'smile-subtle' }), null)
assert.equal(flow.state.status, 'armed')
assert.ok(flow.arm({ firstValence: 'positive', manipulatedBlock: 1, presetId: 'smile-subtle' }), 'cannot re-arm while armed')
// Participants never see which block changes their face.
assert.equal(publicStudyState(flow.state).assignment, null)
assert.equal(flow.state.assignment?.manipulatedBlock, 2)

ready = 'Both participants must be connected.'
assert.equal(flow.start(1000), ready)
ready = null
assert.equal(flow.start(1000), null)
assert.equal(flow.state.step, 0)

// survey -> intro -> block 1 (no face change: block 2 is the changed one)
assert.equal(flow.next(2000), null)
assert.equal(flow.next(3000), null)
assert.deepEqual(calls, ['start:1:0'])
assert.equal(flow.state.timeUp, false)
flow.tick(3000 + STUDY_BLOCK_MS - 1)
assert.equal(flow.state.timeUp, false)
flow.tick(3000 + STUDY_BLOCK_MS)
assert.equal(flow.state.timeUp, true)
flow.tick(3000 + STUDY_BLOCK_MS + 5000)
assert.equal(banners.length, 1, 'time-up banner only once')

// Block 1 -> rating: the conversation stops.
assert.equal(flow.next(400_000), null)
assert.deepEqual(calls, ['start:1:0', 'stop:1:0'])
// Ratings: wrong step, duplicates and early Next are all refused.
assert.equal(flow.rated('P1', 2), false)
assert.equal(flow.rated('P1', 3), true)
assert.equal(flow.rated('P1', 3), false)
assert.match(flow.next(401_000) ?? '', /both participants/)
assert.equal(flow.rated('P2', 3), true)
assert.equal(flow.next(402_000), null)

// intro 2 -> block 2 starts with the face change.
assert.equal(flow.next(403_000), null)
assert.deepEqual(calls.at(-1), 'start:2:0.35')
assert.equal(flow.manipulated(2), true)
assert.equal(flow.manipulated(1), false)

// Ready check applies to screens that need both people, but not to ratings.
ready = 'Both participants must be connected.'
assert.equal(flow.next(900_000), null, 'rating needs no one connected check')
ready = null
// Force past a rating nobody answered.
assert.match(flow.next(901_000) ?? '', /both participants/)
assert.equal(flow.next(901_000, true), null)
assert.equal(flow.state.steps[flow.state.step].kind, 'tiktok')
assert.equal(flow.next(902_000), null)
assert.equal(flow.state.status, 'complete')
assert.equal(flow.active, false)
assert.match(flow.next(903_000) ?? '', /not running/)

// Stopping mid-conversation ends the block and neutralizes faces.
calls.length = 0
flow.arm({ firstValence: 'positive', manipulatedBlock: 1, presetId: 'frown-subtle' })
flow.start(0); flow.next(1); flow.next(2)
assert.equal(calls.at(-1), 'start:1:-0.25')
flow.disarm()
assert.equal(calls.at(-1), 'stop:1:0')
assert.equal(flow.state.status, 'idle')
assert.ok(published)
// Manual: the flow applies no automatic face change, even in the designated block.
calls.length = 0
const manual = new StudyFlow({ publish: () => {}, conversation: (r, a, b) => calls.push(`${r ? 'start' : 'stop'}:${b}:${a}`), banner: () => {}, ready: () => null, log: () => {} })
assert.equal(manual.arm({ firstValence: 'positive', manipulatedBlock: 1, presetId: 'manual' }), null)
manual.start(0); manual.next(1); manual.next(2)
assert.equal(calls.at(-1), 'start:1:0')
assert.equal(manual.manipulated(1), true)
console.log('study flow checks passed')
