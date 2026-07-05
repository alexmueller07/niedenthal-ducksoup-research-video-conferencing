// Wire protocol shared by the session server (Electron main process on the
// researcher's machine) and every client (participant + researcher renderers).
//
// Transport: JSON over one WebSocket per client. The server assigns seats,
// relays WebRTC signaling between peers, routes researcher effect commands,
// and logs every event to the session CSVs.
//
// Deliberately DOM-type-free so the Electron main process can import it.

export const PROTOCOL_VERSION = 1
export const DEFAULT_PORT = 8771
export const APP_VERSION = '3.0.0'

export type Role = 'participant' | 'admin'

/** Seats in the call. Exactly two participants and one (invisible) researcher. */
export type SlotId = 'P1' | 'P2' | 'ADMIN'

export type Phase = 'waiting' | 'live' | 'ended'

export interface Identity {
  /** Display name (participant first name, or RA name for the admin). */
  name: string
  participantId: string
  dyadId: string
  studyId: string
}

export const EMPTY_IDENTITY: Identity = {
  name: '',
  participantId: '',
  dyadId: '',
  studyId: '',
}

/** The full modification state applied to one participant's outgoing stream. */
export interface EffectState {
  /** Smile morph alpha. 1 = neutral, >1 lifts the smile, <1 dampens it. */
  alpha: number
  /** Voice pitch shift in semitones. 0 = neutral. */
  voiceSemitones: number
}

export const NEUTRAL_EFFECTS: EffectState = { alpha: 1, voiceSemitones: 0 }

// ---- Expression detection ----
//
// Detected from the participant's REAL face (the raw camera frame), never from
// the morphed output — so a rule like "when P1 smiles" reacts to what the
// participant actually did, not to what DuckSoup drew.
//
// The smile sub-types follow the lab's reward/affiliative/dominance framework
// (Martin et al. 2021, Affective Science; Rychlowska et al. 2021, Cognition &
// Emotion). The classifier is a heuristic on facial blendshapes — a starting
// point to calibrate against lab data, not a validated instrument.

export type SmileType = 'reward' | 'affiliative' | 'dominance'
export type ExpressionLabel = 'neutral' | 'smiling' | 'frowning'

export interface ExpressionState {
  label: ExpressionLabel
  /** Heuristic sub-type; only meaningful while `label` is 'smiling'. */
  smileType: SmileType | null
  /** Smoothed blendshape scores, 0..1. */
  smile: number
  frown: number
  asymmetry: number
  eyeConstriction: number
  lipPress: number
}

/** 1 Hz applied-state report from each participant machine (ground truth). */
export interface Telemetry extends EffectState {
  faceFound: boolean
  /** Render-loop frames per second of the morph pipeline. */
  fps: number
  cameraOn: boolean
  /** Latest detected real-face expression (also streamed at ~5 Hz separately). */
  expression?: ExpressionState | null
}

// ---- Automation rules (the no-code "if this, then that" builder) ----
//
// Rules are authored in the researcher dashboard, stored and evaluated on the
// session server, and can be edited at any moment — including mid-call. Two
// trigger kinds:
//   expression — "while P1 is smiling (held ≥ holdSec) → apply preset to P2",
//                with a configurable release behaviour when the expression stops
//   timer      — "at mm:ss into the conversation → apply preset", optionally
//                reverting after revertAfterSec seconds
// Rules only run while the session phase is 'live'.

export type PSlot = 'P1' | 'P2'

export type RuleExpression =
  | 'smiling'
  | 'reward-smile'
  | 'affiliative-smile'
  | 'dominance-smile'
  | 'frowning'

export type RuleTrigger =
  | { kind: 'expression'; slot: PSlot; expression: RuleExpression; holdSec: number }
  | { kind: 'timer'; atSec: number }

/** What happens when an expression rule's condition stops holding. */
export type RuleRelease = 'previous' | 'neutral' | 'none'

export interface AutomationRule {
  id: string
  enabled: boolean
  trigger: RuleTrigger
  action: { slot: PSlot; presetId: string }
  /** Expression rules: behaviour on release. Ignored for timer rules. */
  release: RuleRelease
  /** Timer rules: revert to the pre-rule state after N seconds (null = stay). */
  revertAfterSec: number | null
}

export interface SlotInfo {
  slot: SlotId
  clientId: string
  role: Role
  identity: Identity
  /** Camera + face model + voice graph are up. */
  ready: boolean
  connected: boolean
  telemetry?: Telemetry
  /** Last commanded effect state (server-tracked). */
  effects: EffectState
}

export interface RosterState {
  phase: Phase
  sessionStartedAt: string | null
  slots: Partial<Record<SlotId, SlotInfo>>
}

/**
 * WebRTC signaling payload. Structurally identical to
 * RTCSessionDescriptionInit / RTCIceCandidateInit but declared inline so this
 * module needs no DOM lib.
 */
export interface SignalData {
  description?: { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp?: string }
  candidate?: {
    candidate?: string
    sdpMid?: string | null
    sdpMLineIndex?: number | null
    usernameFragment?: string | null
  } | null
}

/** Maps the two MediaStream ids a participant sends to the researcher. */
export interface StreamMap {
  altered: string
  clean: string
}

// ---- Client → Server ----

export type ClientMessage =
  | { type: 'hello'; role: Role; identity: Identity; appVersion: string }
  | { type: 'signal'; to: SlotId; data: SignalData }
  | { type: 'ready'; camera: boolean; faceModel: boolean; voice: boolean }
  | { type: 'telemetry'; data: Telemetry }
  /** ~5 Hz real-face expression updates (sent only when the state changes). */
  | { type: 'expression'; data: ExpressionState }
  | { type: 'stream-map'; map: StreamMap }
  /** Generic client-side event for the log (blur/focus, escape dialog, rtc state…). */
  | {
      type: 'client-event'
      event: string
      target?: string
      param?: string
      value?: string | number | boolean
      detail?: unknown
    }
  // Admin-only commands (the server rejects them from participants):
  | { type: 'set-identity'; slot: SlotId; identity: Identity }
  | { type: 'set-effect'; slot: SlotId; param: keyof EffectState; value: number }
  | { type: 'apply-preset'; slot: SlotId; presetId: string; effects: EffectState }
  | { type: 'banner'; text: string; durationSec: number }
  | { type: 'set-phase'; phase: Phase }
  | { type: 'admin-mic'; live: boolean; mode: 'toggle' | 'hold' }
  /** Replace the full automation rule list (rules are editable mid-call). */
  | { type: 'set-rules'; rules: AutomationRule[] }

// ---- Server → Client ----

/** One row of the session event log, streamed live to the researcher. */
export interface LogRow {
  tsIso: string
  tRelMs: number
  seq: number
  actorRole: string
  actorSlot: string
  actorName: string
  event: string
  target: string
  param: string
  value: string
  detail: string
}

export type ServerMessage =
  | {
      type: 'welcome'
      clientId: string
      slot: SlotId
      phase: Phase
      roster: RosterState
      serverTime: string
    }
  | { type: 'roster'; roster: RosterState }
  | { type: 'signal'; from: SlotId; data: SignalData }
  | { type: 'effect-command'; effects: EffectState; cause: string }
  | { type: 'identity-assigned'; identity: Identity }
  | { type: 'banner'; text: string; durationSec: number }
  | { type: 'phase'; phase: Phase; sessionStartedAt: string | null }
  | { type: 'peer-left'; slot: SlotId }
  | { type: 'telemetry'; slot: SlotId; data: Telemetry }
  | { type: 'expression'; slot: SlotId; data: ExpressionState }
  | { type: 'stream-map'; slot: SlotId; map: StreamMap }
  | { type: 'log-row'; row: LogRow }
  /** Server echo of the current rule list (also sent to a reconnecting admin). */
  | { type: 'rules'; rules: AutomationRule[] }
  /** Which rules are currently holding/fired, for the dashboard indicator. */
  | { type: 'rule-status'; active: Record<string, boolean> }
  | { type: 'rejected'; reason: string }

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const m = JSON.parse(raw) as ClientMessage
    return typeof m === 'object' && m !== null && typeof m.type === 'string' ? m : null
  } catch {
    return null
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw) as ServerMessage
    return typeof m === 'object' && m !== null && typeof m.type === 'string' ? m : null
  } catch {
    return null
  }
}
