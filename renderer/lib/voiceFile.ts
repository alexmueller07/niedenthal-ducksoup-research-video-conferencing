// Plays an uploaded voice recording through the same VoiceProcessor the
// call uses, so the 1-person test station can try voice changes without
// anyone having to keep talking. The recording loops until stopped.

import { VoiceProcessor } from './voice'

export class VoiceFilePlayer {
  readonly processor: VoiceProcessor
  private ctx = new AudioContext()
  private feed = this.ctx.createMediaStreamDestination()
  // Lets the tester hear the untouched recording instead of the changed one.
  private original = this.ctx.createGain()
  private changed = new Audio()
  private buffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null

  constructor() {
    this.original.gain.value = 0
    this.original.connect(this.ctx.destination)
    this.processor = new VoiceProcessor(this.feed.stream)
    this.changed.srcObject = this.processor.outputStream
  }

  async load(file: File) {
    this.stop()
    this.buffer = await this.ctx.decodeAudioData(await file.arrayBuffer())
  }

  async play() {
    if (!this.buffer) return
    this.stop()
    await this.ctx.resume()
    if (!this.processor.isStarted()) await this.processor.resume()
    const source = this.ctx.createBufferSource()
    source.buffer = this.buffer
    source.loop = true
    source.connect(this.feed)
    source.connect(this.original)
    source.start()
    this.source = source
    await this.changed.play()
  }

  stop() {
    this.source?.stop()
    this.source?.disconnect()
    this.source = null
    this.changed.pause()
  }

  listenTo(which: 'original' | 'changed') {
    this.original.gain.value = which === 'original' ? 1 : 0
    this.changed.muted = which !== 'changed'
  }

  close() {
    this.stop()
    this.processor.close()
    void this.ctx.close()
  }
}
