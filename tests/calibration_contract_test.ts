import assert from 'node:assert/strict'
import {
  CALIBRATION_MAX_AUTO_RETRIES,
  CALIBRATION_READY_TIMEOUT_MS,
  CALIBRATION_RETRY_PAUSE_MS,
  buildExpressionCalibrationProfile,
  calibrationStepReadiness,
  calibrationRetryInstruction,
  normalizeExpressionFeatures,
  summarizeCalibrationStep,
  type CalibrationSample,
} from '../renderer/lib/calibration'
import type { CalibrationStepResult, ExpressionState } from '../main/protocol'

function expression(overrides: Partial<ExpressionState> = {}): ExpressionState {
  return {
    label: 'neutral',
    smileType: null,
    smile: 0.12,
    frown: 0.01,
    asymmetry: 0.03,
    eyeConstriction: 0.04,
    lipPress: 0.02,
    openness: 0.03,
    faceShape: {
      mouthWidthToFaceWidth: 0.38,
      mouthWidthToEyeSpan: 0.7,
      mouthOpenRatio: 0.03,
      mouthCornerTilt: 0.02,
      yawSymmetry: 0.85,
    },
    classifierMode: 'heuristic-subtype',
    classifierVersion: 'test',
    ...overrides,
  }
}

function samples(state: ExpressionState, count = 18): CalibrationSample[] {
  return Array.from({ length: count }, () => ({
    expression: state,
    telemetry: {
      alpha: 1,
      voiceSemitones: 0,
      faceFound: true,
      fps: 30,
      cameraOn: true,
      expression: state,
    },
  }))
}

const neutral = summarizeCalibrationStep('req_1', 'neutral', samples(expression()))
assert.equal(neutral.status, 'complete')
assert.deepEqual(neutral.qualityFlags, [])
assert.deepEqual(calibrationStepReadiness('neutral', samples(expression(), 1)[0]), {
  ready: true,
  status: 'ready',
})
assert.deepEqual(
  calibrationStepReadiness(
    'neutral',
    samples(expression({ label: 'smiling', smile: 0.8 }), 1)[0],
  ),
  { ready: false, status: 'waiting-for-relaxed-face' },
)

const teethSmile = summarizeCalibrationStep(
  'req_2',
  'smile',
  samples(expression({ label: 'smiling', smile: 0.72, openness: 0.31 })),
)
assert.equal(teethSmile.status, 'needs-retake')
assert.ok(teethSmile.qualityFlags.includes('teeth_detected'))
assert.match(calibrationRetryInstruction('smile', teethSmile.qualityFlags), /lips closed/)
assert.deepEqual(calibrationStepReadiness('smile', samples(expression({ smile: 0.72 }), 1)[0]), {
  ready: true,
  status: 'ready',
})

const closedSmile = summarizeCalibrationStep(
  'req_3',
  'smile',
  samples(expression({ label: 'smiling', smile: 0.68, openness: 0.09 })),
)
assert.equal(closedSmile.status, 'complete')
assert.deepEqual(closedSmile.qualityFlags, [])

const weakFrown = summarizeCalibrationStep('req_4', 'frown', samples(expression({ frown: 0.005 })))
assert.equal(weakFrown.status, 'needs-retake')
assert.ok(weakFrown.qualityFlags.includes('weak_frown'))
assert.match(calibrationRetryInstruction('frown', weakFrown.qualityFlags), /small frown/)
assert.deepEqual(calibrationStepReadiness('frown', samples(expression({ frown: 0.12 }), 1)[0]), {
  ready: true,
  status: 'ready',
})

const noFace = summarizeCalibrationStep(
  'req_5',
  'neutral',
  Array.from({ length: 18 }, () => ({ expression: null, telemetry: null })),
)
assert.equal(noFace.status, 'needs-retake')
assert.ok(noFace.qualityFlags.includes('face_not_visible'))
assert.match(calibrationRetryInstruction('neutral', noFace.qualityFlags), /stay centered/)

const angled = summarizeCalibrationStep(
  'req_6',
  'neutral',
  samples(expression({ faceShape: { ...expression().faceShape!, yawSymmetry: 0.4 } })),
)
assert.equal(angled.status, 'needs-retake')
assert.ok(angled.qualityFlags.includes('off_axis_face'))
assert.match(calibrationRetryInstruction('neutral', angled.qualityFlags), /face the screen/)

const weakSmile = summarizeCalibrationStep(
  'req_7',
  'smile',
  samples(expression({ label: 'neutral', smile: 0.2, openness: 0.05 })),
)
assert.equal(weakSmile.status, 'needs-retake')
assert.ok(weakSmile.qualityFlags.includes('weak_smile'))
assert.match(calibrationRetryInstruction('smile', weakSmile.qualityFlags), /smile a little clearer/)

assert.equal(CALIBRATION_MAX_AUTO_RETRIES, 2)
assert.ok(CALIBRATION_RETRY_PAUSE_MS >= 1000)
assert.ok(CALIBRATION_READY_TIMEOUT_MS >= 8000)

function completed(
  step: CalibrationStepResult['step'],
  metrics: Partial<CalibrationStepResult['metrics']>,
): CalibrationStepResult {
  return {
    requestId: `req_${step}`,
    step,
    status: 'complete',
    samples: 18,
    capturedAt: '2026-09-06T00:00:00.000Z',
    metrics: {
      smileMean: 0,
      smileMax: 0,
      frownMean: 0,
      frownMax: 0,
      opennessMean: 0,
      opennessMax: 0,
      faceVisibleRatio: 1,
      mouthWidthToFaceWidthMean: 0.38,
      mouthWidthToEyeSpanMean: 0.7,
      mouthOpenRatioMean: 0.03,
      mouthOpenRatioMax: 0.04,
      mouthCornerTiltMean: 0.02,
      yawSymmetryMean: 0.85,
      ...metrics,
    },
    qualityFlags: [],
  }
}

const profile = buildExpressionCalibrationProfile({
  neutral: completed('neutral', { smileMean: 0.48, smileMax: 0.5 }),
  smile: completed('smile', { smileMean: 0.62, smileMax: 0.66, mouthOpenRatioMax: 0.05 }),
  frown: completed('frown', { frownMean: 0.12, frownMax: 0.16 }),
})
assert.ok(profile)

const neutralish = normalizeExpressionFeatures(
  { smile: 0.5, frown: 0, openness: 0, faceShape: expression().faceShape },
  profile,
)
assert.ok(neutralish.normalizedSmile < profile.thresholds.smileOn)
assert.ok(neutralish.smileMargin < 0)

const personRelativeSmile = normalizeExpressionFeatures(
  { smile: 0.59, frown: 0, openness: 0.01, faceShape: expression().faceShape },
  profile,
)
assert.ok(personRelativeSmile.normalizedSmile >= profile.thresholds.smileOn)
assert.ok(personRelativeSmile.smileMargin > 0)

const openMouth = normalizeExpressionFeatures(
  {
    smile: 0.63,
    frown: 0,
    openness: 0.38,
    faceShape: { ...expression().faceShape!, mouthOpenRatio: 0.2 },
  },
  profile,
)
assert.ok(openMouth.normalizedOpenness > 0.9)

console.log('calibration contract checks passed')
