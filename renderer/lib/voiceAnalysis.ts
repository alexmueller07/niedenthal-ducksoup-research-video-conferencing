import { clamp, voiceUsable } from '../../main/voiceProtocol'
import type { VoiceFeatures, VoiceCalibration, VoiceTurn, VoiceApplied, VoiceCondition } from '../../main/voiceProtocol'

export interface AcousticFrame {
  at: number
  durationMs: number
  rmsDbfs: number
  peakDbfs: number
  f0Hz: number | null
  pitchClarity: number
  clippingRate: number
  speechProbability: number
}

export function quantile(values: number[], p: number): number {
  if (!values.length) return 0
  const a = values.slice().sort((x, y) => x - y)
  const index = (a.length - 1) * p, low = Math.floor(index)
  return a[low] + (a[Math.ceil(index)] - a[low]) * (index - low)
}
const range = (v: number[]) => quantile(v, .9) - quantile(v, .1)
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)
export const semitones = (hz: number) => 12 * Math.log2(hz / 100)

export function emptyCalibration(): VoiceCalibration {
  return { state: 'uncalibrated', confidence: 0, voicedSeconds: 0, validTurns: 0,
    baselinePitchSt: null, baselinePitchRangeSt: null, baselineIntensityDbfs: null,
    baselineIntensityRangeDb: null, noiseFloorDbfs: -90, snrDb: null, frozen: false, reason: 'Waiting for speech' }
}

export class VoiceAnalysis {
  calibration = emptyCalibration()
  private noise: number[] = []
  private samples: AcousticFrame[] = []
  private recent: AcousticFrame[] = []
  private current: AcousticFrame[] = []
  private lastSpeechAt = 0
  private nextTurn = 1
  private pending: VoiceTurn[] = []
  private liveAt: number | null = null
  private lastAt: number | null = null
  private validTurns = 0

  setLive(at: number) { if (this.liveAt === null) this.liveAt = at }
  freeze() { if (voiceUsable(this.calibration)) this.calibration.frozen = true }
  reset() {
    this.calibration = emptyCalibration()
    this.noise = []; this.samples = []; this.recent = []; this.current = []; this.pending = []
    this.lastSpeechAt = 0; this.liveAt = null; this.lastAt = null; this.validTurns = 0
  }
  takeTurns() { return this.pending.splice(0) }
  flush() { this.finishTurn() }

  ingest(frame: AcousticFrame): VoiceFeatures {
    if (this.lastAt !== null && frame.at - this.lastAt > 500) this.finishTurn()
    this.lastAt = frame.at
    if (frame.speechProbability < .15 && frame.rmsDbfs > -120) {
      this.noise.push(frame.rmsDbfs)
      if (this.noise.length > 750) this.noise.shift()
    }
    const noise = this.noise.length >= 10 ? quantile(this.noise, .2) : -90
    const speech = frame.speechProbability >= .5 && frame.rmsDbfs > noise + 6
    const pitch = speech && frame.pitchClarity >= .8 && frame.f0Hz !== null ? semitones(frame.f0Hz) : null
    const accepted = speech && pitch !== null && frame.rmsDbfs - noise >= 12 && frame.clippingRate < .001
    if (accepted && !this.calibration.frozen && this.samples.length < 4000) this.samples.push(frame)
    this.recent.push({ ...frame, f0Hz: pitch === null ? null : frame.f0Hz, speechProbability: speech ? frame.speechProbability : 0 })
    while (this.recent.length && this.recent[0].at < frame.at - 10000) this.recent.shift()
    if (speech) {
      this.current.push({ ...frame, f0Hz: pitch === null ? null : frame.f0Hz })
      this.lastSpeechAt = frame.at
    } else if (this.current.length && frame.at - this.lastSpeechAt >= 600) this.finishTurn()
    this.updateCalibration(noise)
    if (this.liveAt !== null && frame.at - this.liveAt >= 90000) this.freeze()
    if (this.calibration.state === 'strong') this.freeze()
    const c = this.calibration
    const speechFrames = this.recent.filter(f => f.speechProbability >= .5)
    const pitches = speechFrames.filter(f => f.f0Hz !== null).map(f => semitones(f.f0Hz!))
    return {
      speechActive: speech, speechProbability: frame.speechProbability, rmsDbfs: frame.rmsDbfs,
      peakDbfs: frame.peakDbfs, f0Hz: pitch === null ? null : frame.f0Hz, f0Semitones: pitch,
      relativePitchZ: pitch !== null && c.baselinePitchSt !== null ? (pitch - c.baselinePitchSt) / Math.max(1, (c.baselinePitchRangeSt ?? 0) / 2.56) : null,
      relativeIntensityDb: speech && c.baselineIntensityDbfs !== null ? frame.rmsDbfs - c.baselineIntensityDbfs : null,
      pitchClarity: frame.pitchClarity,
      rollingPitchRangeSt: pitches.length >= 10 ? range(pitches) : null,
      rollingIntensityRangeDb: speechFrames.length >= 10 ? range(speechFrames.map(f => f.rmsDbfs)) : null,
      voicedFraction: pitches.length / Math.max(1, this.recent.length), noiseFloorDbfs: noise, clippingRate: frame.clippingRate,
    }
  }

  private updateCalibration(noise: number) {
    if (this.calibration.frozen) return
    const pitches = this.samples.map(f => semitones(f.f0Hz!))
    const levels = this.samples.map(f => f.rmsDbfs)
    const seconds = this.samples.reduce((s, f) => s + f.durationMs, 0) / 1000
    const level = levels.length ? quantile(levels, .5) : null
    const snr = level === null ? null : level - noise
    const noiseKnown = this.noise.length >= 10
    const usable = seconds >= 20 && this.validTurns >= 3 && noiseKnown && (snr ?? 0) >= 12
    const strong = seconds >= 45 && this.validTurns >= 5 && noiseKnown && (snr ?? 0) >= 18
    this.calibration = {
      state: strong ? 'strong' : usable ? 'usable' : seconds > 0 ? 'collecting' : 'uncalibrated',
      confidence: clamp(Math.min(seconds / 45, this.validTurns / 5, noiseKnown ? (snr ?? 0) / 18 : .25), 0, 1),
      voicedSeconds: seconds, validTurns: this.validTurns,
      baselinePitchSt: pitches.length ? quantile(pitches, .5) : null,
      baselinePitchRangeSt: pitches.length >= 10 ? range(pitches) : null,
      baselineIntensityDbfs: level, baselineIntensityRangeDb: levels.length >= 10 ? range(levels) : null,
      noiseFloorDbfs: noise, snrDb: snr, frozen: false,
      reason: usable ? null : !noiseKnown ? 'Waiting for a quiet pause' : (snr ?? 0) < 12 && seconds > 0 ? 'Low signal-to-noise ratio' : 'Collecting natural speech across several turns',
    }
  }

  private finishTurn() {
    const fs = this.current.splice(0)
    if (!fs.length) return
    const pitch = fs.filter(f => f.f0Hz !== null && f.pitchClarity >= .8).map(f => semitones(f.f0Hz!))
    const levels = fs.map(f => f.rmsDbfs)
    const startedAt = fs[0].at - fs[0].durationMs, endedAt = fs[fs.length - 1].at
    const voicedMs = fs.filter(f => f.f0Hz !== null).reduce((s, f) => s + f.durationMs, 0)
    const speechMs = fs.reduce((s, f) => s + f.durationMs, 0)
    const valid = voicedMs >= 500 && fs.every(f => f.clippingRate < .01)
    if (valid) this.validTurns++
    const c = this.calibration, mp = pitch.length ? mean(pitch) : null, mi = mean(levels)
    this.pending.push({
      id: this.nextTurn++, startedAt, endedAt, durationMs: endedAt - startedAt, voicedMs,
      pauseFraction: clamp(1 - speechMs / Math.max(1, endedAt - startedAt), 0, 1),
      meanPitchSt: mp, pitchRangeSt: pitch.length >= 5 ? range(pitch) : null,
      meanIntensityDbfs: mi, intensityRangeDb: range(levels),
      relativePitchZ: mp !== null && c.baselinePitchSt !== null ? (mp - c.baselinePitchSt) / Math.max(1, (c.baselinePitchRangeSt ?? 0) / 2.56) : null,
      relativeIntensityDb: c.baselineIntensityDbfs !== null ? mi - c.baselineIntensityDbfs : null,
      pitchRangeRatio: pitch.length >= 5 && (c.baselinePitchRangeSt ?? 0) >= 1 ? range(pitch) / c.baselinePitchRangeSt! : null,
      intensityRangeRatio: (c.baselineIntensityRangeDb ?? 0) >= 3 ? range(levels) / c.baselineIntensityRangeDb! : null, valid,
    })
    if (this.pending.length > 10) this.pending.shift()
  }
}

export const IDENTITY_VOICE: VoiceApplied = { pitchSemitones: 0, gainDb: 0, audibilityGainDb: 0, limiterReductionDb: 0,
  pitchRangeScale: 1, intensityRangeScale: 1, active: false, fallbackReason: null }

export function voiceAdjustment(condition: VoiceCondition, target: boolean, features: VoiceFeatures,
  c: VoiceCalibration, partner: VoiceTurn | null, now: number, healthy: boolean): VoiceApplied {
  const out = { ...IDENTITY_VOICE }
  if (!healthy) return { ...out, fallbackReason: 'Voice processor unavailable' }
  const needCalibration = condition.audibility || condition.mode === 'audibility' || (target && ['match','detone'].includes(condition.mode))
  if (needCalibration && !voiceUsable(c)) return { ...out, fallbackReason: c.reason ?? 'Collecting voice baseline' }
  if (features.clippingRate > .001) return { ...out, fallbackReason: 'Microphone clipping' }
  if (features.speechActive && features.rmsDbfs - features.noiseFloorDbfs < 12)
    return { ...out, fallbackReason: 'Low signal-to-noise ratio' }
  if (condition.audibility || condition.mode === 'audibility') {
    out.audibilityGainDb = clamp(-24 - c.baselineIntensityDbfs!, -6, 6)
    out.gainDb = out.audibilityGainDb
  }
  if (!target || !['match','detone'].includes(condition.mode)) return out
  if (!features.speechActive || features.f0Semitones === null || features.pitchClarity < .8)
    return { ...out, fallbackReason: 'Waiting for clear voiced speech' }
  const s = condition.strength
  let pitchOffset = 0, intensityOffset = 0
  if (condition.mode === 'match') {
    if (!partner || now - partner.endedAt > 30000 || !partner.valid)
      return { ...out, fallbackReason: 'Waiting for a recent partner turn' }
    // Use only the last completed CLEAN partner turn; never chase altered output.
    pitchOffset = clamp((partner.relativePitchZ ?? 0) * .25, -.75, .75) * s
    intensityOffset = clamp((partner.relativeIntensityDb ?? 0) * .25, -2, 2) * s
    out.pitchRangeScale = 1 + (clamp(partner.pitchRangeRatio ?? 1, .85, 1.15) - 1) * s
    out.intensityRangeScale = 1 + (clamp(partner.intensityRangeRatio ?? 1, .85, 1.15) - 1) * s
  } else {
    out.pitchRangeScale = 1 + (condition.pitchRangeScale - 1) * s
    out.intensityRangeScale = 1 + (condition.intensityRangeScale - 1) * s
  }
  const deltaPitch = features.f0Semitones - c.baselinePitchSt!
  out.pitchSemitones = clamp(pitchOffset + condition.pitchOffsetSemitones * s +
    deltaPitch * (out.pitchRangeScale - 1), -.75, .75)
  out.gainDb += clamp(intensityOffset + condition.outputGainDb * s +
    (features.relativeIntensityDb ?? 0) * (out.intensityRangeScale - 1), -2, 2)
  out.active = true
  return out
}
