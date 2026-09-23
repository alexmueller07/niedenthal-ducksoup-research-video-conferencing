// Contract checks for calibration-driven morphing: alpha 1.0 must move THIS
// person's mouth exactly as far as their own biggest expression, and their real
// expression plus the morph must never exceed that maximum.
//
// Run: npx tsx tests/morph_contract_test.ts

import assert from 'node:assert/strict'
import {
  FALLBACK_FROWN,
  FALLBACK_SMILE,
  MORPH_TRAVEL_MAX,
  MORPH_TRAVEL_MIN,
  OPEN_MOUTH_FADE,
  TalkingDetector,
  cappedAlpha,
  geometricLevel,
  morphDirectionFor,
  normalizedLevel,
  openMouthScale,
  type GeometryFrame,
} from '../renderer/lib/calibration'
import type { CalibrationProfile } from '../main/protocol'

// ---- A profile with round numbers, so the arithmetic is checkable by hand ----

const NEUTRAL: GeometryFrame = {
  cornerSpreadX: 0.4,
  cornerLiftY: 0.3,
  lowerLipDropY: 0.06,
  mouthOpenRatio: 0.04,
  mouthWidthToFaceWidth: 0.4, // → 2.5 mouth-widths per face-width
  mouthCornerTilt: 0.02,
  yawSymmetry: 0.9,
}

function stat(mean: number) {
  return { mean, std: 0.01 }
}

const profile = {
  schemaVersion: 1,
  version: 'test',
  participantId: '1043',
  dyadId: 'D22',
  studyId: 'NL-07',
  seat: 'P1',
  appVersion: 'test',
  capturedAt: '',
  acceptedAt: '',
  camera: { width: 1280, height: 720 },
  phases: {
    neutral: {
      phase: 'neutral',
      status: 'ok',
      capturedAt: '',
      durationMs: 3000,
      frames: 90,
      faceVisibleRatio: 1,
      blendshapes: {},
      scores: {
        smile: stat(0.2),
        frown: stat(0.01),
        openness: stat(0.05),
        lipPress: stat(0.1),
        asymmetry: stat(0.05),
      },
      geometry: {
        cornerSpreadX: stat(NEUTRAL.cornerSpreadX),
        cornerLiftY: stat(NEUTRAL.cornerLiftY),
        lowerLipDropY: stat(NEUTRAL.lowerLipDropY),
        mouthOpenRatio: stat(NEUTRAL.mouthOpenRatio),
        mouthWidthToFaceWidth: stat(NEUTRAL.mouthWidthToFaceWidth),
        mouthCornerTilt: stat(NEUTRAL.mouthCornerTilt),
        yawSymmetry: stat(NEUTRAL.yawSymmetry),
      },
      qualityFlags: [],
    },
  },
  derived: {
    // Straight out along the mouth line, so the projection maths is easy to read.
    smile: { range: 0.65, deadZone: 0.1, cornerTravel: 0.1, cornerAngleRad: 0 },
    frown: {
      range: 0.29,
      deadZone: 0.12,
      cornerTravel: 0.08,
      cornerAngleRad: -Math.PI / 2,
      poutDrop: 0.04,
    },
    openness: { neutral: 0.05, max: 0.5 },
    jawCoupling: 0,
    openScaleRange: { neutralOpen: 0.04, openSmileOpen: 0.24 },
    talking: { openRatioStdNeutral: 0.006 },
  },
  validation: { phases: {}, flags: [] },
} as unknown as CalibrationProfile

function live(overrides: Partial<GeometryFrame> = {}): GeometryFrame {
  return { ...NEUTRAL, ...overrides }
}

// ---- Per-person gain ----

const smileDir = morphDirectionFor(profile, 0.5)
assert.equal(smileDir.cornerTravel, 0.1, 'smile gain is this person’s measured travel')
assert.equal(smileDir.cornerAngleRad, 0, 'and their measured direction')

const frownDir = morphDirectionFor(profile, -0.5)
assert.equal(frownDir.cornerTravel, 0.08, 'frown gain is measured separately')
assert.equal(frownDir.poutDrop, 0.04, 'the frown also drops the lower lip')

// Without a profile the geometry is exactly what it was before calibration
// existed, so alpha 1.0 uncalibrated behaves as alpha 1.0 always did.
assert.equal(morphDirectionFor(null, 0.5).cornerTravel, FALLBACK_SMILE.cornerTravel)
assert.equal(morphDirectionFor(null, 0.5).cornerAngleRad, FALLBACK_SMILE.cornerAngleRad)
assert.equal(morphDirectionFor(null, -0.5).cornerTravel, FALLBACK_FROWN.cornerTravel)
assert.ok(
  Math.abs(FALLBACK_SMILE.cornerTravel - 0.17) < 1e-9,
  'the fallback smile gain is the old fixed SMILE_GAIN',
)
// The old frown was (0.25 inward, 1.0 down) × 0.13, rewritten as a vector.
assert.ok(
  Math.abs(FALLBACK_FROWN.cornerTravel * Math.cos(FALLBACK_FROWN.cornerAngleRad) + 0.25 * 0.13) < 1e-6,
  'the fallback frown keeps its old inward component',
)
assert.ok(
  Math.abs(-FALLBACK_FROWN.cornerTravel * Math.sin(FALLBACK_FROWN.cornerAngleRad) - 0.13) < 1e-6,
  'and its old downward component',
)

// Different participants get different alpha-to-pixels mappings. That is the point.
const wideProfile = JSON.parse(JSON.stringify(profile)) as CalibrationProfile
wideProfile.derived.smile.cornerTravel = 0.26
assert.notEqual(
  morphDirectionFor(profile, 1).cornerTravel,
  morphDirectionFor(wideProfile, 1).cornerTravel,
  'the same alpha must not move two different faces by the same amount',
)

// ---- The live level, measured geometrically ----

assert.equal(geometricLevel(profile, live(), 'smile'), 0, 'a resting face is at zero')

// Corners spread by 0.08 face-widths → each corner moves 0.04 → ×2.5 = 0.1
// mouth-widths, which is exactly this person's calibrated maximum.
assert.ok(
  Math.abs(geometricLevel(profile, live({ cornerSpreadX: 0.48 }), 'smile') - 1) < 1e-6,
  'their own maximum reads as 1.0',
)
assert.ok(
  Math.abs(geometricLevel(profile, live({ cornerSpreadX: 0.44 }), 'smile') - 0.5) < 1e-6,
  'halfway reads as 0.5',
)
assert.equal(
  geometricLevel(profile, live({ cornerSpreadX: 0.56 }), 'smile'),
  1,
  'going past what calibration measured clamps at 1 rather than overflowing',
)
assert.equal(geometricLevel(null, live({ cornerSpreadX: 0.48 }), 'smile'), 0, 'no profile, no level')

// Movement in the wrong direction is not a smile.
assert.equal(
  geometricLevel(profile, live({ cornerLiftY: 0.35 }), 'smile'),
  0,
  'a purely vertical move does not count toward a purely horizontal calibrated smile',
)

// ---- Jaw compensation: talking must not read as an expression ----

const jawProfile = JSON.parse(JSON.stringify(profile)) as CalibrationProfile
jawProfile.derived.jawCoupling = 0.5
// Opening the mouth by 0.2 drags the corners 0.5 × 0.2 = 0.1 — their whole
// smile range — so with compensation this should read as nothing at all.
const talkingFrame = live({ cornerSpreadX: 0.48, mouthOpenRatio: 0.24 })
assert.ok(
  geometricLevel(profile, talkingFrame, 'smile') > 0.99,
  'without compensation, an open mouth looks like a full smile',
)
assert.ok(
  geometricLevel(jawProfile, talkingFrame, 'smile') < 0.01,
  'with compensation, the same frame reads as no smile',
)

// ---- The total cap ----

assert.equal(cappedAlpha(1, 0), 1, 'a resting face gives the morph the full budget')
assert.ok(Math.abs(cappedAlpha(1, 0.6) - 0.4) < 1e-9, 'a 60% smile leaves 40% of headroom')
assert.equal(cappedAlpha(1, 1), 0, 'at their own maximum the morph adds nothing')
assert.equal(cappedAlpha(0.2, 0.5), 0.2, 'a small command is not inflated to fill the headroom')
assert.equal(cappedAlpha(2, 0), 1, 'alpha is clamped to their maximum, never beyond')
assert.equal(cappedAlpha(-2, 0), -1, 'in both directions')
assert.ok(Math.abs(cappedAlpha(-1, 0.75) + 0.25) < 1e-9, 'the frown direction is capped the same way')

for (let level = 0; level <= 1.0001; level += 0.05) {
  for (let alpha = 0; alpha <= 1.0001; alpha += 0.1) {
    const total = level + Math.abs(cappedAlpha(alpha, level))
    assert.ok(
      total <= 1 + 1e-9,
      `real expression + morph must never exceed their maximum (level ${level}, alpha ${alpha} → ${total})`,
    )
  }
}

// ---- Open-mouth fade ----

assert.equal(openMouthScale(profile, 0.04), 1, 'a closed mouth gets the full morph')
assert.ok(
  Math.abs(openMouthScale(profile, 0.24) - (1 - OPEN_MOUTH_FADE)) < 1e-9,
  'a wide-open mouth fades to the floor, where a planar corner warp looks worst',
)
assert.ok(
  Math.abs(openMouthScale(profile, 0.14) - (1 - OPEN_MOUTH_FADE / 2)) < 1e-9,
  'and fades continuously in between, so it cannot pulse during speech',
)
assert.ok(openMouthScale(profile, 5) >= 1 - OPEN_MOUTH_FADE, 'the fade never goes below its floor')
assert.equal(openMouthScale(null, 0.5), 1, 'without a profile there is nothing to scale against')

// ---- Safety rails ----

assert.ok(MORPH_TRAVEL_MIN > 0, 'a bad calibration cannot produce a dead morph')
assert.ok(MORPH_TRAVEL_MAX < 0.5, 'nor a grotesque one')

// ---- Detection level ----

assert.ok(Math.abs(normalizedLevel(0.525, 0.2, 0.65) - 0.5) < 1e-9, 'halfway through their range')
assert.equal(normalizedLevel(0.1, 0.2, 0.65), 0, 'below neutral is not a negative smile')
assert.equal(normalizedLevel(5, 0.2, 0.65), 1, 'past their maximum clamps')

// ---- Talking detector ----

const detector = new TalkingDetector(0.006)
let t = 0
// A sustained expression: the mouth is open but not moving.
for (let i = 0; i < 30; i++, t += 33) detector.push(t, 0.25, 0.3)
assert.equal(detector.talking, false, 'a held open-mouth smile is not speech')

// Speech: the mouth opening oscillates AND the microphone is live.
for (let i = 0; i < 30; i++, t += 33) detector.push(t, i % 2 === 0 ? 0.05 : 0.3, 0.3)
assert.equal(detector.talking, true, 'a moving mouth with sound is speech')

// Mouthing silently is not speech — that is what the microphone is for.
const silent = new TalkingDetector(0.006)
let st = 0
for (let i = 0; i < 30; i++, st += 33) silent.push(st, i % 2 === 0 ? 0.05 : 0.3, 0)
assert.equal(silent.talking, false, 'a moving mouth without sound is not speech')

// It holds through the gaps between words rather than flickering off.
detector.push(t, 0.05, 0)
assert.equal(detector.talking, true, 'a brief pause does not end speech')
t += 600
detector.push(t, 0.05, 0)
assert.equal(detector.talking, false, 'a real pause does')

console.log('morph contract checks passed')
