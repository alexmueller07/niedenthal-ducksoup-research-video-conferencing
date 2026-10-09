import type SignalsmithStretchFactory from 'signalsmith-stretch'
import type { SignalsmithStretchNode } from 'signalsmith-stretch'
import { DEFAULT_VOICE_CONDITION, VOICE_VERSION, clamp } from '../../main/voiceProtocol'
import type { VoiceApplied, VoiceCondition, VoiceFeatures, VoiceHealth, VoiceReport, VoiceSeat, VoiceTurn } from '../../main/voiceProtocol'
import { VoiceAnalysis, IDENTITY_VOICE, voiceAdjustment } from './voiceAnalysis'
import type { AcousticFrame } from './voiceAnalysis'
import { VOICE_STRETCH, VOICE_SMILE_SEMITONES } from './voiceDspConfig'

export class VoiceProcessor {
  readonly context: AudioContext
  readonly outputStream: MediaStream
  private source: MediaStreamAudioSourceNode
  private destination: MediaStreamAudioDestinationNode
  private dryDelay: DelayNode
  private dry: GainNode
  private wet: GainNode
  private gain: GainNode
  private shifter: SignalsmithStretchNode | null = null
  private shift = { semitones: 0, formantSemitones: 0 }
  private limiter: AudioWorkletNode | null = null
  private tap: AudioWorkletNode | null = null
  private worker: Worker | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private analysis = new VoiceAnalysis()
  private alteredAnalysis = new VoiceAnalysis()
  private clean: VoiceFeatures | null = null
  private altered: VoiceFeatures | null = null
  private condition: VoiceCondition = { ...DEFAULT_VOICE_CONDITION }
  private applied: VoiceApplied = { ...IDENTITY_VOICE }
  private partner: VoiceTurn | null = null
  private pendingPartner: VoiceTurn | null = null
  private slot: VoiceSeat | null = null
  private sequence = 0
  private legacySemitones = 0
  private smile = 0
  private lastFrame = 0
  private started = false
  private closed = false
  private levelAnalyser: AnalyserNode
  private levelBuffer: Float32Array<ArrayBuffer>
  private epochOffset = 0
  private clockUncertainty: number | null = null
  private phase: 'waiting' | 'live' | 'ended' = 'waiting'
  private startedAt = 0
  private rampTargets = new WeakMap<AudioParam, number>()
  private limiterReductionDb = 0
  private health: VoiceHealth = { state: 'loading', reason: null, engineVersion: 'signalsmith-stretch-1.3.2',
    analysisDroppedFrames: 0, underruns: 0, bufferedMs: null, measuredLatencyMs: null, sampleRate: 0 }

  constructor(private micStream: MediaStream) {
    this.context = new AudioContext({ latencyHint: 'interactive' })
    const ctx = this.context
    this.source = ctx.createMediaStreamSource(micStream)
    this.levelAnalyser = ctx.createAnalyser()
    this.levelAnalyser.fftSize = 512
    this.levelBuffer = new Float32Array(new ArrayBuffer(this.levelAnalyser.fftSize * 4))
    this.source.connect(this.levelAnalyser)
    this.destination = ctx.createMediaStreamDestination()
    // The dry path is delayed to match the shifter, so switching between them
    // never overlaps two offset copies, and Neutral has the same delay as a change.
    this.dryDelay = ctx.createDelay(1)
    this.dry = ctx.createGain(); this.wet = ctx.createGain(); this.gain = ctx.createGain()
    this.wet.gain.value = 0
    this.source.connect(this.dryDelay).connect(this.dry).connect(this.gain).connect(this.destination)
    this.outputStream = this.destination.stream
    this.health.sampleRate = ctx.sampleRate
  }

  async resume() {
    await this.context.resume()
    this.started = true
    this.startedAt = this.context.currentTime
    const assets = new URL('/voice/', window.location.href).href
    // Started before setup so a load that never finishes still times out.
    this.watchdog = setInterval(() => {
      if (this.health.state === 'ready' && performance.now() - this.lastFrame > 1000) this.fail('Voice analysis stalled')
      if (this.health.state === 'loading' && this.context.currentTime - this.startedAt > 30) this.fail('Voice initialization timed out')
      if (this.context.state !== 'running') this.fail('Audio context suspended')
    }, 250)
    try {
      // Loaded from /voice/ unbundled: the library copies its own source into the
      // audio worklet, and bundler-inserted helpers don't exist there.
      const { default: SignalsmithStretch }: { default: typeof SignalsmithStretchFactory } =
        await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ `${assets}signalsmith-stretch.mjs`)
      const shifter = await SignalsmithStretch(this.context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      await this.context.audioWorklet.addModule(`${assets}voice.worklet.js`)
      if (this.closed) return
      await shifter.configure(VOICE_STRETCH)
      // Formant compensation keeps the speaker's own vocal resonances when pitch moves.
      await shifter.schedule({ active: true, semitones: 0, formantSemitones: 0, formantCompensation: true, formantBaseHz: 0 })
      const latency = await shifter.latency()
      if (this.closed) return
      this.shifter = shifter
      this.dryDelay.delayTime.value = latency
      this.health.bufferedMs = latency * 1000
      this.source.connect(this.shifter).connect(this.wet).connect(this.gain)
      this.limiter = new AudioWorkletNode(this.context, 'voice-limiter', { outputChannelCount: [1] })
      this.limiter.port.onmessage = ({ data }) => {
        if (data?.type === 'limiter' && Number.isFinite(data.reductionDb)) this.limiterReductionDb = data.reductionDb
      }
      this.gain.disconnect()
      this.gain.connect(this.limiter).connect(this.destination)
      this.tap = new AudioWorkletNode(this.context, 'voice-tap', { numberOfInputs: 2, outputChannelCount: [1] })
      this.source.connect(this.tap, 0, 0)
      this.limiter.connect(this.tap, 0, 1)
      this.tap.connect(this.context.destination)
      this.worker = new Worker(`${assets}analysis.worker.js`, { type: 'module' })
      this.worker.postMessage({ type: 'init', assets, sampleRate: this.context.sampleRate })
      this.tap.port.onmessage = ({ data }) => {
        if (this.closed) return
        const at = Date.now() + this.epochOffset - (this.context.currentTime - data.audioTime) * 1000
        this.worker?.postMessage({ ...data, at }, [data.clean.buffer, data.altered.buffer])
      }
      this.worker.onmessage = ({ data }) => {
        if (this.closed) return
        if (data.type === 'error') this.fail(`Voice analysis failed: ${data.message}`)
        if (data.type === 'ready') { this.health.state = 'ready'; this.health.reason = null; this.lastFrame = performance.now() }
        if (data.type === 'features') this.onFrame(data)
      }
      this.worker.onerror = () => this.fail('Voice analysis worker stopped')
      this.shifter.onprocessorerror = () => this.fail('Pitch processor stopped')
      this.limiter.onprocessorerror = () => {
        this.fail('Output limiter stopped')
        this.gain.disconnect(); this.gain.connect(this.destination)
      }
    } catch (error) { this.fail(`Voice processor unavailable: ${String(error)}`) }
  }

  private onFrame(data: { at: number; durationMs: number; clean: Omit<AcousticFrame, 'at' | 'durationMs' | 'speechProbability'>;
    altered: Omit<AcousticFrame, 'at' | 'durationMs' | 'speechProbability'>; speechProbability: number; dropped: number }) {
    this.lastFrame = performance.now()
    this.health.analysisDroppedFrames = data.dropped
    const wasSpeaking = this.clean?.speechActive ?? false
    this.clean = this.analysis.ingest({ ...data.clean, at: data.at, durationMs: data.durationMs, speechProbability: data.speechProbability })
    this.altered = this.alteredAnalysis.ingest({ ...data.altered, at: data.at, durationMs: data.durationMs, speechProbability: data.speechProbability })
    if (!wasSpeaking && this.clean.speechActive) this.partner = this.pendingPartner
    const target = this.slot !== null && this.condition.targetSlot === this.slot
    this.applied = voiceAdjustment(this.condition, target, this.clean, this.analysis.calibration, this.partner,
      data.at, this.health.state === 'ready')
    if (this.phase === 'ended') this.applied = { ...IDENTITY_VOICE }
    const manual = this.condition.mode === 'bypass' && this.health.state === 'ready' && this.phase !== 'ended'
    const legacy = manual ? this.legacySemitones : 0
    const smile = manual ? this.smile : 0
    // Keep one path across phonemes. Switching dry/wet for every unvoiced
    // consonant would splice together signals with different processing delays.
    const expressiveRoute = target && ['match','detone'].includes(this.condition.mode) &&
      this.analysis.calibration.frozen && this.health.state==='ready' && this.phase!=='ended'
    this.applyAudio(this.applied.pitchSemitones + legacy, smile * VOICE_SMILE_SEMITONES, this.applied.gainDb,
      expressiveRoute || Math.abs(legacy) > .001 || Math.abs(smile) > .001)
  }

  private ramp(param: AudioParam, target: number, seconds: number, lo = -Infinity, hi = Infinity) {
    if (this.rampTargets.get(param) === target) return
    this.rampTargets.set(param, target)
    const now = this.context.currentTime
    // Some Chromium builds extrapolate cancelAndHoldAtTime through a replaced
    // linear ramp. Explicitly anchor and clamp the current value so rapidly
    // changing speech features can never push the real AudioParam past policy.
    const current = clamp(Number.isFinite(param.value) ? param.value : target, lo, hi)
    param.cancelScheduledValues(now)
    param.setValueAtTime(current, now)
    param.linearRampToValueAtTime(clamp(target, lo, hi), now + seconds)
  }
  // Small moves are skipped so Match/Detone don't re-target the shifter on every frame.
  private setShift(semitones: number, formantSemitones: number) {
    const moved = (a: number, b: number) => a === 0 ? b !== 0 : Math.abs(a - b) >= .05
    if (!this.shifter || !moved(semitones, this.shift.semitones) && !moved(formantSemitones, this.shift.formantSemitones)) return
    this.shift = { semitones, formantSemitones }
    void this.shifter.schedule({ ...this.shift, formantCompensation: true })
  }
  private applyAudio(pitch: number, formant: number, gainDb: number, wet: boolean) {
    const expressive = this.condition.mode === 'match' || this.condition.mode === 'detone'
    const audibility = this.condition.audibility || this.condition.mode === 'audibility'
    // The manual pitch control and audibility correction have their own limits.
    // Expressive adjustments remain bounded before adding the fixed level correction.
    const pitchLimit = this.condition.mode === 'bypass' && !audibility ? 1 : .75
    const gainLimit = (audibility ? 6 : 0) + (expressive ? 2 : 0)
    this.setShift(clamp(pitch, -pitchLimit, pitchLimit), clamp(formant, -VOICE_SMILE_SEMITONES, VOICE_SMILE_SEMITONES))
    this.ramp(this.gain.gain, 10 ** (clamp(gainDb,-gainLimit,gainLimit) / 20), .35,
      10 ** (-gainLimit/20), 10 ** (gainLimit/20))
    this.ramp(this.wet.gain, wet ? 1 : 0, .03, 0, 1)
    this.ramp(this.dry.gain, wet ? 0 : 1, .03, 0, 1)
  }
  private fail(reason: string) {
    this.health.state = 'failed'; this.health.reason = reason
    this.applied = { ...IDENTITY_VOICE, fallbackReason: reason }
    this.applyAudio(0, 0, 0, false)
  }

  setSemitones(v: number) { this.legacySemitones = Number.isFinite(v) ? clamp(v, -1, 1) : 0 }
  setSmile(v: number) { this.smile = Number.isFinite(v) ? clamp(v, -1, 1) : 0 }
  setSlot(slot: VoiceSeat) { this.slot = slot }
  setClock(offset: number, uncertaintyMs: number) { this.epochOffset = offset; this.clockUncertainty = uncertaintyMs }
  setPhase(phase: 'waiting' | 'live' | 'ended') {
    this.phase = phase
    if (phase === 'live') this.analysis.setLive(Date.now() + this.epochOffset)
    if (phase === 'ended') { this.analysis.flush(); this.applyAudio(0, 0, 0, false) }
  }
  setCondition(condition: VoiceCondition) {
    this.condition = { ...condition }
    if (condition.mode !== 'bypass' || condition.audibility) { this.analysis.freeze(); this.legacySemitones = 0; this.smile = 0 }
    if (condition.mode === 'bypass' && !condition.audibility) {
      this.legacySemitones = 0; this.smile = 0
      this.applied = { ...IDENTITY_VOICE }
      this.applyAudio(0, 0, 0, false)
    }
  }
  setPartnerTurn(turn: VoiceTurn | null) { this.pendingPartner = turn; if (!this.clean?.speechActive) this.partner = turn }
  resetCalibration() { this.analysis.reset(); this.alteredAnalysis.reset(); this.partner = this.pendingPartner = null }
  isStarted() { return this.started }
  micLevel(): number {
    this.levelAnalyser.getFloatTimeDomainData(this.levelBuffer)
    let sum = 0
    for (let i = 0; i < this.levelBuffer.length; i++) sum += this.levelBuffer[i] ** 2
    return Math.sqrt(sum / this.levelBuffer.length)
  }
  report(): VoiceReport | null {
    const empty: VoiceFeatures = { speechActive: false, speechProbability: 0, rmsDbfs: -160,
      peakDbfs: -160, relativeIntensityDb: null, f0Hz: null, f0Semitones: null, relativePitchZ: null,
      pitchClarity: 0, rollingPitchRangeSt: null, rollingIntensityRangeDb: null, voicedFraction: 0,
      noiseFloorDbfs: -90, clippingRate: 0 }
    const settings = this.micStream.getAudioTracks()[0]?.getSettings() ?? {}
    const actual: VoiceApplied = { ...this.applied,
      limiterReductionDb: this.limiterReductionDb,
      pitchSemitones: this.shift.semitones,
      gainDb: 20 * Math.log10(Math.max(1e-8, this.gain.gain.value)),
      active: (this.wet.gain.value > .99 || Math.abs(this.gain.gain.value-1)>.001) && this.health.state === 'ready',
    }
    return { version: VOICE_VERSION, sequence: this.sequence++, capturedAt: Date.now() + this.epochOffset,
      clockUncertaintyMs: this.clockUncertainty, clean: this.clean ?? empty, altered: this.altered ?? empty,
      calibration: { ...this.analysis.calibration }, condition: { ...this.condition }, applied: actual,
      health: { ...this.health }, turns: this.analysis.takeTurns(),
      settings: { sampleRate: settings.sampleRate, channelCount: settings.channelCount, echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl } }
  }
  close() {
    this.closed = true
    if (this.watchdog) clearInterval(this.watchdog)
    this.worker?.terminate()
    this.source.disconnect(); this.levelAnalyser.disconnect(); this.tap?.disconnect(); this.shifter?.disconnect(); this.dryDelay.disconnect()
    this.limiter?.disconnect(); this.dry.disconnect(); this.wet.disconnect(); this.gain.disconnect()
    void this.context.close()
  }
}
