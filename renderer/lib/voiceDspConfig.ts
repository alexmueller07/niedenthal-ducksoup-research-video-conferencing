// Shared by the live graph and rendered-audio regression harness.
// The shifter's delay equals blockMs (60 ms budget). Shorter blocks failed
// pitch accuracy on low (~90 Hz) voices.
export const VOICE_STRETCH = { blockMs: 60, intervalMs: 15 }
// Formant raise at voiceSmile = 1. A smile shortens the vocal tract, lifting the
// resonances while pitch stays put.
export const VOICE_SMILE_SEMITONES = 1.5
