// SessionLogger: the session's permanent record.
//
// Creates one session folder per server run and appends to two CSVs:
//   events.csv        — every discrete thing that happens (sign-ins, effect
//                       commands, banners, mic changes, escapes, disconnects…)
//   effect_state.csv  — 1 Hz applied-state telemetry from each participant
//                       machine (the ground truth of what was actually shown)
// plus session.json, a manifest tying IDs, times, and produced files together.
//
// Appends use a write stream (flags 'a') so rows hit disk as they happen — a
// crash mid-session loses at most the OS buffer, never the whole log.

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
  phase: string
  alpha: number
  voiceSemitones: number
  faceFound: boolean
  fps: number
  cameraOn: boolean
  /** Detected real-face expression at this telemetry tick (may be blank). */
  expressionLabel?: string
  smileType?: string
}

const EVENT_HEADER =
  'ts_iso,t_rel_ms,seq,actor_role,actor_slot,actor_name,event,target,param,value,detail\n'
const STATE_HEADER =
  'ts_iso,t_rel_ms,slot,participant_id,phase,alpha,voice_semitones,face_found,fps,camera_on,expression,smile_type\n'

function csvField(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v)
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function sanitize(part: string): string {
  return String(part).replace(/[^A-Za-z0-9_-]/g, '_') || 'x'
}

export class SessionLogger {
  readonly dir: string
  readonly eventsPath: string
  readonly statePath: string
  readonly startedAtIso: string
  private readonly startedAtMs: number
  private events: fs.WriteStream
  private state: fs.WriteStream
  private seq = 0
  private closed = false

  private constructor(dir: string) {
    this.dir = dir
    this.eventsPath = path.join(dir, 'events.csv')
    this.statePath = path.join(dir, 'effect_state.csv')
    this.startedAtMs = Date.now()
    this.startedAtIso = new Date(this.startedAtMs).toISOString()
    this.events = fs.createWriteStream(this.eventsPath, { flags: 'a' })
    this.state = fs.createWriteStream(this.statePath, { flags: 'a' })
    this.events.write(EVENT_HEADER)
    this.state.write(STATE_HEADER)
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
          row.tsIso,
          row.tRelMs,
          row.seq,
          csvField(row.actorRole),
          csvField(row.actorSlot),
          csvField(row.actorName),
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

  effectState(input: EffectStateInput): void {
    if (this.closed) return
    const now = Date.now()
    this.state.write(
      [
        new Date(now).toISOString(),
        now - this.startedAtMs,
        csvField(input.slot),
        csvField(input.participantId),
        csvField(input.phase),
        input.alpha,
        input.voiceSemitones,
        input.faceFound,
        Math.round(input.fps * 10) / 10,
        input.cameraOn,
        csvField(input.expressionLabel ?? ''),
        csvField(input.smileType ?? ''),
      ].join(',') + '\n',
    )
  }

  async writeManifest(manifest: unknown): Promise<string> {
    const p = path.join(this.dir, 'session.json')
    await fsp.writeFile(p, JSON.stringify(manifest, null, 2), 'utf-8')
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
    await Promise.all([
      new Promise<void>((r) => this.events.end(() => r())),
      new Promise<void>((r) => this.state.end(() => r())),
    ])
  }
}
