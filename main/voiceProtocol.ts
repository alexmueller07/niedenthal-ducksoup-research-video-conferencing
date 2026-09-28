// Voice measurements describe acoustics, not inferred emotion.
export const VOICE_VERSION = 'voice-1'
export type VoiceSeat = 'P1' | 'P2'
export type VoiceMode = 'bypass' | 'audibility' | 'match' | 'detone'
export type VoiceCalibrationState = 'uncalibrated' | 'collecting' | 'usable' | 'strong' | 'invalid'

export interface VoiceFeatures {
  speechActive: boolean
  speechProbability: number
  rmsDbfs: number
  peakDbfs: number
  relativeIntensityDb: number | null
  f0Hz: number | null
  f0Semitones: number | null
  relativePitchZ: number | null
  pitchClarity: number
  rollingPitchRangeSt: number | null
  rollingIntensityRangeDb: number | null
  voicedFraction: number
  noiseFloorDbfs: number
  clippingRate: number
}

export interface VoiceCalibration {
  state: VoiceCalibrationState
  confidence: number
  voicedSeconds: number
  validTurns: number
  baselinePitchSt: number | null
  baselinePitchRangeSt: number | null
  baselineIntensityDbfs: number | null
  baselineIntensityRangeDb: number | null
  noiseFloorDbfs: number
  snrDb: number | null
  frozen: boolean
  reason: string | null
}

export interface VoiceCondition {
  mode: VoiceMode
  targetSlot: VoiceSeat | null
  strength: number
  audibility: boolean
  pitchRangeScale: number
  intensityRangeScale: number
  pitchOffsetSemitones: number
  outputGainDb: number
}

export const DEFAULT_VOICE_CONDITION: VoiceCondition = {
  mode: 'bypass', targetSlot: null, strength: 1, audibility: false,
  pitchRangeScale: 1, intensityRangeScale: 1, pitchOffsetSemitones: 0, outputGainDb: 0,
}

export interface VoiceApplied {
  pitchSemitones: number
  gainDb: number
  audibilityGainDb: number
  limiterReductionDb: number
  pitchRangeScale: number
  intensityRangeScale: number
  active: boolean
  fallbackReason: string | null
}

export interface VoiceHealth {
  state: 'loading' | 'ready' | 'bypassed' | 'failed'
  reason: string | null
  engineVersion: string
  analysisDroppedFrames: number
  underruns: number
  bufferedMs: number | null
  // Actual end-to-end latency is measured by the loopback QA harness, not inferred from queue depth.
  measuredLatencyMs: number | null
  sampleRate: number
}

export interface VoiceTurn {
  id: number
  startedAt: number
  endedAt: number
  durationMs: number
  voicedMs: number
  pauseFraction: number
  meanPitchSt: number | null
  pitchRangeSt: number | null
  meanIntensityDbfs: number
  intensityRangeDb: number
  relativePitchZ: number | null
  relativeIntensityDb: number | null
  pitchRangeRatio: number | null
  intensityRangeRatio: number | null
  valid: boolean
}

export interface VoiceReport {
  version: typeof VOICE_VERSION
  sequence: number
  capturedAt: number
  clockUncertaintyMs: number | null
  clean: VoiceFeatures
  altered: VoiceFeatures
  calibration: VoiceCalibration
  condition: VoiceCondition
  applied: VoiceApplied
  health: VoiceHealth
  turns: VoiceTurn[]
  settings: {
    sampleRate?: number
    channelCount?: number
    echoCancellation?: boolean | string
    noiseSuppression?: boolean
    autoGainControl?: boolean
  }
}

export interface VoicePairState {
  condition: VoiceCondition
  reports: Partial<Record<VoiceSeat, VoiceReport>>
  available: Record<VoiceSeat, boolean>
  pitchSynchrony: number | null
  intensitySynchrony: number | null
  turnCoordination: number | null
  convergence: number | null
  exploratoryIndex: number | null
  pairedTurns: number
  reason: string | null
}

export function finite(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) }
export function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)) }
export function voiceUsable(c: VoiceCalibration) { return c.state === 'usable' || c.state === 'strong' }

export function parseVoiceCondition(input: unknown): VoiceCondition | null {
  if (!input || typeof input !== 'object') return null
  const v = input as VoiceCondition
  if (!['bypass', 'audibility', 'match', 'detone'].includes(v.mode) ||
    ![null, 'P1', 'P2'].includes(v.targetSlot) || typeof v.audibility !== 'boolean') return null
  const ranges: [keyof VoiceCondition, number, number][] = [
    ['strength', 0, 1], ['pitchRangeScale', 0.75, 1.15], ['intensityRangeScale', 0.8, 1.15],
    ['pitchOffsetSemitones', -0.75, 0.75], ['outputGainDb', -2, 2],
  ]
  if (ranges.some(([key, lo, hi]) => !finite(v[key]) || (v[key] as number) < lo || (v[key] as number) > hi)) return null
  if ((v.mode === 'match' || v.mode === 'detone') && v.targetSlot === null) return null
  return { mode: v.mode, targetSlot: v.targetSlot, strength: v.strength, audibility: v.audibility,
    pitchRangeScale: v.pitchRangeScale, intensityRangeScale: v.intensityRangeScale,
    pitchOffsetSemitones: v.pitchOffsetSemitones, outputGainDb: v.outputGainDb }
}

export function validVoiceReport(input: unknown): input is VoiceReport {
  if (!input || typeof input !== 'object') return false
  const r = input as VoiceReport
  if (r.version !== VOICE_VERSION || !Number.isSafeInteger(r.sequence) || r.sequence < 0 ||
    !finite(r.capturedAt) || !parseVoiceCondition(r.condition) || !Array.isArray(r.turns) || r.turns.length > 10) return false
  const n = (v: unknown, lo: number, hi: number) => finite(v) && v >= lo && v <= hi
  const optional = (v: unknown, lo: number, hi: number) => v === null || n(v, lo, hi)
  const text = (v: unknown) => v === null || typeof v === 'string' && v.length <= 512
  const timestamp = (v: unknown) => n(v, 0, 8640000000000000)
  // Validate every field used by the aggregator/logger before accepting telemetry.
  try { if (JSON.stringify(r).length > 16000) return false } catch { return false }
  if (!timestamp(r.capturedAt) || !optional(r.clockUncertaintyMs, 0, 60000)) return false
  for (const f of [r.clean, r.altered]) {
    if (!f || typeof f.speechActive !== 'boolean' || !n(f.rmsDbfs,-160,12) || !n(f.peakDbfs,-160,12) ||
      !n(f.pitchClarity,0,1) || !n(f.speechProbability,0,1) || !n(f.clippingRate,0,1) ||
      !n(f.voicedFraction,0,1) || !n(f.noiseFloorDbfs,-160,12) || !optional(f.f0Hz,40,1200) ||
      !optional(f.f0Semitones,-30,60) || !optional(f.relativePitchZ,-100,100) ||
      !optional(f.relativeIntensityDb,-172,172) || !optional(f.rollingPitchRangeSt,0,90) ||
      !optional(f.rollingIntensityRangeDb,0,172)) return false
  }
  const c=r.calibration, a=r.applied, h=r.health, s=r.settings
  if (!c || !['uncalibrated','collecting','usable','strong','invalid'].includes(c.state) ||
    !n(c.confidence,0,1) || !n(c.voicedSeconds,0,3600) || !Number.isSafeInteger(c.validTurns) || c.validTurns<0 ||
    !optional(c.baselinePitchSt,-30,60) || !optional(c.baselinePitchRangeSt,0,90) ||
    !optional(c.baselineIntensityDbfs,-160,12) || !optional(c.baselineIntensityRangeDb,0,172) ||
    !n(c.noiseFloorDbfs,-160,12) || !optional(c.snrDb,-172,172) || typeof c.frozen!=='boolean' || !text(c.reason)) return false
  if (voiceUsable(c) && (c.baselinePitchSt===null || c.baselineIntensityDbfs===null ||
    c.baselinePitchRangeSt===null || c.baselineIntensityRangeDb===null || c.voicedSeconds<20 || c.validTurns<3)) return false
  if (!a || !n(a.pitchSemitones,-12,12) || !n(a.gainDb,-160,12) || !n(a.audibilityGainDb,-6,6) || !n(a.limiterReductionDb,0,160) ||
    !n(a.pitchRangeScale,.75,1.15) || !n(a.intensityRangeScale,.8,1.15) || typeof a.active!=='boolean' || !text(a.fallbackReason)) return false
  if (!h || !['loading','ready','bypassed','failed'].includes(h.state) || !text(h.reason) ||
    typeof h.engineVersion!=='string' || h.engineVersion.length>128 || !n(h.analysisDroppedFrames,0,1e9) ||
    !n(h.underruns,0,1e9) || !optional(h.bufferedMs,0,60000) || !optional(h.measuredLatencyMs,0,60000) ||
    !n(h.sampleRate,8000,384000) || !s || typeof s!=='object') return false
  if (s.sampleRate!==undefined&&!n(s.sampleRate,8000,384000) || s.channelCount!==undefined&&!n(s.channelCount,1,32) ||
    s.noiseSuppression!==undefined&&typeof s.noiseSuppression!=='boolean' ||
    s.autoGainControl!==undefined&&typeof s.autoGainControl!=='boolean' ||
    s.echoCancellation!==undefined&&typeof s.echoCancellation!=='boolean'&&typeof s.echoCancellation!=='string') return false
  return r.turns.every(t => t && Number.isSafeInteger(t.id) && t.id>0 && timestamp(t.startedAt) && timestamp(t.endedAt) &&
    t.endedAt >= t.startedAt && n(t.durationMs,0,3600000) && Math.abs(t.endedAt-t.startedAt-t.durationMs)<1 &&
    n(t.voicedMs,0,t.durationMs+1) && n(t.pauseFraction,0,1) && optional(t.meanPitchSt,-30,60) &&
    optional(t.pitchRangeSt,0,90) && n(t.meanIntensityDbfs,-160,12) && n(t.intensityRangeDb,0,172) &&
    optional(t.relativePitchZ,-100,100) && optional(t.relativeIntensityDb,-172,172) &&
    optional(t.pitchRangeRatio,0,100) && optional(t.intensityRangeRatio,0,100) && typeof t.valid === 'boolean')
}
