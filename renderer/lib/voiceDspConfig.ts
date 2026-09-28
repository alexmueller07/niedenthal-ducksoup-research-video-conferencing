// Shared by the live graph and rendered-audio regression harness.
// Lower windows failed low-pitch shift accuracy; latency remains a release gate.
export const VOICE_STRETCH = { sequenceMs: 24, seekWindowMs: 8, overlapMs: 4, quickSeek: false }
