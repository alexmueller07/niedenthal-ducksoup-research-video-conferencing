// The package ships without types. Only the parts the voice pipeline uses.
declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    output?: number
    active?: boolean
    semitones?: number
    tonalityHz?: number
    formantSemitones?: number
    formantCompensation?: boolean
    formantBaseHz?: number
  }
  export interface SignalsmithStretchNode extends AudioWorkletNode {
    schedule(change: StretchSchedule): Promise<unknown>
    start(when?: number): Promise<unknown>
    stop(when?: number): Promise<unknown>
    latency(): Promise<number>
    configure(config: { blockMs?: number; intervalMs?: number; splitComputation?: boolean }): Promise<unknown>
  }
  export default function SignalsmithStretch(context: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<SignalsmithStretchNode>
}
