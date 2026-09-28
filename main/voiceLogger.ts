import fs from 'node:fs'
import path from 'node:path'
import type { VoiceCondition, VoicePairState, VoiceReport, VoiceSeat, VoiceTurn } from './voiceProtocol'
import { VOICE_VERSION } from './voiceProtocol'

const featureKeys = ['speechActive','speechProbability','rmsDbfs','peakDbfs','f0Hz','f0Semitones',
  'relativePitchZ','relativeIntensityDb','pitchClarity','rollingPitchRangeSt','rollingIntensityRangeDb',
  'voicedFraction','noiseFloorDbfs','clippingRate'] as const
const featureNames = ['speech_active','speech_probability','rms_dbfs','peak_dbfs','f0_hz','pitch_st',
  'relative_pitch_z','relative_intensity_db','pitch_clarity','pitch_range_st','intensity_range_db',
  'voiced_fraction','noise_floor_dbfs','clipping_rate']
const prefix = ['seat','participant_id','pair_id','phase','received_at_utc','elapsed_ms','conversation_elapsed_ms']
const header = [...prefix,'sequence','captured_at_utc','clock_uncertainty_ms',
  ...['clean','altered'].flatMap(p=>featureNames.map(n=>`${p}_${n}`)),
  'calibration_state','calibration_confidence','voiced_seconds','valid_turns','baseline_pitch_st',
  'baseline_pitch_range_st','baseline_intensity_dbfs','baseline_intensity_range_db','snr_db','baseline_frozen',
  'requested_mode','target_seat','strength','audibility_enabled','requested_pitch_range_scale','requested_intensity_range_scale',
  'requested_pitch_offset_st','requested_output_gain_db','applied_pitch_st','applied_gain_db','audibility_gain_db','limiter_reduction_db',
  'applied_pitch_range_scale','applied_intensity_range_scale','effect_active','fallback_reason','processor_state',
  'analysis_dropped_frames','processor_underruns','buffered_ms','measured_latency_ms','sample_rate',
  'pitch_synchrony','intensity_synchrony','turn_coordination','convergence','exploratory_index','paired_turns']
const turnHeader = [...prefix,'turn_id','started_at_utc','ended_at_utc','duration_ms','voiced_ms','pause_fraction',
  'mean_pitch_st','pitch_range_st','mean_intensity_dbfs','intensity_range_db','relative_pitch_z','relative_intensity_db',
  'pitch_range_ratio','intensity_range_ratio','valid','response_gap_ms','overlap_ms','clock_uncertainty_ms']
const cell = (v: unknown) => v == null ? '' : `"${String(v).replace(/"/g,'""')}"`
const row = (v: unknown[]) => v.map(cell).join(',')+'\n'
export interface VoiceLogContext { slot: VoiceSeat; participantId: string; dyadId: string; phase: string; liveStartedAtMs: number | null }

export class VoiceLogger {
  private streams = new Map<string, fs.WriteStream>()
  private previous: Partial<Record<VoiceSeat, VoiceTurn>> = {}
  private seats: Partial<Record<VoiceSeat, unknown>> = {}
  private conditions: Array<{ at: string; condition: VoiceCondition }> = []
  private closed = false
  constructor(private dir: string, private startedAt: number) {}
  private stream(name: string, columns: string[]) {
    let s=this.streams.get(name)
    if (!s) { s=fs.createWriteStream(path.join(this.dir,name),{flags:'a'});s.write(row(columns));this.streams.set(name,s) }
    return s
  }
  condition(c: VoiceCondition) { this.conditions.push({at:new Date().toISOString(),condition:{...c}}) }
  write(ctx: VoiceLogContext, r: VoiceReport, pair: VoicePairState, turns: VoiceTurn[]) {
    if (this.closed) return
    const now=Date.now(), c=r.calibration, a=r.applied
    const common=[ctx.slot,ctx.participantId,ctx.dyadId,ctx.phase,new Date(now).toISOString(),now-this.startedAt,
      ctx.liveStartedAtMs===null?'':now-ctx.liveStartedAtMs]
    this.stream(`voice_features_${ctx.slot}.csv`,header).write(row([
      ...common,r.sequence,new Date(r.capturedAt).toISOString(),r.clockUncertaintyMs,
      ...[r.clean,r.altered].flatMap(f=>featureKeys.map(k=>f[k])),
      c.state,c.confidence,c.voicedSeconds,c.validTurns,c.baselinePitchSt,c.baselinePitchRangeSt,
      c.baselineIntensityDbfs,c.baselineIntensityRangeDb,c.snrDb,c.frozen,
      r.condition.mode,r.condition.targetSlot,r.condition.strength,r.condition.audibility,r.condition.pitchRangeScale,
      r.condition.intensityRangeScale,r.condition.pitchOffsetSemitones,r.condition.outputGainDb,
      a.pitchSemitones,a.gainDb,a.audibilityGainDb,a.limiterReductionDb,a.pitchRangeScale,a.intensityRangeScale,a.active,a.fallbackReason,
      r.health.state,r.health.analysisDroppedFrames,r.health.underruns,r.health.bufferedMs,r.health.measuredLatencyMs,r.health.sampleRate,
      pair.pitchSynchrony,pair.intensitySynchrony,pair.turnCoordination,pair.convergence,pair.exploratoryIndex,pair.pairedTurns,
    ]))
    this.seats[ctx.slot]={analysisVersion:r.version,engineVersion:r.health.engineVersion,settings:r.settings,calibration:c}
    for (const t of turns) {
      const other=this.previous[ctx.slot==='P1'?'P2':'P1']
      const timed=r.clockUncertaintyMs!==null&&r.clockUncertaintyMs<=50
      const gap=other&&timed?t.startedAt-other.endedAt:null
      const overlap=other&&timed?Math.max(0,Math.min(t.endedAt,other.endedAt)-Math.max(t.startedAt,other.startedAt)):null
      this.stream('voice_turns.csv',turnHeader).write(row([
        ...common,t.id,new Date(t.startedAt).toISOString(),new Date(t.endedAt).toISOString(),t.durationMs,t.voicedMs,
        t.pauseFraction,t.meanPitchSt,t.pitchRangeSt,t.meanIntensityDbfs,t.intensityRangeDb,t.relativePitchZ,t.relativeIntensityDb,
        t.pitchRangeRatio,t.intensityRangeRatio,t.valid,gap,overlap,r.clockUncertaintyMs,
      ]))
      this.previous[ctx.slot]=t
    }
  }
  manifest() { return {version:VOICE_VERSION,seats:this.seats,conditions:this.conditions,files:[...this.streams.keys()],
    units:{pitch:'semitones relative to 100 Hz',level:'dBFS, not acoustic SPL'},
    synchrony:'Exploratory acoustic statistics, not validated emotion or rapport scores'} }
  async close() {
    this.closed=true
    await Promise.all([...this.streams.values()].map(s=>new Promise<void>(resolve=>s.end(resolve))))
  }
}
