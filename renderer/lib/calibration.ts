import type {
  CalibrationQualityFlag,
  CalibrationStep,
  CalibrationStepResult,
  ExpressionState,
  Telemetry,
} from './protocol'

export const CALIBRATION_STEPS: CalibrationStep[] = ['neutral', 'smile', 'frown']

export const CALIBRATION_PROMPTS: Record<
  CalibrationStep,
  { title: string; instruction: string; shortLabel: string }
> = {
  neutral: {
    title: 'Video setup check',
    instruction: 'Please look at the center of the screen and relax your face.',
    shortLabel: 'Neutral',
  },
  smile: {
    title: 'Video setup check',
    instruction: 'Please give a small closed-mouth smile.',
    shortLabel: 'Closed-mouth smile',
  },
  frown: {
    title: 'Video setup check',
    instruction: 'Please make a small frown.',
    shortLabel: 'Frown',
  },
}

export interface CalibrationSample {
  expression: ExpressionState | null
  telemetry: Telemetry | null
}

export const CALIBRATION_PREP_MS = 900
export const CALIBRATION_COLLECT_MS = 1800
export const CALIBRATION_SAMPLE_MS = 100

export function summarizeCalibrationStep(
  requestId: string,
  step: CalibrationStep,
  samples: CalibrationSample[],
): CalibrationStepResult {
  const expressions = samples.map((s) => s.expression).filter((e): e is ExpressionState => !!e)
  const faceVisible = samples.filter((s) => s.telemetry?.faceFound || s.expression !== null).length
  const faceVisibleRatio = samples.length === 0 ? 0 : faceVisible / samples.length

  const smileValues = expressions.map((e) => e.smile)
  const frownValues = expressions.map((e) => e.frown)
  const opennessValues = expressions.map((e) => e.openness)
  const metrics = {
    smileMean: round2(mean(smileValues)),
    smileMax: round2(max(smileValues)),
    frownMean: round2(mean(frownValues)),
    frownMax: round2(max(frownValues)),
    opennessMean: round2(mean(opennessValues)),
    opennessMax: round2(max(opennessValues)),
    faceVisibleRatio: round2(faceVisibleRatio),
  }

  const qualityFlags: CalibrationQualityFlag[] = []
  if (samples.length < 10 || expressions.length < 6) qualityFlags.push('insufficient_samples')
  if (faceVisibleRatio < 0.8) qualityFlags.push('face_not_visible')

  if (step === 'neutral') {
    if (metrics.smileMean > 0.7 || metrics.frownMean > 0.06 || metrics.opennessMean > 0.18) {
      qualityFlags.push('not_relaxed')
    }
  }

  if (step === 'smile') {
    if (metrics.opennessMax >= 0.28 || metrics.opennessMean >= 0.2) {
      qualityFlags.push('teeth_detected')
    }
    if (metrics.smileMax < 0.52 && metrics.smileMean < 0.38) {
      qualityFlags.push('weak_smile')
    }
  }

  if (step === 'frown') {
    if (metrics.frownMax < 0.025 && metrics.frownMean < 0.015) {
      qualityFlags.push('weak_frown')
    }
  }

  return {
    requestId,
    step,
    status: qualityFlags.length > 0 ? 'needs-retake' : 'complete',
    samples: samples.length,
    capturedAt: new Date().toISOString(),
    metrics,
    qualityFlags,
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function max(values: number[]): number {
  if (values.length === 0) return 0
  return Math.max(...values)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
