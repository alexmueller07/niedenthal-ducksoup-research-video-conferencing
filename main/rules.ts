// RuleEngine: evaluates the researcher-authored automation rules.
//
// Runs inside the session server so rules keep firing even if the dashboard
// tab is busy, and so every firing lands in events.csv like any other effect
// command. The dashboard only *edits* the rule list; the server owns execution.
//
// Semantics (mirrors what the RA sees in the rule builder):
//   expression rule — WHILE the watched participant holds the expression for
//     holdSec, apply the preset to the target. When the expression stops, the
//     release mode decides what happens: restore the pre-rule effects
//     ('previous'), reset to neutral ('neutral'), or leave as is ('none').
//   timer rule — AT atSec into the live conversation, apply the preset once.
//     With revertAfterSec set, the pre-rule effects come back after that many
//     seconds.
// Expression rules run in the waiting room AND during the live conversation
// (so the setup can be tested before pressing Start); timer rules count from
// the moment the conversation goes live. Ending the session or returning to
// the waiting room releases anything a rule left applied.

import type {
  AutomationRule,
  EffectState,
  ExpressionState,
  Phase,
  PSlot,
  RuleExpression,
} from './protocol'
import { NEUTRAL_EFFECTS, SUBTYPE_RULE_CONFIDENCE_THRESHOLD } from './protocol'
import { getPreset, PRESETS } from './presets'
import { DEFAULT_VOICE_CONDITION } from './voiceProtocol'
import type { VoiceCondition } from './voiceProtocol'

export function validRules(value: unknown): value is AutomationRule[] {
  if (!Array.isArray(value) || value.length > 40) return false
  const ids = new Set<string>()
  return value.every(rule => {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' ||
      rule.id.length > 80 || !rule.id || ids.has(rule.id) || typeof rule.enabled !== 'boolean') return false
    ids.add(rule.id)
    if (!['previous','neutral','none'].includes(rule.release) ||
      (rule.revertAfterSec !== null && (!Number.isFinite(rule.revertAfterSec) || rule.revertAfterSec < 1))) return false
    const trigger = rule.trigger
    if (!trigger || typeof trigger !== 'object') return false
    if (trigger.kind === 'expression') {
      if (!['P1','P2'].includes(trigger.slot) || !['smiling','frowning','reward-smile','affiliative-smile','dominance-smile'].includes(trigger.expression) ||
        !Number.isFinite(trigger.holdSec) || trigger.holdSec < 0 || trigger.holdSec > 30) return false
    } else if (trigger.kind === 'timer') {
      if (!Number.isFinite(trigger.atSec) || trigger.atSec < 0 || trigger.atSec > 10859) return false
    } else return false
    const action = rule.action
    if (!action || !['P1','P2'].includes(action.slot)) return false
    return action.kind === 'voice'
      ? ['bypass','audibility','match','detone','lower','higher'].includes(action.mode)
      : (action.kind === undefined || action.kind === 'face') && PRESETS.some(p => p.id === action.presetId)
  })
}

/** What the engine needs from the session server. */
export interface RuleHost {
  phase(): Phase
  /** Epoch ms when the live phase started (null while waiting/ended). */
  liveStartMs(): number | null
  /** Server-tracked effect state of a seat (last commanded). */
  effectsOf(slot: PSlot): EffectState
  /** Apply effects to a seat: send effect-command, update roster, log. */
  applyEffects(
    slot: PSlot,
    effects: EffectState,
    rule: AutomationRule,
    why: 'fired' | 'released' | 'reverted',
  ): void
  /** Push the active-rule map to the dashboard indicator. */
  onActiveChange(active: Record<string, boolean>): void
  voiceConditionOf?(): VoiceCondition
  canApplyVoice?(condition: VoiceCondition): boolean
  applyVoice?(condition: VoiceCondition, rule: AutomationRule, why: 'fired' | 'released' | 'reverted'): void
}

interface RuleRuntime {
  /** Expression rules: when the condition started holding (epoch ms). */
  holdSince: number | null
  fired: boolean
  firedAt: number | null
  /** Effects on the target just before this rule fired (for restore). */
  savedEffects: EffectState | null
  appliedEffects: EffectState | null
  savedVoice: VoiceCondition | null
  appliedVoice: VoiceCondition | null
  savedLegacyPitch: Partial<Record<PSlot, Pick<EffectState, 'voiceSemitones' | 'voiceSmile'>>> | null
  /** Timer rules: fully done for this live phase (fired and, if set, reverted). */
  done: boolean
}

function matches(expr: RuleExpression, state: ExpressionState | null): boolean {
  if (!state) return false
  switch (expr) {
    case 'smiling':
      return state.label === 'smiling'
    case 'frowning':
      return state.label === 'frowning'
    case 'reward-smile':
      return confidentSubtype(state, 'reward')
    case 'affiliative-smile':
      return confidentSubtype(state, 'affiliative')
    case 'dominance-smile':
      return confidentSubtype(state, 'dominance')
  }
}

function confidentSubtype(state: ExpressionState, type: ExpressionState['smileType']): boolean {
  return (
    state.label === 'smiling' &&
    state.smileType === type &&
    state.smileTypeTrusted === true &&
    (state.smileTypeConfidence ?? 0) >= SUBTYPE_RULE_CONFIDENCE_THRESHOLD
  )
}

export class RuleEngine {
  private rules: AutomationRule[] = []
  private rt = new Map<string, RuleRuntime>()
  private expressions: Partial<Record<PSlot, ExpressionState | null>> = {}
  private lastActiveJson = ''

  constructor(private host: RuleHost) {}

  get currentRules(): AutomationRule[] {
    return this.rules
  }

  /** Replace the rule list (mid-call edits included). */
  setRules(rules: AutomationRule[]) {
    // Any fired rule that disappears or is disabled releases first, so a
    // deleted rule cannot leave a participant stuck in a morph.
    for (const rule of this.rules) {
      const still = rules.find((r) => r.id === rule.id)
      const state = this.rt.get(rule.id)
      if (state?.fired && (!still || !still.enabled || JSON.stringify(still) !== JSON.stringify(rule))) {
        this.release(rule, state, 'released')
      }
    }
    const next = new Map<string, RuleRuntime>()
    for (const rule of rules) {
      const old = this.rules.find(r => r.id === rule.id)
      next.set(rule.id, old && JSON.stringify(old) === JSON.stringify(rule)
        ? this.rt.get(rule.id) ?? freshRuntime() : freshRuntime())
    }
    this.rules = rules
    this.rt = next
    this.emitActive()
  }

  onExpression(slot: PSlot, state: ExpressionState | null) {
    this.expressions[slot] = state
  }

  /** Called ~4×/s by the server. Drives holds, timers, and reverts. */
  tick(nowMs: number) {
    const phase = this.host.phase()
    // Expression rules also run in the waiting room; nothing runs after end.
    if (phase !== 'live' && phase !== 'waiting') return
    const liveStart = this.host.liveStartMs()

    for (const rule of this.rules) {
      const state = this.rt.get(rule.id)
      if (!state) continue
      if (!rule.enabled) continue

      if (rule.trigger.kind === 'expression') {
        const holding = matches(rule.trigger.expression, this.expressions[rule.trigger.slot] ?? null)
        if (holding) {
          if (state.holdSince === null) state.holdSince = nowMs
          const heldMs = nowMs - state.holdSince
          if (!state.fired && heldMs >= rule.trigger.holdSec * 1000) {
            this.fire(rule, state, nowMs)
          }
        } else {
          state.holdSince = null
          if (state.fired) this.release(rule, state, 'released')
        }
      } else {
        // Timer rule — counts from conversation start only.
        if (phase !== 'live' || liveStart === null || state.done) continue
        const tSec = (nowMs - liveStart) / 1000
        if (!state.fired && tSec >= rule.trigger.atSec) {
          if (!this.fire(rule, state, nowMs)) state.done = true
          else if (rule.revertAfterSec === null) state.done = true
        } else if (
          state.fired &&
          rule.revertAfterSec !== null &&
          state.firedAt !== null &&
          nowMs - state.firedAt >= rule.revertAfterSec * 1000
        ) {
          this.release(rule, state, 'reverted')
          state.done = true
        }
      }
    }
    this.emitActive()
  }

  /** Phase changed. Live keeps expression holds (only timers re-arm); any
   *  other phase releases whatever a rule left applied and starts clean. */
  onPhaseChange(to: Phase) {
    if (to === 'live') {
      for (const rule of this.rules) {
        if (rule.trigger.kind === 'timer') this.rt.set(rule.id, freshRuntime())
      }
    } else {
      for (const rule of this.rules) {
        const state = this.rt.get(rule.id)
        if (state?.fired) this.release(rule, state, 'released')
      }
      this.rt = new Map(this.rules.map((r) => [r.id, freshRuntime()]))
      this.expressions = {}
    }
    this.emitActive()
  }

  private fire(rule: AutomationRule, state: RuleRuntime, nowMs: number): boolean {
    if (rule.action.kind === 'voice') {
      if ([...this.rt.entries()].some(([id, rt]) => id !== rule.id && rt.fired &&
        (rt.appliedVoice !== null || rt.appliedEffects !== null))) return false
      if (rule.action.mode === 'lower' || rule.action.mode === 'higher') {
        const currentVoice = this.host.voiceConditionOf?.()
        if (!currentVoice || currentVoice.mode !== 'bypass' || currentVoice.audibility) return false
        const target = this.host.effectsOf(rule.action.slot)
        state.savedEffects = { ...target }
        state.appliedEffects = { ...target, voiceSemitones: rule.action.mode === 'lower' ? -1 : 1 }
        state.fired = true
        state.firedAt = nowMs
        this.host.applyEffects(rule.action.slot, state.appliedEffects, rule, 'fired')
        return true
      }
      const condition: VoiceCondition = { ...DEFAULT_VOICE_CONDITION, mode: rule.action.mode,
        targetSlot: rule.action.mode === 'match' || rule.action.mode === 'detone' ? rule.action.slot : null,
        pitchRangeScale: rule.action.mode === 'detone' ? .75 : 1,
        intensityRangeScale: rule.action.mode === 'detone' ? .8 : 1 }
      if (!this.host.voiceConditionOf || !this.host.applyVoice || !this.host.canApplyVoice?.(condition)) return false
      state.savedVoice = { ...this.host.voiceConditionOf() }
      const manualVoice = (slot: PSlot) => {
        const { voiceSemitones, voiceSmile } = this.host.effectsOf(slot)
        return { voiceSemitones, voiceSmile }
      }
      state.savedLegacyPitch = { P1:manualVoice('P1'), P2:manualVoice('P2') }
      state.appliedVoice = condition
      state.fired = true
      state.firedAt = nowMs
      this.host.applyVoice(condition, rule, 'fired')
      return true
    }
    const preset = getPreset(rule.action.presetId)
    state.savedEffects = { ...this.host.effectsOf(rule.action.slot) }
    state.fired = true
    state.firedAt = nowMs
    this.host.applyEffects(
      rule.action.slot,
      { alpha: preset.alpha, voiceSemitones: preset.voiceSemitones, voiceSmile: preset.voiceSmile },
      rule,
      'fired',
    )
    return true
  }

  private release(rule: AutomationRule, state: RuleRuntime, why: 'released' | 'reverted') {
    const mode = rule.trigger.kind === 'timer' ? 'previous' : rule.release
    if (rule.action.kind === 'voice' && state.appliedVoice) {
      // A later manual command owns the voice condition; never overwrite it.
      const stillApplied = state.appliedVoice && JSON.stringify(this.host.voiceConditionOf?.()) === JSON.stringify(state.appliedVoice)
      if (stillApplied && mode !== 'none') {
        const restore = mode === 'previous' ? state.savedVoice ?? { ...DEFAULT_VOICE_CONDITION } : { ...DEFAULT_VOICE_CONDITION }
        this.host.applyVoice?.(restore, rule, why)
        if (mode === 'previous' && restore.mode === 'bypass' && !restore.audibility) {
          for (const slot of ['P1','P2'] as const) {
            const old = state.savedLegacyPitch?.[slot]
            if (old && (old.voiceSemitones !== 0 || old.voiceSmile !== 0)) this.host.applyEffects(slot,
              { ...this.host.effectsOf(slot), ...old },rule,why)
          }
        }
      }
    } else if (rule.action.kind === 'voice' && state.appliedEffects) {
      // Preserve a later manual pitch/face edit by the researcher.
      if (JSON.stringify(this.host.effectsOf(rule.action.slot)) === JSON.stringify(state.appliedEffects) && mode !== 'none') {
        this.host.applyEffects(rule.action.slot, mode === 'previous' ? state.savedEffects ?? { ...NEUTRAL_EFFECTS }
          : { ...state.appliedEffects, voiceSemitones: 0, voiceSmile: 0 }, rule, why)
      }
    } else if (mode === 'previous') {
      this.host.applyEffects(rule.action.slot, state.savedEffects ?? { ...NEUTRAL_EFFECTS }, rule, why)
    } else if (mode === 'neutral') {
      this.host.applyEffects(rule.action.slot, { ...NEUTRAL_EFFECTS }, rule, why)
    }
    // 'none' → leave the effects exactly where the rule put them.
    state.fired = false
    state.firedAt = null
    state.savedEffects = null
    state.appliedEffects = null
    state.savedVoice = null
    state.appliedVoice = null
    state.savedLegacyPitch = null
  }

  private emitActive() {
    const active: Record<string, boolean> = {}
    for (const rule of this.rules) {
      const s = this.rt.get(rule.id)
      active[rule.id] = !!s?.fired
    }
    const json = JSON.stringify(active)
    if (json !== this.lastActiveJson) {
      this.lastActiveJson = json
      this.host.onActiveChange(active)
    }
  }
}

function freshRuntime(): RuleRuntime {
  return { holdSince: null, fired: false, firedAt: null, savedEffects: null, appliedEffects: null, savedVoice: null, appliedVoice: null, savedLegacyPitch: null, done: false }
}

/** Human-readable one-liner for the event log. */
export function describeRule(rule: AutomationRule): string {
  const t = rule.trigger
  const when =
    t.kind === 'expression'
      ? `when ${t.slot} ${t.expression.replace('-', ' ')} ≥${t.holdSec}s`
      : `at ${Math.floor(t.atSec / 60)}:${String(Math.floor(t.atSec % 60)).padStart(2, '0')}`
  return `${when} → ${rule.action.slot} ${rule.action.kind === 'voice' ? `voice ${rule.action.mode}` : rule.action.presetId}`
}
