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

/** 1 Hz applied-state report from each participant machine (ground truth). */
export interface Telemetry extends EffectState {
  faceFound: boolean
  /** Render-loop frames per second of the morph pipeline. */
  fps: number
  cameraOn: boolean
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
  | { type: 'stream-map'; slot: SlotId; map: StreamMap }
  | { type: 'log-row'; row: LogRow }
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
