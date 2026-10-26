import type { PSlot, StudyTimelineState } from './protocol'
import { PRESETS } from './presets'

export const STUDY_BLOCK_MS = 150_000
export const STUDY_BLOCKS = 4
export const STUDY_FACE_PRESETS = PRESETS.filter(p =>
  ['smile-subtle', 'smile-strong', 'frown-subtle', 'frown-strong'].includes(p.id))

export interface StudyTimelineHost {
  apply(block: number, target: PSlot | null, alpha: number): void
  publish(state: StudyTimelineState): void
  skipped?(fromBlock: number, toBlock: number): void
}

export class StudyTimeline {
  private stateValue: StudyTimelineState = {
    status: 'idle', presetId: null, firstSeat: 'P1', block: -1, startedAtMs: null,
  }
  constructor(private readonly host: StudyTimelineHost) {}
  get state(): StudyTimelineState { return this.stateValue }

  arm(presetId: string, firstSeat: PSlot): boolean {
    if (this.stateValue.status === 'running' || !STUDY_FACE_PRESETS.some(p => p.id === presetId) ||
      !['P1', 'P2'].includes(firstSeat)) return false
    this.stateValue = { status: 'armed', presetId, firstSeat, block: -1, startedAtMs: null }
    this.host.publish(this.stateValue)
    return true
  }

  disarm() {
    if (this.stateValue.status === 'running') return false
    this.stateValue = { status: 'idle', presetId: null, firstSeat: 'P1', block: -1, startedAtMs: null }
    this.host.publish(this.stateValue)
    return true
  }

  start(atMs: number) {
    if (this.stateValue.status !== 'armed' || !Number.isFinite(atMs)) return false
    this.stateValue = { ...this.stateValue, status: 'running', startedAtMs: atMs }
    this.enter(0)
    return true
  }

  tick(nowMs: number) {
    if (this.stateValue.status !== 'running' || this.stateValue.startedAtMs === null) return
    const due = Math.floor(Math.max(0, nowMs - this.stateValue.startedAtMs) / STUDY_BLOCK_MS)
    if (due > this.stateValue.block + 1)
      this.host.skipped?.(this.stateValue.block + 1, Math.min(due, STUDY_BLOCKS) - 1)
    if (due < STUDY_BLOCKS && due > this.stateValue.block) this.enter(due)
    if (due >= STUDY_BLOCKS) {
      this.host.apply(STUDY_BLOCKS, null, 0)
      this.stateValue = { ...this.stateValue, status: 'complete', block: STUDY_BLOCKS }
      this.host.publish(this.stateValue)
    }
  }

  interrupt() {
    if (this.stateValue.status !== 'running' && this.stateValue.status !== 'armed') return
    if (this.stateValue.status === 'running') this.host.apply(this.stateValue.block, null, 0)
    this.stateValue = { ...this.stateValue, status: 'interrupted' }
    this.host.publish(this.stateValue)
  }

  private enter(block: number) {
    const target = block === 1 ? this.stateValue.firstSeat : block === 3 ?
      (this.stateValue.firstSeat === 'P1' ? 'P2' : 'P1') : null
    const alpha = target ? STUDY_FACE_PRESETS.find(p => p.id === this.stateValue.presetId)!.alpha : 0
    this.host.apply(block, target, alpha)
    this.stateValue = { ...this.stateValue, block }
    this.host.publish(this.stateValue)
  }
}
