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
  const smileSignal = smileEvidence(heuristic)
  const teethSignal = teethSmileEvidence(heuristic)
  const frownSignal = frownEvidence(heuristic)
  const modelSmileSignal = basic.label === 'smile' ? basic.confidence : 1 - basic.confidence
  const modelNeutralSignal = basic.label === 'neutral' ? basic.confidence : 1 - basic.confidence

  let label: ExpressionLabel = 'neutral'
  if (Math.max(modelSmileSignal, smileSignal, teethSignal) >= 0.58) {
    label = 'smiling'
  }
  if (frownSignal >= 0.68 && smileSignal < 0.45 && teethSignal < 0.45) {
    label = 'frowning'
  }

  const basicUncertain = basic.confidence < SMILE_MODEL_BUNDLE_SET.models.basic.uncertainThreshold
  const subtypeSignal = subtypeEvidence(subtype, heuristic, teethSignal)
  const subtypeUncertain = subtypeSignal.confidence < SMILE_MODEL_BUNDLE_SET.models.subtype.uncertainThreshold

  let smileType: SmileType | null = null
  let smileTypeConfidence: number | undefined
  let uncertain = false

  if (label === 'smiling') {
    smileTypeConfidence = round2(subtypeSignal.confidence)
    uncertain = basicUncertain && smileSignal < 0.7 && teethSignal < 0.7
    uncertain = uncertain || subtypeUncertain
    if (!uncertain) {
      smileType = subtypeSignal.type
    }
  }

  return {
    ...heuristic,
    label,
    smileType,
    labelConfidence: round2(
      label === 'frowning'
        ? frownSignal
        : label === 'smiling'
          ? Math.max(modelSmileSignal, smileSignal, teethSignal)
          : Math.max(modelNeutralSignal, 1 - smileSignal, 1 - frownSignal),
    ),
    smileTypeConfidence,
    uncertain: label === 'smiling' ? uncertain || smileType === null : false,
    classifierMode: 'model-subtype',
    classifierVersion: LIVE_CLASSIFIER_VERSION,
  }
}

function smileEvidence(heuristic: ExpressionState): number {
  const directSmile = smoothstep(0.4, 0.62, heuristic.smile)
  const publishedSmile =
    heuristic.label === 'smiling' ? Math.max(0.65, heuristic.labelConfidence ?? 0) : 0
  return clamp01(Math.max(directSmile, publishedSmile))
}

function teethSmileEvidence(heuristic: ExpressionState): number {
  const openMouth = smoothstep(0.13, 0.25, heuristic.openness)
  const smilePresent = smoothstep(0.22, 0.48, heuristic.smile)
  return clamp01(openMouth * Math.max(0.55, smilePresent))
}

function frownEvidence(heuristic: ExpressionState): number {
  if (heuristic.label === 'frowning') return Math.max(0.65, heuristic.labelConfidence ?? 0)
  return smoothstep(0.02, 0.08, heuristic.frown) * (1 - smoothstep(0.35, 0.65, heuristic.smile))
}

function subtypeEvidence(
  model: ModelPrediction,
  heuristic: ExpressionState,
  teethSignal: number,
): { type: SmileType; confidence: number } {
  if (teethSignal >= 0.72) {
    return { type: 'reward', confidence: Math.max(model.confidence, teethSignal, 0.76) }
  }
  if (heuristic.smileType && !heuristic.uncertain && (heuristic.smileTypeConfidence ?? 0) >= 0.62) {
    return {
      type: heuristic.smileType,
      confidence: Math.max(model.confidence, heuristic.smileTypeConfidence ?? 0),
    }
  }
  return {
    type: isSmileType(model.label) ? model.label : 'affiliative',
    confidence: model.confidence,
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

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / Math.max(1e-6, edge1 - edge0))
  return t * t * (3 - 2 * t)
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
