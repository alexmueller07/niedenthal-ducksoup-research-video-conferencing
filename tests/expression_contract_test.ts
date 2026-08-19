import assert from 'node:assert/strict'
import { RuleEngine } from '../main/rules'
import {
  type AutomationRule,
  type EffectState,
  type ExpressionState,
  NEUTRAL_EFFECTS,
  normalizeExpressionState,
} from '../main/protocol'
import {
  expressionFromLiveSmileModel,
  smileModelMetadata,
  type SmileModelFeatureVector,
} from '../renderer/lib/smileModel'

function smiling(overrides: Partial<ExpressionState> = {}): ExpressionState {
  return {
    label: 'smiling',
    smileType: 'reward',
    smile: 0.9,
    frown: 0,
    asymmetry: 0.1,
    eyeConstriction: 0.2,
    lipPress: 0.1,
    openness: 0.7,
    labelConfidence: 0.95,
    smileTypeConfidence: 0.9,
    uncertain: false,
    classifierMode: 'heuristic-subtype',
    classifierVersion: 'test',
    ...overrides,
  }
}

function expressionRule(expression: AutomationRule['trigger']['expression']): AutomationRule {
  return {
    id: `rule-${expression}`,
    enabled: true,
    trigger: { kind: 'expression', slot: 'P1', expression, holdSec: 0 },
    action: { slot: 'P2', presetId: 'smile-subtle' },
    release: 'previous',
    revertAfterSec: null,
  }
}

assert.equal(normalizeExpressionState({ label: 'smirking' }), null)
assert.deepEqual(
  normalizeExpressionState({
    label: 'neutral',
    smileType: 'reward',
    smile: 2,
    frown: -1,
    asymmetry: Number.NaN,
    eyeConstriction: 0.5,
    lipPress: 0.2,
    openness: 0.3,
    smileTypeConfidence: 2,
    classifierMode: 'made-up',
    classifierVersion: 'bad version with spaces and symbols!!!',
  }),
  {
    label: 'neutral',
    smileType: null,
    smile: 1,
    frown: 0,
    asymmetry: 0,
    eyeConstriction: 0.5,
    lipPress: 0.2,
    openness: 0.3,
    labelConfidence: undefined,
    smileTypeConfidence: undefined,
    uncertain: false,
    classifierMode: undefined,
    classifierVersion: 'badversionwithspacesandsymbols',
  },
)

assert.deepEqual(
  normalizeExpressionState({
    label: 'smiling',
    smileType: null,
    smile: 0.75,
    frown: 0,
    asymmetry: 0.2,
    eyeConstriction: 0.1,
    lipPress: 0.1,
    openness: 0.4,
    labelConfidence: 0.66,
    smileTypeConfidence: 0.44,
    uncertain: true,
    classifierMode: 'model-subtype',
    classifierVersion: 'phase5-app-contract-v1+phase4-logreg-v1+live-v1',
  }),
  {
    label: 'smiling',
    smileType: null,
    smile: 0.75,
    frown: 0,
    asymmetry: 0.2,
    eyeConstriction: 0.1,
    lipPress: 0.1,
    openness: 0.4,
    labelConfidence: 0.66,
    smileTypeConfidence: 0.44,
    uncertain: true,
    classifierMode: 'model-subtype',
    classifierVersion: 'phase5-app-contract-v1+phase4-logreg-v1+live-v1',
  },
)

const modelFeatures: SmileModelFeatureVector = {
  frames_sampled: 1,
  frames_ok: 1,
  face_detection_rate: 1,
  smile_detection_rate: 1,
  image_width_median: 640,
  image_height_median: 480,
  brightness_mean: 90,
  brightness_std: 50,
  contrast_rms_mean: 50,
  sharpness_laplacian_var_mean: 60,
  edge_density_mean: 0.03,
  lower_face_brightness_mean: 80,
  lower_face_edge_density_mean: 0.03,
  lower_face_symmetry_mad_mean: 0.1,
  lower_face_dark_ratio_mean: 0.25,
  face_area_pct_mean: 0.45,
  face_area_pct_std: 0,
  face_center_x_pct_mean: 0.5,
  face_center_y_pct_mean: 0.55,
  smile_area_pct_mean: 0.1,
  smile_area_pct_std: 0,
  smile_to_face_width_ratio_mean: 0.55,
  smile_to_face_width_ratio_std: 0,
  duration_ms: 0,
}
const modeled = expressionFromLiveSmileModel(modelFeatures, smiling())
assert.equal(modeled.classifierMode, 'model-subtype')
assert.equal(modeled.classifierVersion, smileModelMetadata().classifierVersion)
assert.ok(typeof modeled.labelConfidence === 'number')
assert.ok(typeof modeled.smileTypeConfidence === 'number' || modeled.smileType === null)

const teethSmile = expressionFromLiveSmileModel(
  {
    ...modelFeatures,
    smile_detection_rate: 0,
    smile_area_pct_mean: 0.14,
    smile_to_face_width_ratio_mean: 0.7,
  },
  smiling({
    label: 'neutral',
    smileType: null,
    smile: 0.38,
    frown: 0,
    openness: 0.27,
    labelConfidence: 0.2,
    smileTypeConfidence: undefined,
    uncertain: false,
  }),
)
assert.equal(teethSmile.label, 'smiling', 'teeth/open-mouth smile should force smiling')
assert.equal(teethSmile.smileType, 'reward', 'teeth/open-mouth smile should map to reward')
assert.ok((teethSmile.labelConfidence ?? 0) >= 0.7)

const effects: Record<'P1' | 'P2', EffectState> = {
  P1: { ...NEUTRAL_EFFECTS },
  P2: { ...NEUTRAL_EFFECTS },
}
const applied: string[] = []
const engine = new RuleEngine({
  phase: () => 'waiting',
  liveStartMs: () => null,
  effectsOf: (slot) => effects[slot],
  applyEffects: (slot, next, rule) => {
    effects[slot] = next
    applied.push(rule.id)
  },
  onActiveChange: () => {},
})

engine.setRules([expressionRule('reward-smile')])
engine.onExpression('P1', smiling({ smileTypeConfidence: 0.69 }))
engine.tick(1000)
assert.deepEqual(applied, [], 'low-confidence reward subtype must not fire')

engine.onExpression('P1', smiling({ smileTypeConfidence: 0.95, uncertain: true }))
engine.tick(1250)
assert.deepEqual(applied, [], 'uncertain reward subtype must not fire')

engine.onExpression('P1', smiling({ smileTypeConfidence: 0.95 }))
engine.tick(1500)
assert.deepEqual(applied, ['rule-reward-smile'], 'confident reward subtype should fire')

const basicEngine = new RuleEngine({
  phase: () => 'waiting',
  liveStartMs: () => null,
  effectsOf: () => ({ ...NEUTRAL_EFFECTS }),
  applyEffects: (_slot, _next, rule) => applied.push(rule.id),
  onActiveChange: () => {},
})
basicEngine.setRules([expressionRule('smiling')])
basicEngine.onExpression('P1', smiling({ smileType: null, smileTypeConfidence: undefined, uncertain: true }))
basicEngine.tick(2000)
assert.equal(applied.at(-1), 'rule-smiling', 'basic smiling rule should ignore subtype uncertainty')

console.log('expression contract checks passed')
