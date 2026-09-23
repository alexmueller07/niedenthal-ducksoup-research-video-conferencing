// Contract checks for per-participant calibration: the maths that turns four
// recorded phases into the numbers detection and the morph actually run on.
//
// Run: npx tsx tests/calibration_contract_test.ts

import assert from 'node:assert/strict'
import {
  buildCalibrationProfile,
  deadZoneFor,
  parseCalibrationFile,
  pickPeakFrames,
  statOf,
  summarizePhase,
  validatePhase,
  type CalibrationFrame,
  type GeometryFrame,
  type ScoreFrame,
} from '../renderer/lib/calibration'
import { MAX_CHEEK_RISE } from '../renderer/lib/calibration'
import type { CalibrationPhase, CalibrationPhaseSummary } from '../main/protocol'

// ---- Fixtures ----

const NEUTRAL_GEOMETRY: GeometryFrame = {
  cornerSpreadX: 0.4,
  cornerLiftY: 0.3,
  lowerLipDropY: 0.06,
  mouthOpenRatio: 0.03,
  mouthWidthToFaceWidth: 0.4,
  mouthCornerTilt: 0.02,
  yawSymmetry: 0.9,
  cheekRaiseY: 0.3,
  browRaiseY: 0.12,
  browGapX: 0.1,
}

function frames(
  count: number,
  scores: Partial<ScoreFrame>,
  geometry: Partial<GeometryFrame> = {},
  opts: { jitter?: number; faceFound?: boolean } = {},
): CalibrationFrame[] {
  const jitter = opts.jitter ?? 0
  return Array.from({ length: count }, (_, i) => {
    // Deterministic wobble, so a phase has a spread without the test being flaky.
    const wobble = Math.sin(i) * jitter
    return {
      tsMs: i * 33,
      faceFound: opts.faceFound ?? true,
      blendshapes: { mouthSmileLeft: (scores.smile ?? 0) + wobble, jawOpen: 0.1 },
      scores: {
        smile: (scores.smile ?? 0.2) + wobble,
        frown: (scores.frown ?? 0.01) + wobble,
        openness: scores.openness ?? 0.05,
        lipPress: scores.lipPress ?? 0.1,
        asymmetry: scores.asymmetry ?? 0.05,
      },
      geometry: { ...NEUTRAL_GEOMETRY, ...geometry },
    }
  })
}

/** Frames whose peak sits in the last few, so top-N selection has work to do. */
function risingFrames(count: number, key: 'smile' | 'frown', peak: number, geometry: Partial<GeometryFrame>) {
  return Array.from({ length: count }, (_, i) => {
    const ramp = (i / (count - 1)) ** 2
    const base: CalibrationFrame = {
      tsMs: i * 33,
      faceFound: true,
      blendshapes: { mouthSmileLeft: peak * ramp, jawOpen: 0.1 },
      scores: { smile: 0.2, frown: 0.01, openness: 0.05, lipPress: 0.1, asymmetry: 0.05 },
      geometry: { ...NEUTRAL_GEOMETRY },
    }
    base.scores[key] = peak * ramp
    // Geometry ramps with the expression, so the peak frames carry the peak shape.
    for (const [k, v] of Object.entries(geometry)) {
      const from = NEUTRAL_GEOMETRY[k as keyof GeometryFrame]
      base.geometry[k as keyof GeometryFrame] = from + (v - from) * ramp
    }
    return base
  })
}

function buildPhases(): Partial<Record<CalibrationPhase, CalibrationPhaseSummary>> {
  const neutral = validatePhase(
    summarizePhase('neutral', frames(90, { smile: 0.2, frown: 0.01 }, {}, { jitter: 0.02 })),
  )
  const smileClosed = validatePhase(
    summarizePhase(
      'smileClosed',
      risingFrames(120, 'smile', 0.7, {
        cornerSpreadX: 0.44,
        cornerLiftY: 0.31,
        mouthOpenRatio: 0.04,
        // Cheeks ride up toward the eyes, brows lift a little.
        cheekRaiseY: 0.28,
        browRaiseY: 0.13,
      }),
    ),
    neutral,
  )
  const smileOpen = validatePhase(
    summarizePhase(
      'smileOpen',
      risingFrames(120, 'smile', 0.85, { cornerSpreadX: 0.46, cornerLiftY: 0.315, mouthOpenRatio: 0.25 }),
    ),
    neutral,
  )
  const frown = validatePhase(
    summarizePhase(
      'frown',
      risingFrames(120, 'frown', 0.3, {
        cornerSpreadX: 0.38,
        cornerLiftY: 0.28,
        lowerLipDropY: 0.085,
        // Inner brows come together and drop.
        browRaiseY: 0.105,
        browGapX: 0.08,
      }),
    ),
    neutral,
  )
  return { neutral, smileClosed, smileOpen, frown }
}

const META = {
  participantId: '1043',
  dyadId: 'D22',
  studyId: 'NL-07',
  seat: 'P1' as const,
  appVersion: '3.1.0',
  camera: { width: 1280, height: 720 },
}

// ---- statOf ----

const stat = statOf([1, 2, 3, 4, 5])
assert.equal(stat.mean, 3, 'mean of 1..5')
// Sample standard deviation (n−1), which is what a spread over sampled frames is.
assert.ok(Math.abs(stat.std - 1.5811) < 0.001, `sample std, got ${stat.std}`)
assert.deepEqual(statOf([]), { mean: 0, std: 0 }, 'no frames must not produce NaN')

// ---- Peak selection: the mean of the top N, never a single frame ----

const rising = risingFrames(50, 'smile', 1, { cornerSpreadX: 0.44 })
const peaks = pickPeakFrames(rising, 'smileClosed', 5)
assert.equal(peaks.length, 5, 'top 5 frames selected')
assert.ok(
  peaks.every((f) => f.scores.smile >= rising.at(-6)!.scores.smile),
  'selected frames are the strongest ones',
)
assert.deepEqual(pickPeakFrames(rising, 'neutral'), [], 'neutral has no peak')

const summary = summarizePhase('smileClosed', rising)
assert.ok(summary.peak, 'expression phase gets a peak')
assert.ok(
  summary.peak!.scores.smile.mean < 1 && summary.peak!.scores.smile.mean > 0.9,
  'peak is an average of the top frames, so it sits just below the single best',
)
assert.equal(summary.peak!.peakFrameIndex, rising.length - 1, 'screenshot points at the strongest frame')
assert.equal(summarizePhase('neutral', rising).peak, undefined, 'neutral phase has no peak')

// ---- Validation ----

const phases = buildPhases()
for (const phase of ['neutral', 'smileClosed', 'smileOpen', 'frown'] as const) {
  assert.equal(phases[phase]!.status, 'ok', `${phase} should validate`)
}

// A max that barely clears the resting face cannot scale anything.
const flatNeutral = validatePhase(
  summarizePhase('neutral', frames(90, { smile: 0.2 }, {}, { jitter: 0.05 })),
)
const weakSmile = validatePhase(
  summarizePhase('smileClosed', frames(120, { smile: 0.22 })),
  flatNeutral,
)
assert.equal(weakSmile.status, 'needs-redo', 'a smile inside neutral noise needs a redo')
assert.ok(
  weakSmile.qualityFlags.includes('too_close_to_neutral'),
  'and says why',
)

const openClosedSmile = validatePhase(
  summarizePhase(
    'smileClosed',
    risingFrames(120, 'smile', 0.7, { cornerSpreadX: 0.44, mouthOpenRatio: 0.3 }),
  ),
  phases.neutral,
)
assert.ok(
  openClosedSmile.qualityFlags.includes('mouth_open_during_closed_smile'),
  'an open mouth during the closed-lip smile is caught, because it would inflate the morph gain',
)

const lostFace = validatePhase(
  summarizePhase('neutral', frames(90, { smile: 0.2 }, {}, { faceFound: false })),
)
assert.ok(lostFace.qualityFlags.includes('face_not_visible'), 'a missing face is flagged')

const offAxis = validatePhase(
  summarizePhase('neutral', frames(90, { smile: 0.2 }, { yawSymmetry: 0.3 })),
)
assert.ok(offAxis.qualityFlags.includes('off_axis_face'), 'a turned head is flagged')

// ---- Dead zone ----

assert.ok(Math.abs(deadZoneFor(0.02, 0.65) - 0.0923) < 0.001, 'dead zone is 3 sigma over the range')
assert.equal(deadZoneFor(0.0001, 0.65), 0.08, 'a very steady neutral still gets a floor')
assert.equal(deadZoneFor(0.5, 0.1), 0.6, 'a very noisy neutral is capped, not allowed to swallow the range')

// ---- Profile ----

const profile = buildCalibrationProfile(phases, META, '2026-09-22T10:00:00.000Z')
assert.ok(profile, 'four good phases produce a profile')
assert.equal(profile!.participantId, '1043', 'profile is stamped with who it was measured on')
assert.equal(profile!.seat, 'P1')

// Morph gain comes from the CLOSED smile, not the bigger open one.
const expectedTravel = Math.hypot(((0.44 - 0.4) / 2) * 2.5, (0.31 - 0.3) * 2.5)
assert.ok(
  Math.abs(profile!.derived.smile.cornerTravel - expectedTravel) < 0.005,
  `smile gain should come from the closed-lip smile (${profile!.derived.smile.cornerTravel} vs ${expectedTravel})`,
)
const openTravel = Math.hypot(((0.46 - 0.4) / 2) * 2.5, (0.315 - 0.3) * 2.5)
assert.ok(
  profile!.derived.smile.cornerTravel < openTravel,
  'and must be smaller than the open-mouth travel it would otherwise use',
)

// Detection range comes from the OPEN smile — their true maximum smile signal.
assert.ok(
  profile!.derived.smile.range > 0.6,
  `detection range should use the open smile peak, got ${profile!.derived.smile.range}`,
)

assert.ok(
  profile!.derived.smile.cornerAngleRad > 0.17 && profile!.derived.smile.cornerAngleRad < 0.79,
  'smile angle is clamped into a plausible band',
)
assert.ok(profile!.derived.frown.cornerAngleRad < 0, 'a frown points downward')
assert.ok(profile!.derived.frown.poutDrop > 0, 'a frown drops the centre of the lower lip')
assert.ok(profile!.derived.jawCoupling > 0, 'opening the mouth is measured as moving the corners')

// ---- The rest of the face ----

assert.ok(
  (profile!.derived.smile.cheekRise ?? 0) > 0,
  `a smile that raises the cheeks should measure a cheek rise, got ${profile!.derived.smile.cheekRise}`,
)
assert.ok(
  (profile!.derived.smile.browRise ?? 0) > 0,
  'and a brow rise, since this face raises its brows when smiling',
)
assert.ok(
  (profile!.derived.frown.browFurrow ?? 0) > 0,
  'a frown should measure the inner brows pulling together',
)
assert.ok(
  (profile!.derived.frown.browRise ?? 0) < 0,
  'and the brows dropping',
)
assert.ok(
  (profile!.derived.smile.cheekRise ?? 0) <= MAX_CHEEK_RISE,
  'cheek travel stays inside its cap',
)

// A face whose cheeks and brows genuinely do not move must come out at zero
// rather than as jitter, so it simply gets the mouth-only morph.
const stillPhases = {
  neutral: phases.neutral,
  smileClosed: validatePhase(
    summarizePhase(
      'smileClosed',
      risingFrames(120, 'smile', 0.7, { cornerSpreadX: 0.44, cornerLiftY: 0.31 }),
    ),
    phases.neutral,
  ),
  smileOpen: phases.smileOpen,
  frown: phases.frown,
}
const stillProfile = buildCalibrationProfile(stillPhases, META)
assert.equal(
  stillProfile!.derived.smile.cheekRise,
  0,
  'a face whose cheeks do not move gets no cheek movement, not noise',
)

// An incomplete calibration is worse than none: the morph would be scaled
// against a range nobody measured.
assert.equal(
  buildCalibrationProfile({ neutral: phases.neutral }, META),
  null,
  'a partial calibration must not produce a profile',
)

// ---- Reload ----

const roundTripped = parseCalibrationFile(JSON.parse(JSON.stringify(profile)))
assert.ok(roundTripped, 'a written profile reloads')

// Calibrations recorded before the cheeks and brows were measured must still
// load, so nobody's existing session data becomes unreadable.
const v1 = JSON.parse(JSON.stringify(profile))
v1.schemaVersion = 1
delete v1.derived.smile.cheekRise
delete v1.derived.smile.browRise
const reloadedV1 = parseCalibrationFile(v1)
assert.ok(reloadedV1, 'an older calibration file still loads')
assert.equal(reloadedV1!.derived.smile.cheekRise, undefined, 'it just carries no cheek data')
assert.equal(roundTripped!.derived.smile.cornerTravel, profile!.derived.smile.cornerTravel)
assert.equal(parseCalibrationFile({ schemaVersion: 99 }), null, 'an unknown schema is refused')
assert.equal(parseCalibrationFile(null), null, 'garbage is refused')

console.log('calibration contract checks passed')
