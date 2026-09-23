// Writes tests/fixtures/calibration_frames.json — the frame timeline the
// camera-free replay test runs against.
//
// Run: npx tsx tests/make_calibration_fixture.ts
//
// The committed fixture is SYNTHETIC: a deterministic timeline shaped like a
// real calibration run (relax, big closed smile, big open smile, big frown,
// then a stretch of talking), so the test can run in CI with no camera and no
// MediaPipe. Its `source` field says so.
//
// To replace it with real data, dump `FaceMorphProcessor.sample(tsMs)` once per
// frame during a real run and write the same shape. Nothing in the replay test
// needs to change — it only reads the file.

import fs from 'node:fs'
import path from 'node:path'
import type { CalibrationFrame } from '../renderer/lib/calibration'

const FPS = 30
const STEP_MS = 1000 / FPS

const NEUTRAL = {
  cornerSpreadX: 0.4,
  cornerLiftY: 0.3,
  lowerLipDropY: 0.06,
  mouthOpenRatio: 0.03,
  mouthWidthToFaceWidth: 0.4,
  mouthCornerTilt: 0.02,
  yawSymmetry: 0.9,
}

/** Deterministic pseudo-noise, so the fixture is byte-stable across runs. */
function noise(i: number, scale: number): number {
  return Math.sin(i * 12.9898) * scale
}

interface Segment {
  label: string
  durationMs: number
  /** 0 at the start of the segment, 1 at its peak. */
  shape: (t: number, i: number) => {
    smile: number
    frown: number
    openness: number
    open: number
    spread: number
    lift: number
    lipDrop: number
    mic: number
  }
}

const SEGMENTS: Segment[] = [
  {
    label: 'neutral',
    durationMs: 3000,
    shape: (_t, i) => ({
      smile: 0.2 + noise(i, 0.015),
      frown: 0.01 + Math.abs(noise(i, 0.004)),
      openness: 0.05,
      open: 0.03 + noise(i, 0.004),
      spread: 0.4,
      lift: 0.3,
      lipDrop: 0.06,
      mic: 0.002,
    }),
  },
  {
    label: 'smileClosed',
    // Ramp up, hold near the top, ease off — how a held expression actually looks.
    durationMs: 4000,
    shape: (t, i) => {
      const r = hold(t)
      return {
        smile: 0.2 + 0.5 * r + noise(i, 0.012),
        frown: 0.01,
        openness: 0.05 + 0.04 * r,
        open: 0.03 + 0.012 * r,
        spread: 0.4 + 0.04 * r,
        lift: 0.3 + 0.01 * r,
        lipDrop: 0.06,
        mic: 0.002,
      }
    },
  },
  {
    label: 'smileOpen',
    durationMs: 4000,
    shape: (t, i) => {
      const r = hold(t)
      return {
        smile: 0.2 + 0.65 * r + noise(i, 0.012),
        frown: 0.01,
        openness: 0.05 + 0.45 * r,
        open: 0.03 + 0.22 * r,
        spread: 0.4 + 0.06 * r,
        lift: 0.3 + 0.015 * r,
        lipDrop: 0.06,
        mic: 0.003,
      }
    },
  },
  {
    label: 'frown',
    durationMs: 4000,
    shape: (t, i) => {
      const r = hold(t)
      return {
        smile: 0.2 - 0.12 * r,
        frown: 0.01 + 0.29 * r + Math.abs(noise(i, 0.006)),
        openness: 0.05,
        open: 0.03,
        spread: 0.4 - 0.02 * r,
        lift: 0.3 - 0.02 * r,
        lipDrop: 0.06 + 0.025 * r,
        mic: 0.002,
      }
    },
  },
  {
    label: 'talking',
    // Speech: the jaw oscillates and the microphone is live. The mouth corners
    // ride along with the jaw, which is exactly the false-smile case.
    durationMs: 4000,
    shape: (_t, i) => {
      const syllable = (Math.sin(i * 0.9) + 1) / 2
      return {
        smile: 0.2 + 0.05 * syllable,
        frown: 0.01 + 0.05 * syllable,
        openness: 0.05 + 0.3 * syllable,
        open: 0.03 + 0.2 * syllable,
        spread: 0.4 + 0.05 * syllable,
        lift: 0.3,
        lipDrop: 0.06,
        mic: 0.05 + 0.1 * syllable,
      }
    },
  },
]

/** Ramp in over the first 30%, hold, ease out over the last 15%. */
function hold(t: number): number {
  if (t < 0.3) return (t / 0.3) ** 1.5
  if (t > 0.85) return 1 - ((t - 0.85) / 0.15) * 0.25
  return 1
}

interface FixtureFrame extends CalibrationFrame {
  segment: string
  micRms: number
}

const frames: FixtureFrame[] = []
let tsMs = 0
let index = 0

for (const segment of SEGMENTS) {
  const count = Math.round(segment.durationMs / STEP_MS)
  for (let i = 0; i < count; i++, index++) {
    const v = segment.shape(i / (count - 1), index)
    frames.push({
      segment: segment.label,
      tsMs: Math.round(tsMs),
      faceFound: true,
      micRms: round(v.mic),
      blendshapes: {
        mouthSmileLeft: round(v.smile),
        mouthSmileRight: round(v.smile * 0.97),
        mouthFrownLeft: round(v.frown),
        mouthFrownRight: round(v.frown * 0.95),
        mouthPressLeft: 0.1,
        mouthPressRight: 0.1,
        mouthUpperUpLeft: round(v.openness * 0.5),
        mouthUpperUpRight: round(v.openness * 0.5),
        jawOpen: round(v.open * 2),
        mouthLowerDownLeft: round(v.openness * 0.3),
        mouthLowerDownRight: round(v.openness * 0.3),
        eyeSquintLeft: 0.15,
        eyeSquintRight: 0.15,
        cheekSquintLeft: 0.02,
        cheekSquintRight: 0.02,
        mouthPucker: 0.05,
        mouthFunnel: 0.04,
        mouthShrugLower: 0.03,
      },
      scores: {
        smile: round(v.smile),
        frown: round(v.frown),
        openness: round(v.openness),
        lipPress: 0.1,
        asymmetry: 0.05,
      },
      geometry: {
        ...NEUTRAL,
        cornerSpreadX: round(v.spread),
        cornerLiftY: round(v.lift),
        lowerLipDropY: round(v.lipDrop),
        mouthOpenRatio: round(v.open),
      },
    })
    tsMs += STEP_MS
  }
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000
}

const out = {
  source: 'synthetic',
  note: 'Generated by tests/make_calibration_fixture.ts. Replace with a real FaceMorphProcessor.sample() dump when one is available; the replay test only reads this file.',
  fps: FPS,
  segments: SEGMENTS.map((s) => ({ label: s.label, durationMs: s.durationMs })),
  frames,
}

const target = path.join(import.meta.dirname, 'fixtures', 'calibration_frames.json')
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf-8')
console.log(`wrote ${frames.length} frames to ${target}`)
