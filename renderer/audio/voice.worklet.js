// Audio rendering stays independent of React, video inference, and VAD inference.
class VoiceTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.clean = new Float32Array(2048)
    this.altered = new Float32Array(2048)
    this.index = 0
  }
  process(inputs, outputs) {
    const clean = inputs[0]?.[0], altered = inputs[1]?.[0]
    if (!clean) return true
    for (let i = 0; i < clean.length; i++) {
      this.clean[this.index] = clean[i]
      this.altered[this.index++] = altered?.[i] ?? 0
      if (this.index === 2048) {
        this.port.postMessage({ type: 'frame', clean: this.clean, altered: this.altered,
          audioTime: currentTime + i / sampleRate }, [this.clean.buffer, this.altered.buffer])
        this.clean = new Float32Array(2048)
        this.altered = new Float32Array(2048)
        this.index = 0
      }
    }
    for (const channel of outputs[0] ?? []) channel.fill(0)
    return true
  }
}

class VoiceLimiter extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(Math.ceil(sampleRate * .005))
    this.index = 0
    this.envelope = 0
    this.release = Math.exp(-1 / (sampleRate * .12))
    this.ceiling = 10 ** (-3 / 20)
    this.blocks = 0
    this.maxReduction = 0
    this.hold = 0
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0], output = outputs[0]?.[0]
    if (!output) return true
    for (let i = 0; i < output.length; i++) {
      const x = Number.isFinite(input?.[i]) ? input[i] : 0
      const delayed = this.buffer[this.index]
      this.buffer[this.index] = x
      this.index = (this.index + 1) % this.buffer.length
      if (Math.abs(x) >= this.envelope) {
        this.envelope = Math.abs(x)
        this.hold = this.buffer.length
      } else if (this.hold > 0) this.hold--
      else this.envelope *= this.release
      const gain = Math.min(1, this.ceiling / Math.max(this.envelope, 1e-8))
      this.maxReduction = Math.max(this.maxReduction, -20 * Math.log10(gain))
      output[i] = Math.max(-this.ceiling, Math.min(this.ceiling, delayed * gain))
    }
    if (++this.blocks % 32 === 0) {
      this.port.postMessage({ type: 'limiter', reductionDb: this.maxReduction })
      this.maxReduction = 0
    }
    return true
  }
}
registerProcessor('voice-tap', VoiceTap)
registerProcessor('voice-limiter', VoiceLimiter)
