// SessionLogger: the session's permanent record.
//
// Creates one session folder per server run and writes:
//   events.csv              — every discrete thing that happens (sign-ins, effect
//                              commands, banners, mic changes, escapes, disconnects…)
//   effect_state_<seat>.csv — one file per participant seat (P1, P2), 1 Hz
//                              applied-state telemetry (the ground truth of what
//                              was actually shown to and by that person)
//   recordings.csv          — one row per saved recording (clean/altered video
//                              per participant, researcher mic), with its start/
//                              stop time so it can be lined up with the other files
// plus session.json, a manifest tying IDs, times, and produced files together.
//
// Appends use a write stream (flags 'a') so rows hit disk as they happen — a
// crash mid-session loses at most the OS buffer, never the whole log.
//
// Columns are grouped the same way in every file — who/when, then what
// happened, then data-quality detail last — and headers are plain English
// (e.g. "time" not "ts_iso") so the files are readable without a data
// dictionary. "time" is your computer's own local clock, written out as
// e.g. "Aug 18, 2026 3:46:51.175 PM", not a UTC/ISO timestamp.

import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'

export interface EventInput {
  actorRole?: string
  actorSlot?: string
  actorName?: string
  event: string
  target?: string
  param?: string
  value?: string | number | boolean
  detail?: unknown
}

export interface LoggedEvent {
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

export interface EffectStateInput {
  slot: string
  participantId: string
  /** The pair (dyad) this participant belongs to. */
  dyadId?: string
  /** The other participant in the same pair, if known. */
  partnerId?: string
  phase: string
  /** How much this participant's own face was changed (1 = no change). */
  selfAlpha: number
  /** How much this participant's own voice pitch was changed. */
  selfVoiceSemitones: number
  /** How much the partner's face was changed, at this same moment. Blank if the partner isn't connected yet. */
  partnerAlpha?: number | null
  /** How much the partner's voice pitch was changed, at this same moment. */
  partnerVoiceSemitones?: number | null
  faceFound: boolean
  fps: number
  cameraOn: boolean
  /** Detected real-face expression at this telemetry tick (may be blank). */
  expressionLabel?: string
  smileType?: string
  labelConfidence?: number
  smileTypeConfidence?: number
  uncertain?: boolean
  classifierMode?: string
  classifierVersion?: string
}

export interface RecordingStartInput {
  slot: string
  participantId: string
  /** 'clean' | 'altered' | 'mic' */
  kind: string
  label: string
  path: string
}

export interface RecordingStopInput {
  label: string
  durationSec?: number
  bytes?: number
}

const EVENT_HEADER = 'seat,name,role,time,elapsed_ms,event,target,parameter,value,details\n'
const STATE_HEADER =
  'pair_id,participant_id,partner_id,seat,time,elapsed_ms,phase,self_face_change,self_voice_change,partner_face_change,partner_voice_change,expression,smile_type,expression_confidence,smile_type_confidence,uncertain,face_detected,camera_on,frames_per_second\n'
const RECORDINGS_HEADER =
  'seat,participant_id,type,started_at,stopped_at,elapsed_start_ms,elapsed_stop_ms,duration_sec,file_path,file_size_mb\n'

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

/** Your computer's own local time, e.g. "Aug 18, 2026 3:46:51.175 PM". Not UTC. */
function formatLocalTime(epochMs: number): string {
  const d = new Date(epochMs)
  const month = MONTHS[d.getMonth()]
  const day = d.getDate()
  const year = d.getFullYear()
  let hours = d.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  const millis = String(d.getMilliseconds()).padStart(3, '0')
  return `${month} ${day}, ${year} ${hours}:${minutes}:${seconds}.${millis} ${ampm}`
}

function csvField(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function sanitize(part: string): string {
  return String(part).replace(/[^A-Za-z0-9_-]/g, '_') || 'x'
}

interface PendingRecording {
  startedAtMs: number
  startedElapsedMs: number
  slot: string
  participantId: string
  kind: string
  label: string
  path: string
}

export class SessionLogger {
  readonly dir: string
  readonly eventsPath: string
  readonly startedAtIso: string
  private readonly startedAtMs: number
  private events: fs.WriteStream
  private recordings: fs.WriteStream
  private stateStreams = new Map<string, fs.WriteStream>()
  private pendingRecordings = new Map<string, PendingRecording>()
  /** Which expression-detection build produced each seat's readings — captured once, written into the manifest. */
  private detectorInfo = new Map<string, { classifierMode?: string; classifierVersion?: string }>()
  private seq = 0
  private closed = false

  private constructor(dir: string) {
    this.dir = dir
    this.eventsPath = path.join(dir, 'events.csv')
    this.startedAtMs = Date.now()
    this.startedAtIso = new Date(this.startedAtMs).toISOString()
    this.events = fs.createWriteStream(this.eventsPath, { flags: 'a' })
    this.events.write(EVENT_HEADER)
    this.recordings = fs.createWriteStream(path.join(dir, 'recordings.csv'), { flags: 'a' })
    this.recordings.write(RECORDINGS_HEADER)
  }

  static async create(outputRoot: string): Promise<SessionLogger> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = path.join(outputRoot, `session_${stamp}`)
    await fsp.mkdir(path.join(dir, 'recordings'), { recursive: true })
    return new SessionLogger(dir)
  }

  get recordingsDir(): string {
    return path.join(this.dir, 'recordings')
  }

  /** Append one event row. Returns the row so it can be streamed to the admin UI. */
  event(input: EventInput): LoggedEvent {
    const now = Date.now()
    const row: LoggedEvent = {
      tsIso: new Date(now).toISOString(),
      tRelMs: now - this.startedAtMs,
      seq: this.seq++,
      actorRole: input.actorRole ?? 'server',
      actorSlot: input.actorSlot ?? '',
      actorName: input.actorName ?? '',
      event: input.event,
      target: input.target ?? '',
      param: input.param ?? '',
      value: input.value === undefined ? '' : String(input.value),
      detail: input.detail === undefined ? '' : JSON.stringify(input.detail),
    }
    if (!this.closed) {
      this.events.write(
        [
          csvField(row.actorSlot),
          csvField(row.actorName),
          csvField(row.actorRole),
          csvField(formatLocalTime(now)),
          row.tRelMs,
          csvField(row.event),
          csvField(row.target),
          csvField(row.param),
          csvField(row.value),
          csvField(row.detail),
        ].join(',') + '\n',
      )
    }
    return row
  }

  private stateStreamFor(slot: string): fs.WriteStream {
    const key = sanitize(slot)
    let s = this.stateStreams.get(key)
    if (!s) {
      s = fs.createWriteStream(path.join(this.dir, `effect_state_${key}.csv`), { flags: 'a' })
      s.write(STATE_HEADER)
      this.stateStreams.set(key, s)
    }
    return s
  }

  effectState(input: EffectStateInput): void {
    if (this.closed) return
    const now = Date.now()

    // classifier mode/version never change mid-session — captured once here
    // instead of repeating it on every single row; written into session.json.
    if (!this.detectorInfo.has(input.slot) && (input.classifierMode || input.classifierVersion)) {
      this.detectorInfo.set(input.slot, {
        classifierMode: input.classifierMode,
        classifierVersion: input.classifierVersion,
      })
    }

    this.stateStreamFor(input.slot).write(
      [
        csvField(input.dyadId ?? ''),
        csvField(input.participantId),
        csvField(input.partnerId ?? ''),
        csvField(input.slot),
        csvField(formatLocalTime(now)),
        now - this.startedAtMs,
        csvField(input.phase),
        input.selfAlpha,
        input.selfVoiceSemitones,
        input.partnerAlpha ?? '',
        input.partnerVoiceSemitones ?? '',
        csvField(input.expressionLabel ?? ''),
        csvField(input.smileType ?? ''),
        csvField(input.labelConfidence ?? ''),
        csvField(input.smileTypeConfidence ?? ''),
        csvField(input.uncertain ?? ''),
        input.faceFound,
        input.cameraOn,
        Math.round(input.fps * 10) / 10,
      ].join(',') + '\n',
    )
  }

  /** Remembers a recording's start; the row itself is written once it stops. */
  recordingStarted(input: RecordingStartInput): void {
    const now = Date.now()
    this.pendingRecordings.set(input.label, {
      startedAtMs: now,
      startedElapsedMs: now - this.startedAtMs,
      slot: input.slot,
      participantId: input.participantId,
      kind: input.kind,
      label: input.label,
      path: input.path,
    })
  }

  recordingStopped(input: RecordingStopInput): void {
    if (this.closed) return
    const pending = this.pendingRecordings.get(input.label)
    if (!pending) return
    this.pendingRecordings.delete(input.label)
    const now = Date.now()
    const stoppedElapsedMs = now - this.startedAtMs
    const durationMs =
      input.durationSec !== undefined
        ? Math.round(input.durationSec * 1000)
        : stoppedElapsedMs - pending.startedElapsedMs
    const sizeMb = input.bytes !== undefined ? Math.round((input.bytes / (1024 * 1024)) * 10) / 10 : ''
    this.recordings.write(
      [
        csvField(pending.slot),
        csvField(pending.participantId),
        csvField(pending.kind),
        csvField(formatLocalTime(pending.startedAtMs)),
        csvField(formatLocalTime(now)),
        pending.startedElapsedMs,
        stoppedElapsedMs,
        Math.round(durationMs / 100) / 10,
        csvField(pending.path),
        sizeMb,
      ].join(',') + '\n',
    )
  }

  async writeManifest(manifest: unknown): Promise<string> {
    const p = path.join(this.dir, 'session.json')
    const withDetection = {
      ...(manifest as Record<string, unknown>),
      detection: Object.fromEntries(this.detectorInfo),
    }
    await fsp.writeFile(p, JSON.stringify(withDetection, null, 2), 'utf-8')
    return p
  }

  /** Safe filename for a recording, namespaced under recordings/. */
  recordingPath(label: string, ext = 'webm'): string {
    const safeExt = /^[a-z0-9]{1,5}$/i.test(ext) ? ext : 'webm'
    return path.join(this.recordingsDir, `${sanitize(label)}.${safeExt}`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const ends: Promise<void>[] = [
      new Promise<void>((r) => this.events.end(() => r())),
      new Promise<void>((r) => this.recordings.end(() => r())),
    ]
    for (const s of this.stateStreams.values()) {
      ends.push(new Promise<void>((r) => s.end(() => r())))
    }
    await Promise.all(ends)
  }
}
