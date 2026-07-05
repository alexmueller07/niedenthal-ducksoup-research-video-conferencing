// Shared types for the DuckSoup experimenter platform.
//
// The app is a single self-contained capture page: it owns the camera, runs the
// facial morph + voice shift, records the clean and altered streams, and writes
// the structured session output that downstream questionnaire apps consume.

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error'

export type RecordingStatus = 'idle' | 'recording' | 'saving'

/**
 * A named emotion-modification condition. These are the experiment's independent
 * variable, so they are first-class and labelled, never just a raw slider value.
 * Defined in main/presets.ts (shared with the session server's rule engine).
 */
import type { ModificationPreset } from '../../main/presets'
export type { ModificationPreset }

/** Everything the experimenter sets before a capture station goes live. */
export interface SessionConfig {
  studyId: string
  dyadId: string
  participantId: string
  partnerId: string
  raName: string
  presetId: string
  /** Absolute path to the root folder where session folders are created (Electron). */
  saveRoot: string | null
}

/** A file produced during a session. */
export interface RecordingFile {
  kind: 'altered' | 'clean'
  filename: string
  path: string
  bytes: number
}

/**
 * The manifest written alongside the videos. This is the contract the PPS
 * questionnaire app reads to locate and label a participant's videos.
 */
export interface SessionManifest {
  schemaVersion: 1
  app: string
  appVersion: string
  createdAt: string
  config: SessionConfig
  preset: ModificationPreset
  /** Final params actually used (preset may be live-adjusted). */
  appliedParams: { alpha: number; voiceSemitones: number; overlay: boolean }
  startedAt: string | null
  stoppedAt: string | null
  durationSec: number
  files: RecordingFile[]
}
