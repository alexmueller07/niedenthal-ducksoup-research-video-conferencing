// Real-time voice pitch/formant shifter for a live microphone stream.
//
// Uses the delay-line modulation technique (Chris Wilson's "Jungle" pitch
// shifter): two crossfaded delay lines whose delay time is swept linearly, which
// shifts pitch without changing tempo and works on a live stream. This is a
// genuine, audible effect that gets recorded into the altered track — the audio
// counterpart to the facial morph. On lab hardware the same control can drive a
// DuckSoup audio FX instead.

const DELAY_TIME = 0.1
const FADE_TIME = 0.05
const BUFFER_TIME = 0.1

function createFadeBuffer(ctx: AudioContext, activeTime: number, fadeTime: number): AudioBuffer {
  const length1 = activeTime * ctx.sampleRate
  const length2 = (activeTime - 2 * fadeTime) * ctx.sampleRate
  const length = length1 + length2
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const p = buffer.getChannelData(0)
  const fadeLength = fadeTime * ctx.sampleRate
  const fadeIndex1 = fadeLength
  const fadeIndex2 = length1 - fadeLength
  for (let i = 0; i < length1; ++i) {
    let value: number
    if (i < fadeIndex1) value = Math.sqrt(i / fadeLength)
    else if (i >= fadeIndex2) value = Math.sqrt(1 - (i - fadeIndex2) / fadeLength)
    else value = 1
    p[i] = value
  }
  for (let i = length1; i < length; ++i) p[i] = 0
  return buffer
}

function createDelayTimeBuffer(
  ctx: AudioContext,
  activeTime: number,
  fadeTime: number,
  shiftUp: boolean,
): AudioBuffer {
  const length1 = activeTime * ctx.sampleRate
  const length2 = (activeTime - 2 * fadeTime) * ctx.sampleRate
  const length = length1 + length2
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const p = buffer.getChannelData(0)
  for (let i = 0; i < length1; ++i) {
    p[i] = shiftUp ? (length1 - i) / length : i / length1
  }
  for (let i = length1; i < length; ++i) p[i] = 0
  return buffer
}

/**
 * Wraps a microphone MediaStream and exposes a pitch-shifted output stream.
 * `setSemitones(n)` shifts by n semitones (0 = bypass/neutral).
 */
export class VoiceProcessor {
  readonly context: AudioContext
  readonly outputStream: MediaStream
  private mod1Gain: GainNode
  private mod2Gain: GainNode
  private mod3Gain: GainNode
  private mod4Gain: GainNode
  private modGain1: GainNode
  private modGain2: GainNode
  private started = false
  private sources: AudioBufferSourceNode[] = []

  constructor(micStream: MediaStream) {
    const ctx = new AudioContext()
    this.context = ctx
    const input = ctx.createGain()
    const output = ctx.createGain()

    const source = ctx.createMediaStreamSource(micStream)
    source.connect(input)

    const shiftDown = createDelayTimeBuffer(ctx, BUFFER_TIME, FADE_TIME, false)
    const shiftUp = createDelayTimeBuffer(ctx, BUFFER_TIME, FADE_TIME, true)
    const fadeBuffer = createFadeBuffer(ctx, BUFFER_TIME, FADE_TIME)

    const mod1 = ctx.createBufferSource()
    const mod2 = ctx.createBufferSource()
    const mod3 = ctx.createBufferSource()
    const mod4 = ctx.createBufferSource()
    mod1.buffer = shiftDown
    mod2.buffer = shiftDown
    mod3.buffer = shiftUp
    mod4.buffer = shiftUp
    ;[mod1, mod2, mod3, mod4].forEach((m) => (m.loop = true))

    this.mod1Gain = ctx.createGain()
    this.mod2Gain = ctx.createGain()
    this.mod3Gain = ctx.createGain()
    this.mod4Gain = ctx.createGain()
    this.mod3Gain.gain.value = 0
    this.mod4Gain.gain.value = 0

    mod1.connect(this.mod1Gain)
    mod2.connect(this.mod2Gain)
    mod3.connect(this.mod3Gain)
    mod4.connect(this.mod4Gain)

    this.modGain1 = ctx.createGain()
    this.modGain2 = ctx.createGain()
    const delay1 = ctx.createDelay()
    const delay2 = ctx.createDelay()
    this.mod1Gain.connect(this.modGain1)
    this.mod2Gain.connect(this.modGain2)
    this.mod3Gain.connect(this.modGain1)
    this.mod4Gain.connect(this.modGain2)
    this.modGain1.connect(delay1.delayTime)
    this.modGain2.connect(delay2.delayTime)

    const fade1 = ctx.createBufferSource()
    const fade2 = ctx.createBufferSource()
    fade1.buffer = fadeBuffer
    fade2.buffer = fadeBuffer
    fade1.loop = true
    fade2.loop = true
    const mix1 = ctx.createGain()
    const mix2 = ctx.createGain()
    mix1.gain.value = 0
    mix2.gain.value = 0
    fade1.connect(mix1.gain)
    fade2.connect(mix2.gain)

    input.connect(delay1)
    input.connect(delay2)
    delay1.connect(mix1)
    delay2.connect(mix2)
    mix1.connect(output)
    mix2.connect(output)

    const dest = ctx.createMediaStreamDestination()
    output.connect(dest)
    this.outputStream = dest.stream

    const t = ctx.currentTime + 0.05
    const t2 = t + BUFFER_TIME - FADE_TIME
    mod1.start(t)
    mod2.start(t2)
    mod3.start(t)
    mod4.start(t2)
    fade1.start(t)
    fade2.start(t2)
    this.sources = [mod1, mod2, mod3, mod4, fade1, fade2]

    this.setSemitones(0)
  }

  private setDelay(delayTime: number) {
    const now = this.context.currentTime
    this.modGain1.gain.setTargetAtTime(0.5 * delayTime, now, 0.01)
    this.modGain2.gain.setTargetAtTime(0.5 * delayTime, now, 0.01)
  }

  /** Shift by `semitones` (±12 ≈ ±1 octave). 0 = neutral. */
  setSemitones(semitones: number) {
    const mult = Math.max(-1, Math.min(1, semitones / 12)) // octaves
    if (mult > 0) {
      this.mod1Gain.gain.value = 0
      this.mod2Gain.gain.value = 0
      this.mod3Gain.gain.value = 1
      this.mod4Gain.gain.value = 1
    } else {
      this.mod1Gain.gain.value = 1
      this.mod2Gain.gain.value = 1
      this.mod3Gain.gain.value = 0
      this.mod4Gain.gain.value = 0
    }
    this.setDelay(DELAY_TIME * Math.abs(mult))
  }

  async resume() {
    if (this.context.state === 'suspended') await this.context.resume()
    this.started = true
  }

  isStarted() {
    return this.started
  }

  close() {
    this.sources.forEach((s) => {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    })
    void this.context.close()
  }
}
