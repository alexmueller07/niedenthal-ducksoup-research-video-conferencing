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
export const APP_VERSION = '3.0.3'

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
  /** Smile morph alpha. 0 = neutral, >0 lifts the smile, <0 dampens it. */
  alpha: number
  /** Voice pitch shift in semitones. 0 = neutral. */
  voiceSemitones: number
}

export const NEUTRAL_EFFECTS: EffectState = { alpha: 0, voiceSemitones: 0 }

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
export type ClassifierMode = 'basic' | 'heuristic-subtype' | 'model-subtype'

export const SUBTYPE_RULE_CONFIDENCE_THRESHOLD = 0.7

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
  /** Mouth openness (teeth showing): upper-lip raise + jaw open + lower-lip drop. */
  openness: number
  /** Landmark-derived, scale-normalized geometry for auditing face-shape effects. */
  faceShape?: FaceShapeMetrics
  /**
   * Participant-relative expression values, 0..1, once the setup check has
   * been accepted. Raw blendshape values above remain unchanged for audit.
   */
  normalizedSmile?: number
  normalizedFrown?: number
  normalizedOpenness?: number
  smileMargin?: number
  frownMargin?: number
  normalizationApplied?: boolean
  normalizationVersion?: string
  /**
   * How far toward this person's own calibrated maximum their face is right
   * now, 0..1, measured from landmark geometry rather than blendshapes. This
   * is what caps the morph, so it has to be in the same units as the warp.
   * Clamps at 1 if they exceed what calibration measured.
   */
  geometricSmileLevel?: number
  geometricFrownLevel?: number
  /** True while the participant is speaking; frown labels are held back then. */
  talking?: boolean
  /** Confidence that the top-level label is correct, 0..1. */
  labelConfidence?: number
  /** Confidence that `smileType` is correct, 0..1. Omitted when no subtype is trusted. */
  smileTypeConfidence?: number
  /** True when `smileType` should be trusted. Undefined while not smiling (not applicable). */
  smileTypeTrusted?: boolean
  /** Which classifier produced this state. */
  classifierMode?: ClassifierMode
  /** Version string for audits and model/heuristic comparisons. */
  classifierVersion?: string

  // ---- Raw facial-movement scores (0..1), smoothed but not combined ----
  // These are MediaPipe's own facial-movement readings, NOT OpenFace/FACS
  // Action Units — the `smile`/`frown`/etc. fields above are built from these.
  rawMouthSmileLeft: number
  rawMouthSmileRight: number
  rawMouthFrownLeft: number
  rawMouthFrownRight: number
  rawLipPressLeft: number
  rawLipPressRight: number
  rawUpperLipRaiseLeft: number
  rawUpperLipRaiseRight: number
  rawJawOpen: number
  rawLowerLipDropLeft: number
  rawLowerLipDropRight: number
  rawEyeSquintLeft: number
  rawEyeSquintRight: number
  rawCheekSquintLeft: number
  rawCheekSquintRight: number
}

export interface FaceShapeMetrics {
  /** Mouth-corner distance divided by cheek-to-cheek face width. */
  mouthWidthToFaceWidth: number
  /** Inner-lip vertical opening divided by mouth-corner distance. */
  mouthOpenRatio: number
  /** Mouth-corner vertical mismatch divided by mouth width. */
  mouthCornerTilt: number
  /** Nose-to-cheek left/right symmetry; near 1 is frontal, near 0 is profile. */
  yawSymmetry: number
}

/** 1 Hz applied-state report from each participant machine (ground truth). */
export interface Telemetry extends EffectState {
  faceFound: boolean
  /** Render-loop frames per second of the morph pipeline. */
  fps: number
  cameraOn: boolean
  /** Session-only calibration/morph health for researcher monitoring. */
  calibration?: CalibrationRuntimeState
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

// ---- Calibration ----
//
// Each participant is calibrated before the conversation: a short guided
// sequence (relaxed face, biggest closed-mouth smile, biggest open-mouth
// smile, biggest frown) measures what THAT person's face actually does. Two
// different things come out of it:
//
//   detection — their own neutral..max range, so "smiling" means "well past
//               this person's resting noise", not past a global constant.
//   morphing  — the real mouth-corner displacement of their maximum
//               expression, so alpha 1.0 moves their mouth exactly that far
//               and never further.
//
// The closed-mouth smile sets the morph gain (the warp only moves corners, and
// an open grin's corner travel is partly jaw drop). The open-mouth smile sets
// the detection range and, together with the closed one, this person's
// jaw-to-corner coupling — which is what lets us subtract talking out of the
// live signal.

export type CalibrationPhase = 'neutral' | 'smileClosed' | 'smileOpen' | 'frown'
export const CALIBRATION_PHASES: CalibrationPhase[] = [
  'neutral',
  'smileClosed',
  'smileOpen',
  'frown',
]
export type CalibrationTarget = PSlot | 'both'
export type CalibrationPhaseStatus = 'ok' | 'needs-redo'
export type CalibrationQualityFlag =
  | 'insufficient_samples'
  | 'face_not_visible'
  | 'off_axis_face'
  | 'not_relaxed'
  | 'mouth_open_during_closed_smile'
  | 'too_close_to_neutral'

/** Mean and spread of one measured quantity over a calibration phase. */
export interface Stat {
  mean: number
  std: number
}

/**
 * Every MediaPipe blendshape the pipeline reads, keyed by its MediaPipe name.
 * Stored per phase so a researcher can see the ingredients, not just a score.
 */
export type BlendshapeStats = Record<string, Stat>

/** Combined scores derived from the blendshapes above. */
export interface ScoreStats {
  smile: Stat
  frown: Stat
  openness: Stat
  lipPress: Stat
  asymmetry: Stat
}

/**
 * Landmark geometry, scale-normalized by face width so it is invariant to how
 * far the participant sits from the camera. This is what the morph is measured
 * in — blendshape scores cannot drive a geometric warp.
 */
export interface GeometryStats {
  /** Mouth-corner horizontal spread ÷ face width. Grows with a smile. */
  cornerSpreadX: Stat
  /** Eye-line to mouth-corner height ÷ face width. Grows as corners rise. */
  cornerLiftY: Stat
  /** Lower-lip-centre drop below the mouth line ÷ face width. */
  lowerLipDropY: Stat
  /** Inner-lip vertical opening ÷ mouth width. */
  mouthOpenRatio: Stat
  /** Mouth width ÷ face width. */
  mouthWidthToFaceWidth: Stat
  /** Mouth-corner vertical mismatch ÷ mouth width. */
  mouthCornerTilt: Stat
  /** Nose-to-cheek left/right symmetry; near 1 is frontal, near 0 is profile. */
  yawSymmetry: Stat
}

/** The peak of an expression phase: the mean of the top N frames, not one frame. */
export interface CalibrationPeak {
  /** How many top frames were averaged. */
  topFrames: number
  /** Index of the single strongest frame (the one the screenshot shows). */
  peakFrameIndex: number
  peakTsMs: number
  blendshapes: BlendshapeStats
  scores: ScoreStats
  geometry: GeometryStats
}

export interface CalibrationPhaseSummary {
  phase: CalibrationPhase
  status: CalibrationPhaseStatus
  capturedAt: string
  durationMs: number
  frames: number
  faceVisibleRatio: number
  blendshapes: BlendshapeStats
  scores: ScoreStats
  geometry: GeometryStats
  /** Absent for the neutral phase, which has no peak. */
  peak?: CalibrationPeak
  qualityFlags: CalibrationQualityFlag[]
  /** Filename of this phase's screenshot inside the participant's folder. */
  screenshot?: string
}

/** One phase's result on its way from a participant to the researcher. */
export interface CalibrationPhaseMessage {
  requestId: string
  summary: CalibrationPhaseSummary
  /** The participant's negotiated camera resolution; only they know it. */
  camera?: { width: number; height: number }
  /** Peak-frame JPEG as a base64 data URL, for the dashboard thumbnail. */
  screenshotDataUrl?: string
}

/** Per-direction numbers the detector and the morph actually run on. */
export interface CalibrationDirection {
  /** Detection: peak score minus neutral score. The normalization denominator. */
  range: number
  /** Detection: normalized level below which this counts as neutral. */
  deadZone: number
  /** Morph: corner travel at this person's maximum, in mouth-widths. */
  cornerTravel: number
  /** Morph: direction the corners travel, radians above horizontal. */
  cornerAngleRad: number
}

export interface CalibrationProfile {
  schemaVersion: number
  version: string
  participantId: string
  dyadId: string
  studyId: string
  seat: PSlot | 'SOLO'
  appVersion: string
  capturedAt: string
  acceptedAt: string
  camera: { width: number; height: number }
  phases: Partial<Record<CalibrationPhase, CalibrationPhaseSummary>>
  derived: {
    smile: CalibrationDirection
    /** Frown also drops the centre of the lower lip; in mouth-widths. */
    frown: CalibrationDirection & { poutDrop: number }
    openness: { neutral: number; max: number }
    /** Corner travel per unit of mouth-open ratio; used to subtract jaw movement. */
    jawCoupling: number
    /** Mouth-open range the morph's open-mouth fade is scaled against. */
    openScaleRange: { neutralOpen: number; openSmileOpen: number }
    /** Resting spread of mouth opening; the talking detector's per-person baseline. */
    talking: { openRatioStdNeutral: number }
  }
  validation: {
    phases: Partial<Record<CalibrationPhase, CalibrationPhaseStatus>>
    flags: CalibrationQualityFlag[]
  }
}

/** Live calibration/morph health, reported in telemetry for the dashboard. */
export interface CalibrationRuntimeState {
  calibrated: boolean
  acceptedAt?: string
  participantId?: string
  /** How far toward their own maximum their real face is right now, 0..1. */
  liveLevel: number
  /** Headroom left for the morph after their real expression, 0..1. */
  headroom: number
  /** Alpha actually applied this frame, after the cap and the fades. */
  appliedAlpha: number
  talking: boolean
}

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
  | { type: 'calibration-start'; target: CalibrationTarget; phases: CalibrationPhase[] }
  | { type: 'calibration-phase'; message: CalibrationPhaseMessage }
  | { type: 'calibration-apply'; target: PSlot; profile: CalibrationProfile }
  | { type: 'calibration-clear'; target: PSlot }
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
  | { type: 'calibration-start'; requestId: string; phases: CalibrationPhase[] }
  | { type: 'calibration-phase'; slot: SlotId; message: CalibrationPhaseMessage }
  | { type: 'calibration-profile'; profile: CalibrationProfile | null }
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

export function normalizeExpressionState(input: unknown): ExpressionState | null {
  if (!isRecord(input)) return null
  const label = isExpressionLabel(input.label) ? input.label : null
  if (!label) return null

  const rawSmileType = isSmileType(input.smileType) ? input.smileType : null
  const smileType = label === 'smiling' ? rawSmileType : null
  const smileTypeConfidence =
    smileType && typeof input.smileTypeConfidence !== 'undefined'
      ? clamp01(input.smileTypeConfidence)
      : undefined
  // Trust the sub-type only while smiling, the client says to, and the type/
  // confidence it sent are actually consistent with that (De Morgan's inverse
  // of the old OR-based "uncertain" check).
  const smileTypeTrusted =
    label === 'smiling'
      ? input.smileTypeTrusted === true && smileType !== null && (smileTypeConfidence ?? 0) > 0
      : undefined

  return {
    label,
    smileType,
    smile: clamp01(input.smile),
    frown: clamp01(input.frown),
    asymmetry: clamp01(input.asymmetry),
    eyeConstriction: clamp01(input.eyeConstriction),
    lipPress: clamp01(input.lipPress),
    openness: clamp01(input.openness),
    faceShape: normalizeFaceShapeMetrics(input.faceShape),
    normalizedSmile:
      typeof input.normalizedSmile === 'undefined' ? undefined : clamp01(input.normalizedSmile),
    normalizedFrown:
      typeof input.normalizedFrown === 'undefined' ? undefined : clamp01(input.normalizedFrown),
    normalizedOpenness:
      typeof input.normalizedOpenness === 'undefined' ? undefined : clamp01(input.normalizedOpenness),
    smileMargin:
      typeof input.smileMargin === 'undefined' ? undefined : clampSigned(input.smileMargin),
    frownMargin:
      typeof input.frownMargin === 'undefined' ? undefined : clampSigned(input.frownMargin),
    normalizationApplied:
      typeof input.normalizationApplied === 'undefined'
        ? undefined
        : input.normalizationApplied === true,
    normalizationVersion:
      typeof input.normalizationVersion === 'string'
        ? input.normalizationVersion.replace(/[^\w.+-]/g, '').slice(0, 64)
        : undefined,
    labelConfidence:
      typeof input.labelConfidence === 'undefined' ? undefined : clamp01(input.labelConfidence),
    smileTypeConfidence,
    smileTypeTrusted,
    classifierMode: isClassifierMode(input.classifierMode) ? input.classifierMode : undefined,
    classifierVersion:
      typeof input.classifierVersion === 'string'
        ? input.classifierVersion.replace(/[^\w.+-]/g, '').slice(0, 64)
        : undefined,
    rawMouthSmileLeft: clamp01(input.rawMouthSmileLeft),
    rawMouthSmileRight: clamp01(input.rawMouthSmileRight),
    rawMouthFrownLeft: clamp01(input.rawMouthFrownLeft),
    rawMouthFrownRight: clamp01(input.rawMouthFrownRight),
    rawLipPressLeft: clamp01(input.rawLipPressLeft),
    rawLipPressRight: clamp01(input.rawLipPressRight),
    rawUpperLipRaiseLeft: clamp01(input.rawUpperLipRaiseLeft),
    rawUpperLipRaiseRight: clamp01(input.rawUpperLipRaiseRight),
    rawJawOpen: clamp01(input.rawJawOpen),
    rawLowerLipDropLeft: clamp01(input.rawLowerLipDropLeft),
    rawLowerLipDropRight: clamp01(input.rawLowerLipDropRight),
    rawEyeSquintLeft: clamp01(input.rawEyeSquintLeft),
    rawEyeSquintRight: clamp01(input.rawEyeSquintRight),
    rawCheekSquintLeft: clamp01(input.rawCheekSquintLeft),
    rawCheekSquintRight: clamp01(input.rawCheekSquintRight),
  }
}

export function normalizeTelemetry(input: Telemetry): Telemetry {
  return {
    ...input,
    expression:
      typeof input.expression === 'undefined' || input.expression === null
        ? input.expression
        : normalizeExpressionState(input.expression),
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isExpressionLabel(v: unknown): v is ExpressionLabel {
  return v === 'neutral' || v === 'smiling' || v === 'frowning'
}

function isSmileType(v: unknown): v is SmileType {
  return v === 'reward' || v === 'affiliative' || v === 'dominance'
}

function isClassifierMode(v: unknown): v is ClassifierMode {
  return v === 'basic' || v === 'heuristic-subtype' || v === 'model-subtype'
}

function normalizeFaceShapeMetrics(input: unknown): FaceShapeMetrics | undefined {
  if (!isRecord(input)) return undefined
  return {
    mouthWidthToFaceWidth: clamp01(input.mouthWidthToFaceWidth),
    mouthOpenRatio: clamp01(input.mouthOpenRatio),
    mouthCornerTilt: clamp01(input.mouthCornerTilt),
    yawSymmetry: clamp01(input.yawSymmetry),
  }
}

function clamp01(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100))
}

function clampSigned(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0
  return Math.min(1, Math.max(-1, Math.round(n * 100) / 100))
}
