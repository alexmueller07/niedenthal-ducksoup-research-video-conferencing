import assert from 'node:assert/strict'
import { RuleEngine } from '../main/rules'
import {
  type AutomationRule,
  type EffectState,
  type ExpressionState,
  NEUTRAL_EFFECTS,
  normalizeExpressionState,
} from '../main/protocol'

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
    smileTypeTrusted: true,
    classifierMode: 'heuristic-subtype',
    classifierVersion: 'test',
    rawMouthSmileLeft: 0.9,
    rawMouthSmileRight: 0.9,
    rawMouthFrownLeft: 0,
    rawMouthFrownRight: 0,
    rawLipPressLeft: 0.1,
    rawLipPressRight: 0.1,
    rawUpperLipRaiseLeft: 0.6,
    rawUpperLipRaiseRight: 0.6,
    rawJawOpen: 0.3,
    rawLowerLipDropLeft: 0.3,
    rawLowerLipDropRight: 0.3,
    rawEyeSquintLeft: 0.2,
    rawEyeSquintRight: 0.2,
    rawCheekSquintLeft: 0.2,
    rawCheekSquintRight: 0.2,
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
    smileTypeTrusted: undefined,
    classifierMode: undefined,
    classifierVersion: 'badversionwithspacesandsymbols',
    rawMouthSmileLeft: 0,
    rawMouthSmileRight: 0,
    rawMouthFrownLeft: 0,
    rawMouthFrownRight: 0,
    rawLipPressLeft: 0,
    rawLipPressRight: 0,
    rawUpperLipRaiseLeft: 0,
    rawUpperLipRaiseRight: 0,
    rawJawOpen: 0,
    rawLowerLipDropLeft: 0,
    rawLowerLipDropRight: 0,
    rawEyeSquintLeft: 0,
    rawEyeSquintRight: 0,
    rawCheekSquintLeft: 0,
    rawCheekSquintRight: 0,
  },
)

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

engine.onExpression('P1', smiling({ smileTypeConfidence: 0.95, smileTypeTrusted: false }))
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
basicEngine.onExpression('P1', smiling({ smileType: null, smileTypeConfidence: undefined, smileTypeTrusted: false }))
basicEngine.tick(2000)
assert.equal(applied.at(-1), 'rule-smiling', 'basic smiling rule should ignore subtype uncertainty')

console.log('expression contract checks passed')
