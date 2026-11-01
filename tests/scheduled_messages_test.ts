import assert from 'node:assert/strict'
import { MessageScheduler, validScheduledMessages } from '../main/scheduledMessages'

const msg = (id: string, atSec: number) => ({ id, atSec, text: `at ${atSec}`, durationSec: 8 })
const start = 1_000_000

const s = new MessageScheduler()
s.setMessages([msg('a', 60), msg('b', 120)])
assert.deepEqual(s.tick(start + 30_000, start, 'live'), [], 'nothing before its time')
assert.deepEqual(s.tick(start + 60_500, start, 'live').map((m) => m.id), ['a'])
assert.deepEqual(s.tick(start + 61_000, start, 'live'), [], 'shown once only')
assert.deepEqual(s.tick(start + 130_000, start, 'waiting'), [], 'only while live')
assert.deepEqual(s.tick(start + 140_000, start, 'live').map((m) => m.id), [], 'stale message is skipped, not shown late')

s.onPhaseChange('live')
assert.deepEqual(s.tick(start + 60_500, start, 'live').map((m) => m.id), ['a'], 'a new live conversation starts over')

s.setMessages([msg('a', 60), msg('b', 120), msg('c', 70)])
assert.deepEqual(s.tick(start + 70_500, start, 'live').map((m) => m.id), ['c'], 'a was already shown, so only c is new')

assert.ok(validScheduledMessages([msg('x', 0)]))
assert.ok(!validScheduledMessages([{ ...msg('x', 0), text: '  ' }]), 'blank text')
assert.ok(!validScheduledMessages([msg('x', 1), msg('x', 2)]), 'duplicate ids')
assert.ok(!validScheduledMessages([{ ...msg('x', 0), durationSec: 0 }]), 'zero duration')
console.log('scheduled message checks passed')
