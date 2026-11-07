import type { PSlot, StudyAssignment, StudyFlowState, StudyStep, StudyValence } from './protocol'
import { PRESETS } from './presets'

// The researcher-controlled study flow: a fixed list of screens the researcher
// steps through with Next. Survey, intro, conversation, rating, intro,
// conversation, rating, TikTok task.

export const STUDY_BLOCK_MS = 300_000
export const STUDY_FACE_PRESETS = PRESETS.filter(p =>
  ['smile-subtle', 'smile-strong', 'frown-subtle', 'frown-strong'].includes(p.id))

export interface StudyFlowHost {
  publish(state: StudyFlowState): void
  /** Start (true) or stop (false) a conversation block, with both faces at `alpha`. */
  conversation(running: boolean, alpha: number, block: 1 | 2): void
  banner(text: string): void
  /** Why a screen that needs both participants cannot be shown, or null. */
  ready(): string | null
  log(event: string, detail: Record<string, unknown>): void
}

const other = (v: StudyValence): StudyValence => (v === 'positive' ? 'negative' : 'positive')

export function buildStudySteps(firstValence: StudyValence): StudyStep[] {
  const steps: StudyStep[] = [{ kind: 'survey', block: null, valence: null, label: 'PSS, BMIS (Qualtrics)' }]
  for (const block of [1, 2] as const) {
    const valence = block === 1 ? firstValence : other(firstValence)
    steps.push(
      { kind: 'intro', block, valence, label: `Block ${block} intro` },
      { kind: 'conversation', block, valence, label: `Block ${block}` },
      { kind: 'rating', block, valence, label: 'Rate last 5 mins' },
    )
  }
  steps.push({ kind: 'tiktok', block: null, valence: null, label: 'TikTok task' })
  return steps
}

function idle(): StudyFlowState {
  return { status: 'idle', step: -1, steps: [], assignment: null, blockMs: STUDY_BLOCK_MS,
    stepStartedAtMs: null, timeUp: false, submitted: { P1: false, P2: false } }
}

/** What a participant may see: everything except which block changes their face. */
export function publicStudyState(state: StudyFlowState): StudyFlowState {
  return { ...state, assignment: null }
}

export class StudyFlow {
  private s: StudyFlowState = idle()
  constructor(private readonly host: StudyFlowHost) {}
  get state(): StudyFlowState { return this.s }
  /** Armed or running: the flow owns the phase and the faces. */
  get active(): boolean { return this.s.status === 'armed' || this.s.status === 'running' }

  arm(a: StudyAssignment, blockMs = STUDY_BLOCK_MS): string | null {
    if (this.active) return 'The study flow is already armed or running.'
    if (!STUDY_FACE_PRESETS.some(p => p.id === a.presetId)) return 'Choose a face change preset.'
    if (a.firstValence !== 'positive' && a.firstValence !== 'negative') return 'Choose the first topic.'
    if (a.manipulatedBlock !== 1 && a.manipulatedBlock !== 2) return 'Choose the block with the face change.'
    if (!Number.isFinite(blockMs) || blockMs < 10_000 || blockMs > 3_600_000) return 'Block length must be between 10 seconds and 60 minutes.'
    this.s = { ...idle(), status: 'armed', assignment: { ...a }, blockMs, steps: buildStudySteps(a.firstValence) }
    this.host.publish(this.s)
    return null
  }

  /** Armed: back to idle. Running: stop (a running block is ended and faces reset). */
  disarm(): string | null {
    if (!this.active) return null
    const cur = this.s.steps[this.s.step]
    if (this.s.status === 'running' && cur?.kind === 'conversation') this.host.conversation(false, 0, cur.block as 1 | 2)
    this.s = idle()
    this.host.publish(this.s)
    return null
  }

  start(nowMs: number): string | null {
    if (this.s.status !== 'armed') return 'Arm the study flow first.'
    const why = this.host.ready()
    if (why) return why
    this.s = { ...this.s, status: 'running', step: 0, stepStartedAtMs: nowMs, timeUp: false, submitted: { P1: false, P2: false } }
    this.host.publish(this.s)
    return null
  }

  next(nowMs: number, force = false): string | null {
    if (this.s.status !== 'running') return 'The study flow is not running.'
    const cur = this.s.steps[this.s.step]
    const nxt = this.s.steps[this.s.step + 1]
    if (!nxt) {
      this.s = { ...this.s, status: 'complete' }
      this.host.publish(this.s)
      return null
    }
    if (cur.kind === 'rating' && !force && !(this.s.submitted.P1 && this.s.submitted.P2))
      return 'Waiting for both participants to finish rating.'
    if (nxt.kind !== 'tiktok' && nxt.kind !== 'rating') {
      const why = this.host.ready()
      if (why) return why
    }
    if (cur.kind === 'conversation') this.host.conversation(false, 0, cur.block as 1 | 2)
    this.s = { ...this.s, step: this.s.step + 1, stepStartedAtMs: nowMs, timeUp: false, submitted: { P1: false, P2: false } }
    if (nxt.kind === 'conversation') {
      const a = this.s.assignment as StudyAssignment
      const alpha = a.manipulatedBlock === nxt.block ? STUDY_FACE_PRESETS.find(p => p.id === a.presetId)!.alpha : 0
      this.host.conversation(true, alpha, nxt.block as 1 | 2)
    }
    this.host.publish(this.s)
    return null
  }

  /** A participant sent their ratings for `step`. False if it does not count (wrong step, or already sent). */
  rated(slot: PSlot, step: number): boolean {
    if (this.s.status !== 'running' || this.s.step !== step || this.s.steps[step]?.kind !== 'rating') return false
    if (this.s.submitted[slot]) return false
    this.s = { ...this.s, submitted: { ...this.s.submitted, [slot]: true } }
    this.host.publish(this.s)
    return true
  }

  /** True when the block that is being run (or was just rated) had the face change. */
  manipulated(block: number | null): boolean {
    return !!block && this.s.assignment?.manipulatedBlock === block
  }

  tick(nowMs: number) {
    const cur = this.s.steps[this.s.step]
    if (this.s.status !== 'running' || cur?.kind !== 'conversation' || this.s.timeUp || this.s.stepStartedAtMs === null) return
    if (nowMs - this.s.stepStartedAtMs < this.s.blockMs) return
    this.s = { ...this.s, timeUp: true }
    this.host.log('study_block_time_up', { block: cur.block, blockMs: this.s.blockMs })
    this.host.banner('Time is up. Please finish your thought and wrap up.')
    this.host.publish(this.s)
  }
}
