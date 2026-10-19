import fs from 'node:fs'
import path from 'node:path'
import type { VoiceCondition, VoiceFeatures, VoicePairState, VoiceReport, VoiceSeat, VoiceTurn } from './voiceProtocol'
import { VOICE_VERSION } from './voiceProtocol'
import { formatLocalDate, formatLocalTimeOfDay } from './timeFormat'

// Same layout as face/face_and_voice_changes_<seat>.csv: who/when first, then the
// readings worth looking at, then the changes applied, then the raw
// measurements kept for later analysis, then data-quality checks last.
// "clean" is the microphone before any change; "altered" is what the partner heard.

const rawKeys = ['speechActive','speechProbability','rmsDbfs','peakDbfs','f0Hz','f0Semitones',
  'relativePitchZ','relativeIntensityDb','pitchClarity','rollingPitchRangeSt','rollingIntensityRangeDb',
  'voicedFraction','noiseFloorDbfs','clippingRate'] as const
const rawNames = ['speaking','speech_probability','loudness_db','peak_loudness_db','pitch_hz','pitch_semitones',
  'relative_pitch','relative_loudness','pitch_clarity','pitch_range','loudness_range',
  'voiced_share','noise_floor_db','clipping_rate']
const who = ['pair_id','participant_id','partner_id','seat','date','time','elapsed_ms','conversation_elapsed_ms','phase']
const header = [...who,
  'speaking','pitch_hz','loudness_db','relative_pitch','relative_loudness','pitch_range','loudness_range',
  'partner_heard_pitch_hz','partner_heard_loudness_db',
  'voice_baseline','voice_baseline_confidence',
  'voice_condition','voice_condition_target','voice_change_active','pitch_change','volume_change',
  'pitch_range_change','loudness_range_change','audibility_boost','fell_back_to_natural_because',
  'pitch_sync','loudness_sync','turn_taking_sync','convergence','overall_sync','paired_turns',
  ...['clean','altered'].flatMap(p=>rawNames.map(n=>`raw_${p}_${n}`)),
  'noise_floor_db','signal_to_noise_db','clipping_rate','voice_processor']
const turnHeader = ['pair_id','participant_id','partner_id','seat','turn','date','time','elapsed_ms','conversation_elapsed_ms','phase',
  'duration_sec','speaking_sec','pause_share','average_pitch_hz','pitch_range_semitones','average_loudness_db','loudness_range_db',
  'relative_pitch','relative_loudness','pitch_range_vs_usual','loudness_range_vs_usual',
  'gap_after_partner_ms','overlap_with_partner_ms','usable']

/** Quote only when needed, like the other session CSVs. */
const cell = (v: unknown) => {
  if (v == null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s
}
const row = (v: unknown[]) => v.map(cell).join(',')+'\n'
/** Readable precision: two decimals is plenty for every voice number. */
const r2 = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v*100)/100 : ''
const r1 = (v: number | null | undefined) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v*10)/10 : ''
/** Semitones relative to 100 Hz, back to Hz. */
const stToHz = (st: number | null) => st === null ? null : 100*2**(st/12)
/** The dashboard calls the no-change setting "Natural"; say the same here. */
export const modeName = (mode: string) => mode === 'bypass' ? 'natural' : mode
const raw = (f: VoiceFeatures) => rawKeys.map(k => typeof f[k] === 'boolean' ? f[k] : r2(f[k] as number | null))

export interface VoiceLogContext {
  slot: VoiceSeat
  participantId: string
  dyadId: string
  partnerId?: string
  phase: string
  liveStartedAtMs: number | null
}

export class VoiceLogger {
  private streams = new Map<string, fs.WriteStream>()
  private previous: Partial<Record<VoiceSeat, VoiceTurn>> = {}
  private seats: Partial<Record<VoiceSeat, unknown>> = {}
  private conditions: Array<{ at: string; condition: VoiceCondition }> = []
  private closed = false
  constructor(private dir: string, private startedAt: number) {}
  private stream(name: string, columns: string[]) {
    let s=this.streams.get(name)
    if (!s) {
      fs.mkdirSync(this.dir,{recursive:true})
      s=fs.createWriteStream(path.join(this.dir,name),{flags:'a'});s.write(row(columns));this.streams.set(name,s)
    }
    return s
  }
  condition(c: VoiceCondition) { this.conditions.push({at:new Date().toISOString(),condition:{...c}}) }
  private when(ctx: VoiceLogContext, at: number) {
    return [formatLocalDate(at),formatLocalTimeOfDay(at),at-this.startedAt,
      ctx.liveStartedAtMs===null||ctx.phase==='waiting'?'':at-ctx.liveStartedAtMs,ctx.phase]
  }
  write(ctx: VoiceLogContext, r: VoiceReport, pair: VoicePairState, turns: VoiceTurn[]) {
    if (this.closed) return
    const now=Date.now(), c=r.calibration, a=r.applied, clean=r.clean, heard=r.altered
    const ids=[ctx.dyadId,ctx.participantId,ctx.partnerId??'',ctx.slot]
    this.stream(`voice_measurements_${ctx.slot}.csv`,header).write(row([
      ...ids,...this.when(ctx,now),
      clean.speechActive,r1(clean.f0Hz),r2(clean.rmsDbfs),r2(clean.relativePitchZ),r2(clean.relativeIntensityDb),
      r2(clean.rollingPitchRangeSt),r2(clean.rollingIntensityRangeDb),
      r1(heard.f0Hz),r2(heard.rmsDbfs),
      c.state,r2(c.confidence),
      modeName(r.condition.mode),r.condition.targetSlot,a.active,r2(a.pitchSemitones),r2(a.gainDb),
      r2(a.pitchRangeScale),r2(a.intensityRangeScale),r2(a.audibilityGainDb),a.fallbackReason,
      r2(pair.pitchSynchrony),r2(pair.intensitySynchrony),r2(pair.turnCoordination),r2(pair.convergence),
      r2(pair.exploratoryIndex),pair.pairedTurns,
      ...raw(clean),...raw(heard),
      r2(c.noiseFloorDbfs),r2(c.snrDb),r2(clean.clippingRate),r.health.state,
    ]))
    this.seats[ctx.slot]={analysisVersion:r.version,engineVersion:r.health.engineVersion,settings:r.settings,calibration:c}
    for (const t of turns) {
      const other=this.previous[ctx.slot==='P1'?'P2':'P1']
      const timed=r.clockUncertaintyMs!==null&&r.clockUncertaintyMs<=50
      const gap=other&&timed?t.startedAt-other.endedAt:null
      const overlap=other&&timed?Math.max(0,Math.min(t.endedAt,other.endedAt)-Math.max(t.startedAt,other.startedAt)):null
      this.stream('speaking_turns.csv',turnHeader).write(row([
        ...ids,t.id,...this.when(ctx,t.startedAt),
        r1(t.durationMs/1000),r1(t.voicedMs/1000),r2(t.pauseFraction),r1(stToHz(t.meanPitchSt)),r2(t.pitchRangeSt),
        r2(t.meanIntensityDbfs),r2(t.intensityRangeDb),r2(t.relativePitchZ),r2(t.relativeIntensityDb),
        r2(t.pitchRangeRatio),r2(t.intensityRangeRatio),gap===null?'':Math.round(gap),overlap===null?'':Math.round(overlap),t.valid,
      ]))
      this.previous[ctx.slot]=t
    }
  }
  manifest() { return {version:VOICE_VERSION,seats:this.seats,conditions:this.conditions,files:[...this.streams.keys()],
    units:{pitch:'Hz; ranges in semitones',loudness:'decibels below the loudest possible digital level, not room loudness'},
    synchrony:'Exploratory acoustic statistics, not validated emotion or rapport scores'} }
  async close() {
    this.closed=true
    await Promise.all([...this.streams.values()].map(s=>new Promise<void>(resolve=>s.end(resolve))))
  }
}
