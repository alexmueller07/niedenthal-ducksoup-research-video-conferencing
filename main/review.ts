// Post-call review: turn planning, media lookup, and the ReviewController.
//
// The controller runs inside the session server and owns the one playback
// clock both participants follow. It never touches video itself — each
// participant machine streams the recordings from the server and keeps its own
// <video> elements on that clock. Everything here is plain logic with an
// injected clock, so it is tested without a camera or a network
// (tests/review_controller_test.ts).
//
// Flow of one turn:
//   loading  → both machines seek to the turn's start and report ready
//   playing  → the clip runs; both people can already type
//   writing  → the clip has ended; each presses Done (or the researcher
//              forces the next turn, or 'auto' advance moves on after 10 s)
// A buffering machine or a dropped participant sends the turn back to
// 'loading' at the current position, so neither person gets ahead.

import type {
  Identity,
  PSlot,
  ReviewConfig,
  ReviewControlAction,
  ReviewMediaPart,
  ReviewSegment,
  ReviewState,
  ReviewViewingStats,
  ReviewViewMode,
} from './protocol'
import { DEFAULT_REVIEW_CONFIG, REVIEW_AUTO_ADVANCE_SEC } from './protocol'

const SEATS: PSlot[] = ['P1', 'P2']
/** Play starts this long after both are ready, so both machines press play together. */
export const REVIEW_START_LEAD_MS = 600
/** Shortest conversation worth reviewing. */
const MIN_REVIEW_MS = 1000
const MAX_TEXT = 20000

// ---- Turn planning ----

/**
 * Split a conversation of `durationMs` into alternating turns.
 *
 * Windows are `segmentSec` long; each window gives one turn to `firstSeat`
 * and then one to the other seat, over the same stretch of time. A final
 * stretch shorter than `minTailSec` is folded into the window before it
 * rather than becoming a turn of a few seconds.
 */
export function buildSegments(
  durationMs: number,
  config: Pick<ReviewConfig, 'segmentSec' | 'minTailSec' | 'firstSeat'>,
): ReviewSegment[] {
  if (!(durationMs >= MIN_REVIEW_MS)) return []
  const len = config.segmentSec * 1000
  const tail = config.minTailSec * 1000
  const windows: [number, number][] = []
  for (let start = 0; start < durationMs; start += len) {
    windows.push([start, Math.min(start + len, durationMs)])
  }
  if (windows.length > 1) {
    const last = windows[windows.length - 1]
    if (last[1] - last[0] < tail) {
      windows.pop()
      windows[windows.length - 1][1] = durationMs
    }
  }
  const second: PSlot = config.firstSeat === 'P1' ? 'P2' : 'P1'
  const out: ReviewSegment[] = []
  windows.forEach(([startMs, endMs], i) => {
    for (const targetSeat of [config.firstSeat, second]) {
      out.push({ index: out.length + 1, window: i + 1, targetSeat, startMs, endMs })
    }
  })
  return out
}

/**
 * Which file covers this moment of the conversation, and where inside it.
 * Returns null for a gap (e.g. the participant's connection dropped and the
 * recording restarted as a _part2 file a few seconds later). If two parts
 * overlap, the one that started later wins.
 */
export function resolveMediaAt(
  parts: ReviewMediaPart[],
  timelineMs: number,
): { part: ReviewMediaPart; localMs: number } | null {
  let best: ReviewMediaPart | null = null
  for (const part of parts) {
    if (timelineMs >= part.offsetMs && timelineMs < part.offsetMs + part.durationMs) {
      if (!best || part.offsetMs > best.offsetMs) best = part
    }
  }
  return best ? { part: best, localMs: timelineMs - best.offsetMs } : null
}

/** Where the shared clock says playback is, on the conversation timeline. */
export function reviewPositionMs(state: ReviewState, serverNowMs: number): number {
  const seg = state.segments[state.current]
  if (!seg) return 0
  if (state.status !== 'playing') return state.anchorPosMs
  const pos = state.anchorPosMs + Math.max(0, serverNowMs - state.anchorServerMs)
  return Math.min(pos, seg.endMs)
}

// ---- Input checking (messages come off the network) ----

export function parseReviewConfig(input: unknown): ReviewConfig {
  const c = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt
  return {
    viewMode: (['gallery', 'single', 'active'] as const).includes(c.viewMode as ReviewViewMode)
      ? (c.viewMode as ReviewViewMode)
      : DEFAULT_REVIEW_CONFIG.viewMode,
    segmentSec: num(c.segmentSec, 10, 1800, DEFAULT_REVIEW_CONFIG.segmentSec),
    minTailSec: num(c.minTailSec, 0, 600, DEFAULT_REVIEW_CONFIG.minTailSec),
    firstSeat: c.firstSeat === 'P2' ? 'P2' : 'P1',
    allowPause: c.allowPause === true,
    advance: c.advance === 'auto' ? 'auto' : 'both-done',
    showOriginal: c.showOriginal === true,
  }
}

export function parseViewingStats(input: unknown): ReviewViewingStats {
  const s = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const count = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0
  return {
    msAltered: count(s.msAltered),
    msClean: count(s.msClean),
    toggles: count(s.toggles),
    edits: count(s.edits),
    versionNow: s.versionNow === 'clean' ? 'clean' : 'altered',
    firstTypedAtMs:
      typeof s.firstTypedAtMs === 'number' && Number.isFinite(s.firstTypedAtMs)
        ? Math.round(s.firstTypedAtMs)
        : null,
  }
}

export function cleanText(input: unknown): string {
  return typeof input === 'string' ? input.slice(0, MAX_TEXT) : ''
}

// ---- Records handed to the logger ----

export type ReviewSubmittedBy = 'participant' | 'researcher_forced' | 'auto' | 'review_ended'

export interface ReviewResponseRecord {
  segment: ReviewSegment
  writerSlot: PSlot
  writer: Identity
  about: Identity
  responseType: 'self_report' | 'perceived'
  viewMode: ReviewViewMode
  stats: ReviewViewingStats
  text: string
  submittedBy: ReviewSubmittedBy
  /** When this turn's clip first started playing (server clock), or null. */
  openedAtMs: number | null
  submittedAtMs: number
}

export interface ReviewSegmentRecord {
  segment: ReviewSegment
  playedAtMs: number | null
  finishedPlayingAtMs: number | null
  advancedAtMs: number
  advancedBy: 'both_done' | 'researcher' | 'auto' | 'review_ended'
  pauses: number
  pauseTotalMs: number
}

export interface ReviewHost {
  now(): number
  publish(state: ReviewState): void
  log(input: {
    event: string
    actorSlot?: string
    target?: string
    param?: string
    value?: string | number | boolean
    detail?: unknown
  }): void
  writeResponse(record: ReviewResponseRecord): void
  writeSegment(record: ReviewSegmentRecord): void
  identity(slot: PSlot): Identity
}

interface Draft {
  text: string
  stats: ReviewViewingStats
  submitted: boolean
}

interface TurnStats {
  playedAtMs: number | null
  finishedPlayingAtMs: number | null
  pauses: number
  pauseTotalMs: number
  /** When playback last stopped mid-clip, or null while playing / not started. */
  heldSinceMs: number | null
}

function both<T>(v: T): Record<PSlot, T> {
  return { P1: v, P2: v }
}

function emptyStats(): ReviewViewingStats {
  return { msAltered: 0, msClean: 0, toggles: 0, edits: 0, versionNow: 'altered', firstTypedAtMs: null }
}

function idleState(): ReviewState {
  return {
    status: 'idle',
    config: { ...DEFAULT_REVIEW_CONFIG },
    segments: [],
    current: 0,
    loadSeq: 0,
    anchorServerMs: 0,
    anchorPosMs: 0,
    holdReason: null,
    connected: both(false),
    ready: both(false),
    done: both(false),
    autoAdvanceAtMs: null,
  }
}

export class ReviewController {
  private s: ReviewState = idleState()
  private drafts: Record<PSlot, Draft> = { P1: this.freshDraft(), P2: this.freshDraft() }
  private turn: TurnStats = this.freshTurn()

  constructor(private readonly host: ReviewHost) {}

  get state(): ReviewState {
    return this.s
  }

  get active(): boolean {
    return this.s.status !== 'idle'
  }

  /** The 1-based number of the turn on screen, or 0 when idle. */
  get turnNumber(): number {
    return this.active ? (this.s.segments[this.s.current]?.index ?? 0) : 0
  }

  /** Returns an error message, or null once the review has started. */
  start(config: ReviewConfig, conversationMs: number, connected: Record<PSlot, boolean>): string | null {
    const segments = buildSegments(conversationMs, config)
    if (segments.length === 0) return 'The recording is too short to review.'
    this.s = { ...idleState(), config, segments, connected: { ...connected } }
    this.host.log({
      event: 'review_started',
      param: 'turns',
      value: segments.length,
      detail: { config, conversationMs },
    })
    this.beginTurn()
    return null
  }

  /** Back to idle (the researcher ended the review, or the phase changed). */
  stop() {
    if (!this.active) return
    // Ended mid-turn: keep whatever each person had written, and the turn itself.
    if (this.s.status !== 'done') this.closeTurn('review_ended')
    this.host.log({
      event: 'review_ended',
      param: 'turn',
      value: this.turnNumber,
      detail: { finished: this.s.status === 'done' },
    })
    this.s = idleState()
    this.drafts = { P1: this.freshDraft(), P2: this.freshDraft() }
    this.publish()
  }

  /** The participant's own unsubmitted (or submitted) answer, for a reconnect. */
  draftFor(slot: PSlot): { turn: number; text: string; submitted: boolean } | null {
    if (!this.active || this.s.status === 'done') return null
    const d = this.drafts[slot]
    return { turn: this.turnNumber, text: d.text, submitted: d.submitted }
  }

  connection(slot: PSlot, connected: boolean) {
    if (!this.active || this.s.connected[slot] === connected) return
    this.s = { ...this.s, connected: { ...this.s.connected, [slot]: connected } }
    if (!connected && (this.s.status === 'playing' || this.s.status === 'loading')) {
      this.hold('loading', 'disconnect')
      return
    }
    this.publish()
  }

  ready(slot: PSlot, loadSeq: number) {
    if (this.s.status !== 'loading' || loadSeq !== this.s.loadSeq || this.s.ready[slot]) return
    this.s = { ...this.s, ready: { ...this.s.ready, [slot]: true } }
    if (SEATS.every((p) => this.s.ready[p] && this.s.connected[p])) this.play()
    else this.publish()
  }

  buffering(slot: PSlot, loadSeq: number) {
    if (this.s.status !== 'playing' || loadSeq !== this.s.loadSeq) return
    this.host.log({ event: 'review_video_catching_up', actorSlot: slot, param: 'turn', value: this.turnNumber })
    this.hold('loading', 'buffering')
  }

  draft(slot: PSlot, turn: number, text: string, stats: ReviewViewingStats) {
    if (turn !== this.turnNumber || this.drafts[slot].submitted) return
    if (this.s.status === 'idle' || this.s.status === 'done') return
    this.drafts[slot] = { text, stats, submitted: false }
  }

  submit(slot: PSlot, turn: number, text: string, stats: ReviewViewingStats) {
    if (this.s.status !== 'writing' || turn !== this.turnNumber || this.s.done[slot]) return
    this.drafts[slot] = { text, stats, submitted: true }
    this.saveResponse(slot, 'participant')
    this.s = { ...this.s, done: { ...this.s.done, [slot]: true } }
    if (SEATS.every((p) => this.s.done[p])) this.advance('both_done')
    else this.publish()
  }

  /** Returns an error message for a refused action, or null. */
  control(action: ReviewControlAction, by: 'researcher' | PSlot): string | null {
    if (!this.active) return 'No review is running.'
    if (by !== 'researcher') {
      if (!this.s.config.allowPause || (action !== 'pause' && action !== 'resume')) {
        return 'Not allowed.'
      }
    }
    const reason = by === 'researcher' ? 'researcher' : 'participant'
    switch (action) {
      case 'pause':
        if (this.s.status !== 'playing' && this.s.status !== 'loading') return 'Nothing is playing.'
        this.host.log({ event: 'review_paused', actorSlot: by === 'researcher' ? 'ADMIN' : by, param: 'turn', value: this.turnNumber })
        this.hold('paused', reason)
        return null
      case 'resume':
        if (this.s.status !== 'paused') return 'The review is not paused.'
        if (by !== 'researcher' && this.s.holdReason !== 'participant') return 'Paused by the researcher.'
        this.host.log({ event: 'review_resumed', actorSlot: by === 'researcher' ? 'ADMIN' : by, param: 'turn', value: this.turnNumber })
        this.hold('loading', null)
        return null
      case 'play-now':
        // Start without waiting for a participant who is slow to load or gone.
        if (this.s.status !== 'loading') return 'Not waiting to start.'
        this.host.log({
          event: 'review_started_without_waiting',
          actorSlot: 'ADMIN',
          param: 'turn',
          value: this.turnNumber,
          detail: { ready: this.s.ready, connected: this.s.connected },
        })
        this.play()
        return null
      case 'restart-turn': {
        if (this.s.status === 'done') return 'The review has finished.'
        const seg = this.s.segments[this.s.current]
        this.host.log({ event: 'review_turn_restarted', actorSlot: 'ADMIN', param: 'turn', value: this.turnNumber })
        this.s = { ...this.s, autoAdvanceAtMs: null }
        this.hold('loading', null, seg.startMs)
        return null
      }
      case 'force-next':
        if (this.s.status === 'done') return 'The review has finished.'
        this.advance('researcher')
        return null
    }
  }

  /** ~4×/s from the server: ends clips on time and runs auto-advance. */
  tick() {
    const now = this.host.now()
    if (this.s.status === 'playing') {
      const seg = this.s.segments[this.s.current]
      if (reviewPositionMs(this.s, now) >= seg.endMs) {
        this.turn.finishedPlayingAtMs = now
        this.host.log({ event: 'review_clip_finished', param: 'turn', value: this.turnNumber })
        this.s = {
          ...this.s,
          status: 'writing',
          anchorPosMs: seg.endMs,
          anchorServerMs: now,
          holdReason: null,
          autoAdvanceAtMs:
            this.s.config.advance === 'auto' ? now + REVIEW_AUTO_ADVANCE_SEC * 1000 : null,
        }
        this.publish()
      }
    } else if (this.s.status === 'writing' && this.s.autoAdvanceAtMs !== null && now >= this.s.autoAdvanceAtMs) {
      this.advance('auto')
    }
  }

  // ---- Internals ----

  private freshDraft(): Draft {
    return { text: '', stats: emptyStats(), submitted: false }
  }

  private freshTurn(): TurnStats {
    return { playedAtMs: null, finishedPlayingAtMs: null, pauses: 0, pauseTotalMs: 0, heldSinceMs: null }
  }

  private beginTurn() {
    const seg = this.s.segments[this.s.current]
    this.drafts = { P1: this.freshDraft(), P2: this.freshDraft() }
    this.turn = this.freshTurn()
    this.s = {
      ...this.s,
      // Not 'playing' any more: stopping the previous clip is not a pause in this turn.
      status: 'loading',
      anchorPosMs: seg.startMs,
      done: both(false),
      autoAdvanceAtMs: null,
    }
    this.host.log({
      event: 'review_turn_started',
      target: seg.targetSeat,
      param: 'turn',
      value: seg.index,
      detail: seg,
    })
    this.hold('loading', null)
  }

  /**
   * Stop the clock where it is and wait. 'loading' asks both machines to get
   * ready again at the current position; 'paused' waits for a resume.
   */
  private hold(status: 'loading' | 'paused', reason: ReviewState['holdReason'], atMs?: number) {
    const now = this.host.now()
    const pos = atMs ?? reviewPositionMs(this.s, now)
    this.markHeld()
    this.s = {
      ...this.s,
      anchorPosMs: pos,
      status,
      holdReason: reason,
      anchorServerMs: now,
      loadSeq: status === 'loading' ? this.s.loadSeq + 1 : this.s.loadSeq,
      ready: both(false),
    }
    this.publish()
  }

  private markHeld() {
    if (this.s.status === 'playing' && this.turn.heldSinceMs === null) {
      this.turn.pauses += 1
      this.turn.heldSinceMs = this.host.now()
    }
  }

  private play() {
    const now = this.host.now()
    const startAt = now + REVIEW_START_LEAD_MS
    if (this.turn.playedAtMs === null) this.turn.playedAtMs = startAt
    if (this.turn.heldSinceMs !== null) {
      this.turn.pauseTotalMs += startAt - this.turn.heldSinceMs
      this.turn.heldSinceMs = null
    }
    this.s = { ...this.s, status: 'playing', holdReason: null, anchorServerMs: startAt }
    this.publish()
  }

  private advance(by: Exclude<ReviewSegmentRecord['advancedBy'], 'review_ended'>) {
    this.closeTurn(by)
    const now = this.host.now()
    if (this.s.current + 1 >= this.s.segments.length) {
      this.s = { ...this.s, status: 'done', holdReason: null, autoAdvanceAtMs: null, anchorServerMs: now }
      this.host.log({ event: 'review_finished', param: 'turns', value: this.s.segments.length })
      this.publish()
      return
    }
    this.s = { ...this.s, current: this.s.current + 1 }
    this.beginTurn()
  }

  /** Save any answers not yet submitted and write the turn's row. */
  private closeTurn(by: ReviewSegmentRecord['advancedBy']) {
    const now = this.host.now()
    if (by !== 'both_done') {
      const submittedBy: ReviewSubmittedBy =
        by === 'auto' ? 'auto' : by === 'review_ended' ? 'review_ended' : 'researcher_forced'
      for (const slot of SEATS) {
        if (!this.s.done[slot]) this.saveResponse(slot, submittedBy)
      }
    }
    if (this.turn.heldSinceMs !== null) {
      this.turn.pauseTotalMs += now - this.turn.heldSinceMs
      this.turn.heldSinceMs = null
    }
    const seg = this.s.segments[this.s.current]
    this.host.writeSegment({
      segment: seg,
      playedAtMs: this.turn.playedAtMs,
      finishedPlayingAtMs: this.turn.finishedPlayingAtMs,
      advancedAtMs: now,
      advancedBy: by,
      pauses: this.turn.pauses,
      pauseTotalMs: this.turn.pauseTotalMs,
    })
    this.host.log({ event: 'review_advanced', param: 'turn', value: seg.index, detail: { by } })
  }

  private saveResponse(slot: PSlot, submittedBy: ReviewSubmittedBy) {
    const seg = this.s.segments[this.s.current]
    const draft = this.drafts[slot]
    const now = this.host.now()
    this.host.writeResponse({
      segment: seg,
      writerSlot: slot,
      writer: this.host.identity(slot),
      about: this.host.identity(seg.targetSeat),
      responseType: slot === seg.targetSeat ? 'self_report' : 'perceived',
      viewMode: this.s.config.viewMode,
      stats: draft.stats,
      text: draft.text,
      submittedBy,
      openedAtMs: this.turn.playedAtMs,
      submittedAtMs: now,
    })
    this.host.log({
      event: 'review_response_submitted',
      actorSlot: slot,
      target: seg.targetSeat,
      param: 'turn',
      value: seg.index,
      detail: { submittedBy, words: countWords(draft.text) },
    })
  }

  private publish() {
    this.host.publish(this.s)
  }
}

export function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}
