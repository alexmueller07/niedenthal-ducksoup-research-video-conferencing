// Timed messages for the participants, e.g. "Five minutes remaining".
//
// Each message is shown once, a set number of seconds into the live
// conversation. Plain logic with no timers of its own: the session server calls
// tick() with the clock, so it is tested without a network.

import type { Phase, ScheduledMessage } from './protocol'

export const MAX_SCHEDULED_MESSAGES = 30
/** A message this long past its time is skipped (e.g. added or edited late), not shown stale. */
const STALE_AFTER_SEC = 10

export function validScheduledMessages(value: unknown): value is ScheduledMessage[] {
  if (!Array.isArray(value) || value.length > MAX_SCHEDULED_MESSAGES) return false
  const ids = new Set<string>()
  return value.every((m) => {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id || m.id.length > 80 || ids.has(m.id)) return false
    ids.add(m.id)
    return (
      Number.isFinite(m.atSec) && m.atSec >= 0 && m.atSec <= 10859 &&
      typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= 300 &&
      Number.isFinite(m.durationSec) && m.durationSec >= 1 && m.durationSec <= 120
    )
  })
}

export class MessageScheduler {
  private messages: ScheduledMessage[] = []
  private fired = new Set<string>()

  get current(): ScheduledMessage[] {
    return this.messages
  }

  setMessages(messages: ScheduledMessage[]) {
    const old = new Map(this.messages.map((m) => [m.id, m]))
    // Editing a message that already went out does not send it again.
    this.fired = new Set(
      [...this.fired].filter((id) => {
        const was = old.get(id)
        const now = messages.find((m) => m.id === id)
        return !!was && !!now && was.atSec === now.atSec
      }),
    )
    this.messages = messages
  }

  /** A new live conversation starts the clock again. */
  onPhaseChange(to: Phase) {
    if (to === 'live') this.fired.clear()
  }

  /** Messages that are due now. `liveStartMs` is when the conversation went live. */
  tick(nowMs: number, liveStartMs: number | null, phase: Phase): ScheduledMessage[] {
    if (phase !== 'live' || liveStartMs === null) return []
    const elapsed = (nowMs - liveStartMs) / 1000
    const due: ScheduledMessage[] = []
    for (const m of this.messages) {
      if (this.fired.has(m.id) || elapsed < m.atSec) continue
      this.fired.add(m.id)
      if (elapsed - m.atSec <= STALE_AFTER_SEC) due.push(m)
    }
    return due
  }
}
