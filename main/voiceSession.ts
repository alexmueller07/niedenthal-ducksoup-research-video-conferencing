import { DEFAULT_VOICE_CONDITION, voiceUsable } from './voiceProtocol'
import type { VoiceCondition, VoicePairState, VoiceReport, VoiceSeat, VoiceTurn } from './voiceProtocol'

export function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < 5 || xs.length !== ys.length) return null
  const mx = xs.reduce((s,x) => s+x,0)/xs.length, my = ys.reduce((s,x) => s+x,0)/ys.length
  let xx=0, yy=0, xy=0
  xs.forEach((x,i) => {xx+=(x-mx)**2; yy+=(ys[i]-my)**2; xy+=(x-mx)*(ys[i]-my)})
  return xx < 1e-6 || yy < 1e-6 ? null : Math.max(-1, Math.min(1, xy/Math.sqrt(xx*yy)))
}

export class VoiceSession {
  condition = { ...DEFAULT_VOICE_CONDITION }
  private reports: Partial<Record<VoiceSeat, VoiceReport>> = {}
  private seenAt: Partial<Record<VoiceSeat, number>> = {}
  private turns: Array<VoiceTurn & { slot: VoiceSeat }> = []
  private lastIds: Partial<Record<VoiceSeat, number>> = {}

  update(slot: VoiceSeat, report: VoiceReport, now = Date.now()): VoiceTurn[] {
    if (report.sequence <= (this.reports[slot]?.sequence ?? -1)) return []
    this.reports[slot] = report; this.seenAt[slot] = now
    const accepted = report.turns.filter(t => t.id > (this.lastIds[slot] ?? 0))
    for (const turn of accepted) {
      this.lastIds[slot] = Math.max(this.lastIds[slot] ?? 0, turn.id)
      if (turn.valid) this.turns.push({ ...turn, slot })
    }
    this.turns.sort((a,b) => a.startedAt-b.startedAt)
    if (this.turns.length > 60) this.turns.splice(0, this.turns.length-60)
    return accepted
  }
  disconnect(slot: VoiceSeat) {
    delete this.reports[slot]; delete this.seenAt[slot]; delete this.lastIds[slot]
    // A new microphone/profile must not be correlated with the previous baseline.
    this.turns = this.turns.filter(t => t.slot !== slot)
  }
  lastTurn(slot: VoiceSeat) { return this.turns.filter(t=>t.slot===slot).at(-1) ?? null }
  canApply(condition: VoiceCondition, now = Date.now()): string | null {
    if (condition.mode === 'bypass' && !condition.audibility) return null
    const seats: VoiceSeat[] = condition.mode === 'match' || condition.audibility || condition.mode === 'audibility'
      ? ['P1','P2'] : [condition.targetSlot!]
    for (const s of seats) {
      const r = this.reports[s]
      if (!r || now-(this.seenAt[s] ?? 0)>1500) return `${s}: voice analysis unavailable`
      if (!voiceUsable(r.calibration)) return `${s}: voice baseline still collecting`
      if (r.health.state !== 'ready') return `${s}: voice processor not ready`
    }
    return null
  }
  snapshot(now = Date.now()): VoicePairState {
    const available = { P1: !!this.reports.P1 && now-(this.seenAt.P1 ?? 0)<1500,
      P2: !!this.reports.P2 && now-(this.seenAt.P2 ?? 0)<1500 }
    const result: VoicePairState = { condition: { ...this.condition }, reports: { ...this.reports }, available,
      pitchSynchrony: null, intensitySynchrony: null, turnCoordination: null, convergence: null,
      exploratoryIndex: null, pairedTurns: 0, reason: 'Waiting for two usable voice baselines and five turns each' }
    if (!available.P1 || !available.P2 || !voiceUsable(this.reports.P1!.calibration) || !voiceUsable(this.reports.P2!.calibration)) return result
    if (['P1','P2'].some(s => this.turns.filter(t=>t.slot===s).length<5)) return result
    const pairs: Array<[typeof this.turns[number], typeof this.turns[number]]> = []
    for (let i=1;i<this.turns.length;i++) {
      const a=this.turns[i-1], b=this.turns[i]
      if (a.slot!==b.slot && b.startedAt-a.endedAt<30000 && a.relativePitchZ!==null && b.relativePitchZ!==null &&
        a.relativeIntensityDb!==null && b.relativeIntensityDb!==null) pairs.push([a,b])
    }
    result.pairedTurns=pairs.length
    result.pitchSynchrony=correlation(pairs.map(([a])=>a.relativePitchZ!),pairs.map(([,b])=>b.relativePitchZ!))
    result.intensitySynchrony=correlation(pairs.map(([a])=>a.relativeIntensityDb!),pairs.map(([,b])=>b.relativeIntensityDb!))
    // Timing requires synchronized clocks. Negative gaps explicitly represent overlap.
    const clocksGood = [this.reports.P1!,this.reports.P2!].every(r=>r.clockUncertaintyMs!==null && r.clockUncertaintyMs<=50)
    if (pairs.length>=5 && clocksGood) {
      const gaps=pairs.map(([a,b])=>b.startedAt-a.endedAt)
      const m=gaps.reduce((s,x)=>s+x,0)/gaps.length
      result.turnCoordination=1/(1+Math.sqrt(gaps.reduce((s,x)=>s+(x-m)**2,0)/gaps.length)/1000)
    }
    if (pairs.length>=10) {
      const distance=pairs.map(([a,b])=>Math.hypot(a.relativePitchZ!-b.relativePitchZ!,(a.relativeIntensityDb!-b.relativeIntensityDb!)/3))
      const half=Math.floor(distance.length/2)
      result.convergence=distance.slice(0,half).reduce((s,x)=>s+x,0)/half - distance.slice(half).reduce((s,x)=>s+x,0)/(distance.length-half)
    }
    if (result.pitchSynchrony!==null && result.intensitySynchrony!==null && result.turnCoordination!==null)
      result.exploratoryIndex=100*(.4*(result.pitchSynchrony+1)/2+.3*(result.intensitySynchrony+1)/2+.3*result.turnCoordination)
    result.reason=result.exploratoryIndex===null ? 'Insufficient variation or clock precision for a combined index' : null
    return result
  }
}
