import assert from 'node:assert/strict'
import { summarizeCalibrationStep, type CalibrationSample } from '../renderer/lib/calibration'
import type { ExpressionState } from '../main/protocol'

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

const teethSmile = summarizeCalibrationStep(
  'req_2',
  'smile',
  samples(expression({ label: 'smiling', smile: 0.72, openness: 0.31 })),
)
assert.equal(teethSmile.status, 'needs-retake')
assert.ok(teethSmile.qualityFlags.includes('teeth_detected'))

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

const noFace = summarizeCalibrationStep(
  'req_5',
  'neutral',
  Array.from({ length: 18 }, () => ({ expression: null, telemetry: null })),
)
assert.equal(noFace.status, 'needs-retake')
assert.ok(noFace.qualityFlags.includes('face_not_visible'))

console.log('calibration contract checks passed')
