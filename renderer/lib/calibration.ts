import type {
  CalibrationQualityFlag,
  CalibrationStep,
  CalibrationStepResult,
  ExpressionCalibrationProfile,
  ExpressionState,
  Telemetry,
} from './protocol'

export const CALIBRATION_STEPS: CalibrationStep[] = ['neutral', 'smile', 'frown']
export const FACE_SHAPE_NORMALIZATION_VERSION = 'face-shape-normalization-v1'

export const FACE_SHAPE_NORMALIZATION_THRESHOLDS = {
  smileOn: 0.58,
  smileOff: 0.32,
  frownOn: 0.5,
  frownOff: 0.28,
  minSmileRange: 0.08,
  minFrownRange: 0.025,
  minOpennessRange: 0.12,
  rewardOpennessDelta: 0.12,
  rewardMouthOpenRatioDelta: 0.06,
  minRewardOpenness: 0.2,
  minRewardMouthOpenRatio: 0.14,
  minYawSymmetry: 0.55,
}

export const CALIBRATION_PROMPTS: Record<
  CalibrationStep,
  { title: string; instruction: string; shortLabel: string }
> = {
  neutral: {
    title: 'Video setup check',
    instruction: 'Take a moment, look at the center of the screen, and relax your face.',
    shortLabel: 'Neutral',
  },
  smile: {
    title: 'Video setup check',
    instruction: 'When you are ready, give a small closed-mouth smile.',
    shortLabel: 'Closed-mouth smile',
  },
  frown: {
    title: 'Video setup check',
    instruction: 'When you are ready, make a small frown.',
    shortLabel: 'Frown',
  },
}

export interface CalibrationSample {
  expression: ExpressionState | null
  telemetry: Telemetry | null
}

export const CALIBRATION_PREP_MS = 1500
export const CALIBRATION_COLLECT_MS = 2400
export const CALIBRATION_SAMPLE_MS = 100
export const CALIBRATION_READY_TIMEOUT_MS = 10000
export const CALIBRATION_MAX_AUTO_RETRIES = 2
export const CALIBRATION_RETRY_PAUSE_MS = 1400

export type CalibrationReadinessStatus =
  | 'ready'
  | 'waiting-for-face'
  | 'waiting-for-relaxed-face'
  | 'waiting-for-smile'
  | 'waiting-for-frown'

export interface CalibrationReadiness {
  ready: boolean
  status: CalibrationReadinessStatus
}

export function calibrationStepReadiness(
  step: CalibrationStep,
  sample: CalibrationSample,
): CalibrationReadiness {
  const expression = sample.expression
  const faceVisible = sample.telemetry?.faceFound || expression !== null
  if (!faceVisible || !expression) return { ready: false, status: 'waiting-for-face' }

  if (step === 'neutral') {
    const mouthOpenRatio = expression.faceShape?.mouthOpenRatio ?? 0
    const relaxed =
      expression.smile < 0.65 &&
      expression.frown < 0.05 &&
      expression.openness < 0.16 &&
      mouthOpenRatio < 0.09
    return relaxed
      ? { ready: true, status: 'ready' }
      : { ready: false, status: 'waiting-for-relaxed-face' }
  }

  if (step === 'smile') {
    return expression.smile >= 0.48
      ? { ready: true, status: 'ready' }
      : { ready: false, status: 'waiting-for-smile' }
  }

  return expression.frown >= 0.018
    ? { ready: true, status: 'ready' }
    : { ready: false, status: 'waiting-for-frown' }
}

export function calibrationRetryInstruction(
  step: CalibrationStep,
  qualityFlags: CalibrationQualityFlag[],
): string {
  if (
    qualityFlags.includes('face_not_visible') ||
    qualityFlags.includes('insufficient_samples')
  ) {
    return 'Please stay centered and keep your face visible. We will try this setup check again.'
  }
  if (qualityFlags.includes('off_axis_face')) {
    return 'Please face the screen directly. We will try this setup check again.'
  }
  if (qualityFlags.includes('teeth_detected')) {
    return 'Please keep your lips closed for this setup smile. We will try this check again.'
  }
  if (qualityFlags.includes('weak_smile')) {
    return 'Please make the small closed-mouth smile a little clearer. We will try this check again.'
  }
  if (qualityFlags.includes('weak_frown')) {
    return 'Please make the small frown a little clearer. We will try this check again.'
  }
  if (qualityFlags.includes('not_relaxed')) {
    return 'Please relax your face and look at the center of the screen. We will try this check again.'
  }
  return `Please repeat the ${CALIBRATION_PROMPTS[step].shortLabel.toLowerCase()} check.`
}

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
  const mouthWidthToFaceWidthValues = expressions
    .map((e) => e.faceShape?.mouthWidthToFaceWidth)
    .filter(isNumber)
  const mouthWidthToEyeSpanValues = expressions
    .map((e) => e.faceShape?.mouthWidthToEyeSpan)
    .filter(isNumber)
  const mouthOpenRatioValues = expressions
    .map((e) => e.faceShape?.mouthOpenRatio)
    .filter(isNumber)
  const mouthCornerTiltValues = expressions
    .map((e) => e.faceShape?.mouthCornerTilt)
    .filter(isNumber)
  const yawSymmetryValues = expressions.map((e) => e.faceShape?.yawSymmetry).filter(isNumber)
  const metrics = {
    smileMean: round2(mean(smileValues)),
    smileMax: round2(max(smileValues)),
    frownMean: round2(mean(frownValues)),
    frownMax: round2(max(frownValues)),
    opennessMean: round2(mean(opennessValues)),
    opennessMax: round2(max(opennessValues)),
    faceVisibleRatio: round2(faceVisibleRatio),
    mouthWidthToFaceWidthMean: round2(mean(mouthWidthToFaceWidthValues)),
    mouthWidthToEyeSpanMean: round2(mean(mouthWidthToEyeSpanValues)),
    mouthOpenRatioMean: round2(mean(mouthOpenRatioValues)),
    mouthOpenRatioMax: round2(max(mouthOpenRatioValues)),
    mouthCornerTiltMean: round2(mean(mouthCornerTiltValues)),
    yawSymmetryMean: round2(mean(yawSymmetryValues)),
  }

  const qualityFlags: CalibrationQualityFlag[] = []
  if (samples.length < 10 || expressions.length < 6) qualityFlags.push('insufficient_samples')
  if (faceVisibleRatio < 0.8) qualityFlags.push('face_not_visible')
  if (
    yawSymmetryValues.length > 0 &&
    metrics.yawSymmetryMean < FACE_SHAPE_NORMALIZATION_THRESHOLDS.minYawSymmetry
  ) {
    qualityFlags.push('off_axis_face')
  }

  if (step === 'neutral') {
    if (
      metrics.smileMean > 0.7 ||
      metrics.frownMean > 0.06 ||
      metrics.opennessMean > 0.18 ||
      metrics.mouthOpenRatioMean > 0.1
    ) {
      qualityFlags.push('not_relaxed')
    }
  }

  if (step === 'smile') {
    if (
      metrics.opennessMax >= 0.28 ||
      metrics.opennessMean >= 0.2 ||
      metrics.mouthOpenRatioMax >= 0.14 ||
      metrics.mouthOpenRatioMean >= 0.1
    ) {
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

export interface NormalizedExpressionFeatures {
  normalizedSmile: number
  normalizedFrown: number
  normalizedOpenness: number
  smileMargin: number
  frownMargin: number
  rewardOpennessThreshold: number
  rewardMouthOpenRatioThreshold: number
}

export function buildExpressionCalibrationProfile(
  results: Partial<Record<CalibrationStep, CalibrationStepResult>>,
  acceptedAt = new Date().toISOString(),
): ExpressionCalibrationProfile | null {
  const neutral = results.neutral
  const smile = results.smile
  const frown = results.frown
  if (
    !neutral ||
    !smile ||
    !frown ||
    neutral.status !== 'complete' ||
    smile.status !== 'complete' ||
    frown.status !== 'complete'
  ) {
    return null
  }

  const rewardOpenness = Math.max(
    FACE_SHAPE_NORMALIZATION_THRESHOLDS.minRewardOpenness,
    smile.metrics.opennessMax + FACE_SHAPE_NORMALIZATION_THRESHOLDS.rewardOpennessDelta,
    neutral.metrics.opennessMean + FACE_SHAPE_NORMALIZATION_THRESHOLDS.minOpennessRange,
  )
  const rewardMouthOpenRatio = Math.max(
    FACE_SHAPE_NORMALIZATION_THRESHOLDS.minRewardMouthOpenRatio,
    smile.metrics.mouthOpenRatioMax +
      FACE_SHAPE_NORMALIZATION_THRESHOLDS.rewardMouthOpenRatioDelta,
  )

  return {
    version: FACE_SHAPE_NORMALIZATION_VERSION,
    acceptedAt,
    steps: {
      neutral: neutral.metrics,
      smile: smile.metrics,
      frown: frown.metrics,
    },
    thresholds: {
      smileOn: FACE_SHAPE_NORMALIZATION_THRESHOLDS.smileOn,
      smileOff: FACE_SHAPE_NORMALIZATION_THRESHOLDS.smileOff,
      frownOn: FACE_SHAPE_NORMALIZATION_THRESHOLDS.frownOn,
      frownOff: FACE_SHAPE_NORMALIZATION_THRESHOLDS.frownOff,
      rewardOpenness: round2(rewardOpenness),
      rewardMouthOpenRatio: round2(rewardMouthOpenRatio),
    },
  }
}

export function normalizeExpressionFeatures(
  expression: Pick<ExpressionState, 'smile' | 'frown' | 'openness' | 'faceShape'>,
  profile: ExpressionCalibrationProfile,
): NormalizedExpressionFeatures {
  const neutral = profile.steps.neutral
  const smile = profile.steps.smile
  const frown = profile.steps.frown

  const smileRange = activeRange(
    neutral.smileMean,
    smile.smileMean,
    smile.smileMax,
    FACE_SHAPE_NORMALIZATION_THRESHOLDS.minSmileRange,
  )
  const frownRange = activeRange(
    neutral.frownMean,
    frown.frownMean,
    frown.frownMax,
    FACE_SHAPE_NORMALIZATION_THRESHOLDS.minFrownRange,
  )
  const opennessRange = Math.max(
    FACE_SHAPE_NORMALIZATION_THRESHOLDS.minOpennessRange,
    profile.thresholds.rewardOpenness - neutral.opennessMean,
  )

  const normalizedSmile = clamp01((expression.smile - neutral.smileMean) / smileRange)
  const normalizedFrown = clamp01((expression.frown - neutral.frownMean) / frownRange)
  const blendshapeOpen = clamp01((expression.openness - neutral.opennessMean) / opennessRange)
  const geometryOpen =
    typeof expression.faceShape?.mouthOpenRatio === 'number'
      ? clamp01(
          (expression.faceShape.mouthOpenRatio - neutral.mouthOpenRatioMean) /
            Math.max(
              0.04,
              profile.thresholds.rewardMouthOpenRatio - neutral.mouthOpenRatioMean,
            ),
        )
      : 0
  const normalizedOpenness = Math.max(blendshapeOpen, geometryOpen)

  return {
    normalizedSmile: round2(normalizedSmile),
    normalizedFrown: round2(normalizedFrown),
    normalizedOpenness: round2(normalizedOpenness),
    smileMargin: round2(normalizedSmile - profile.thresholds.smileOn),
    frownMargin: round2(normalizedFrown - profile.thresholds.frownOn),
    rewardOpennessThreshold: profile.thresholds.rewardOpenness,
    rewardMouthOpenRatioThreshold: profile.thresholds.rewardMouthOpenRatio,
  }
}

function activeRange(neutral: number, meanValue: number, maxValue: number, minimum: number): number {
  const active = Math.max(meanValue, maxValue * 0.85, neutral + minimum)
  return Math.max(minimum, active - neutral)
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
