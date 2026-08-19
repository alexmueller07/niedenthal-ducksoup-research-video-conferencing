import type { ExpressionLabel, ExpressionState, SmileType } from './protocol'
import { SMILE_MODEL_BUNDLE_SET } from './smileModelArtifact.generated'

export type SmileModelFeatureVector = Record<string, number>

export interface SmileModelBundle {
  mode: 'basic' | 'model-subtype'
  modelVersion: string
  uncertainThreshold: number
  features: readonly string[]
  classes: readonly string[]
  imputerStatistics: readonly number[]
  scalerMean: readonly number[]
  scalerScale: readonly number[]
  coef: readonly (readonly number[])[]
  intercept: readonly number[]
}

export interface SmileModelBundleSet {
  artifactVersion: string
  liveAdapterVersion: string
  sourceRepo: string
  sourceCommit: string
  warning: string
  models: {
    basic: SmileModelBundle
    subtype: SmileModelBundle
  }
}

interface ModelPrediction {
  label: string
  confidence: number
  probabilities: Record<string, number>
}

const LIVE_CLASSIFIER_VERSION =
  `${SMILE_MODEL_BUNDLE_SET.artifactVersion}+live-v1`

export function smileModelMetadata() {
  return {
    artifactVersion: SMILE_MODEL_BUNDLE_SET.artifactVersion,
    liveAdapterVersion: SMILE_MODEL_BUNDLE_SET.liveAdapterVersion,
    classifierVersion: LIVE_CLASSIFIER_VERSION,
    sourceCommit: SMILE_MODEL_BUNDLE_SET.sourceCommit,
    warning: SMILE_MODEL_BUNDLE_SET.warning,
  }
}

export function expressionFromLiveSmileModel(
  features: SmileModelFeatureVector,
  heuristic: ExpressionState,
): ExpressionState {
  const basic = predictBundle(SMILE_MODEL_BUNDLE_SET.models.basic, features)
  const subtype = predictBundle(SMILE_MODEL_BUNDLE_SET.models.subtype, features)
  const heuristicFrown =
    heuristic.label === 'frowning' && (heuristic.labelConfidence ?? 0) >= 0.5

  let label: ExpressionLabel = basic.label === 'smile' ? 'smiling' : 'neutral'
  if (heuristicFrown) label = 'frowning'

  const basicUncertain = basic.confidence < SMILE_MODEL_BUNDLE_SET.models.basic.uncertainThreshold
  const subtypeUncertain =
    subtype.confidence < SMILE_MODEL_BUNDLE_SET.models.subtype.uncertainThreshold

  let smileType: SmileType | null = null
  let smileTypeConfidence: number | undefined
  let uncertain = false

  if (label === 'smiling') {
    smileTypeConfidence = round2(subtype.confidence)
    uncertain = basicUncertain || subtypeUncertain
    if (!uncertain && isSmileType(subtype.label)) {
      smileType = subtype.label
    }
  }

  return {
    ...heuristic,
    label,
    smileType,
    labelConfidence: round2(heuristicFrown ? heuristic.labelConfidence ?? 0 : basic.confidence),
    smileTypeConfidence,
    uncertain: label === 'smiling' ? uncertain || smileType === null : false,
    classifierMode: 'model-subtype',
    classifierVersion: LIVE_CLASSIFIER_VERSION,
  }
}

export function predictBundle(
  bundle: SmileModelBundle,
  features: SmileModelFeatureVector,
): ModelPrediction {
  const x = bundle.features.map((name, i) => {
    const value = features[name]
    const imputed = Number.isFinite(value) ? value : bundle.imputerStatistics[i]
    const scale = bundle.scalerScale[i] || 1
    return (imputed - bundle.scalerMean[i]) / scale
  })

  const logits =
    bundle.classes.length === 2 && bundle.coef.length === 1
      ? binaryLogits(bundle, x)
      : bundle.coef.map((row, i) => dot(row, x) + bundle.intercept[i])
  const probs = softmax(logits)
  let best = 0
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > probs[best]) best = i
  }
  return {
    label: bundle.classes[best],
    confidence: probs[best],
    probabilities: Object.fromEntries(bundle.classes.map((label, i) => [label, round4(probs[i])])),
  }
}

function binaryLogits(bundle: SmileModelBundle, x: number[]): number[] {
  const score = dot(bundle.coef[0], x) + bundle.intercept[0]
  return [0, score]
}

function dot(a: readonly number[], b: readonly number[]): number {
  let total = 0
  for (let i = 0; i < a.length; i++) total += a[i] * b[i]
  return total
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits)
  const exps = logits.map((v) => Math.exp(v - max))
  const sum = exps.reduce((acc, v) => acc + v, 0)
  return exps.map((v) => v / sum)
}

function isSmileType(value: string): value is SmileType {
  return value === 'reward' || value === 'affiliative' || value === 'dominance'
}

function round2(value: number): number {
  return Math.round(clamp01(value) * 100) / 100
}

function round4(value: number): number {
  return Math.round(clamp01(value) * 10000) / 10000
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
