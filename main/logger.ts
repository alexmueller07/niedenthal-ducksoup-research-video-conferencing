// SessionLogger: the session's permanent record.
//
// Creates one session folder per server run (named by the local start time)
// and writes, grouped into folders by kind of data:
//   events.csv                        — every discrete thing that happens
//   session_summary.json              — written on End: IDs, times, files
//   videos/                           — the recordings, plus recordings.csv
//                                        (one row per file, with start/stop)
//   face/face_and_voice_changes_<seat>.csv
//                                     — 1 Hz applied-state telemetry per seat
//                                        (the ground truth of what was shown)
//   voice/                            — written by VoiceLogger
//   calibration/<participant_id>/     — accepted calibration and photos
//   review/answers.csv, settings.txt  — the post-call review, if run
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
import { VoiceLogger, modeName } from './voiceLogger'
import { formatLocalDate, formatLocalTimeOfDay } from './timeFormat'
import type { VoiceReport } from './voiceProtocol'
import type { ReviewResponseRecord } from './review'
import type { ReviewConfig, ReviewViewMode } from './protocol'

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
  voice?: VoiceReport
  slot: string
  participantId: string
  /** The pair (dyad) this participant belongs to. */
  dyadId?: string
  /** The other participant in the same pair, if known. */
  partnerId?: string
  phase: string
  /** Epoch ms the researcher started the live conversation, or null/undefined if not live yet. */
  liveStartedAtMs?: number | null
  /** How much this participant's own face was changed (0 = no change). */
  selfAlpha: number
  /** How much this participant's own voice pitch was changed. */
  selfVoiceSemitones: number
  /** How much this participant's own voice was made to sound smiling. */
  selfVoiceSmile: number
  /** How much the partner's face was changed, at this same moment. Blank if the partner isn't connected yet. */
  partnerAlpha?: number | null
  /** How much the partner's voice pitch was changed, at this same moment. */
  partnerVoiceSemitones?: number | null
  /** How much the partner's voice was made to sound smiling, at this same moment. */
  partnerVoiceSmile?: number | null
  faceFound: boolean
  fps: number
  cameraOn: boolean
  /** Detected real-face expression at this telemetry tick (may be blank). */
  expressionLabel?: string
  smileType?: string
  labelConfidence?: number
  smileTypeConfidence?: number
  smileTypeTrusted?: boolean
  normalizedSmile?: number
  normalizedFrown?: number
  normalizedOpenness?: number
  smileMargin?: number
  frownMargin?: number
  normalizationApplied?: boolean
  normalizationVersion?: string
  classifierMode?: string
  classifierVersion?: string
  calibrated?: boolean
  /** What the researcher asked for, before the per-person cap. */
  commandedAlpha?: number
  /** What was actually applied after the cap and the fades — the number to analyse. */
  appliedAlpha?: number
  /** How far their real face was toward their own maximum, 0..1. */
  liveLevel?: number
  /** Morph budget left after their real expression took its share, 0..1. */
  headroom?: number
  talking?: boolean
  /** Raw MediaPipe facial-movement scores (0..1) behind the expression label — not OpenFace/FACS AUs. */
  rawMouthSmileLeft?: number
  rawMouthSmileRight?: number
  rawMouthFrownLeft?: number
  rawMouthFrownRight?: number
  rawLipPressLeft?: number
  rawLipPressRight?: number
  rawUpperLipRaiseLeft?: number
  rawUpperLipRaiseRight?: number
  rawJawOpen?: number
  rawLowerLipDropLeft?: number
  rawLowerLipDropRight?: number
  rawEyeSquintLeft?: number
  rawEyeSquintRight?: number
  rawCheekSquintLeft?: number
  rawCheekSquintRight?: number
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

const EVENT_HEADER = 'seat,name,role,date,time,elapsed_ms,event,target,parameter,value,details\n'
const STATE_HEADER =
  'pair_id,participant_id,partner_id,seat,date,time,elapsed_ms,conversation_elapsed_ms,phase,self_face_change,self_voice_change,partner_face_change,partner_voice_change,expression,smile_type,expression_confidence,smile_type_confidence,smile_type_trusted,normalized_smile,normalized_frown,normalized_openness,smile_margin,frown_margin,normalization_applied,normalization_version,calibrated,commanded_alpha,applied_alpha,live_level,headroom,talking,raw_mouth_smile_left,raw_mouth_smile_right,raw_mouth_frown_left,raw_mouth_frown_right,raw_lip_press_left,raw_lip_press_right,raw_upper_lip_raise_left,raw_upper_lip_raise_right,raw_jaw_open,raw_lower_lip_drop_left,raw_lower_lip_drop_right,raw_eye_squint_left,raw_eye_squint_right,raw_cheek_squint_left,raw_cheek_squint_right,face_detected,camera_on,frames_per_second\n'
const RECORDINGS_HEADER =
  'seat,participant_id,type,started_date,started_time,stopped_date,stopped_time,elapsed_start_ms,elapsed_stop_ms,duration_sec,file_path,file_size_mb\n'

const REVIEW_ANSWERS_HEADER =
  'pair_id,turn,clip_from,clip_to,whose_video,written_by,question,answer,how_saved,date,time,view,seconds_on_original_video,switches_between_videos\n'

const QUESTION_TEXT: Record<ReviewResponseRecord['responseType'], string> = {
  self_report: 'their own feelings',
  perceived: "their partner's feelings",
}
const HOW_SAVED_TEXT: Record<ReviewResponseRecord['submittedBy'], string> = {
  participant: 'pressed Done',
  researcher_forced: 'researcher moved on',
  auto: 'moved on automatically',
  review_ended: 'review ended early',
}
const VIEW_TEXT: Record<ReviewViewMode, string> = {
  active: 'active speaker',
  single: 'single',
  gallery: 'gallery',
}

export interface ReviewSettingsInput {
  config: ReviewConfig
  conversationMs: number
  turns: number
  /** e.g. "Ana (P1)" */
  firstPerson: string
}


const README_CONTENT = `This session folder
====================

README.txt               This file.
events.csv               Everything that happened during the session, one
                          row per event (someone joined, a setting changed,
                          a message was sent, a connection dropped, etc.).
session_summary.json     Written when the session ends: who was in it and
                          which recordings were made.

videos/
  P1_<id>_altered.mp4    Each participant as their partner saw them
  P1_<id>_clean.mp4      (altered) and their real camera (clean). "P1"/"P2"
  P2_<id>_altered.mp4    is the seat, <id> the participant ID. A restarted
  P2_<id>_clean.mp4      or reconnected call adds _part2, _part3 files.
  researcher_mic.mp4     The researcher's microphone.
  recordings.csv         One row per file above, with when it started and
                          stopped.

face/
  face_and_voice_changes_P1.csv   Once per second, for each participant:
  face_and_voice_changes_P2.csv   how much their face and voice were being
                                   changed, and what their real face was
                                   doing (smiling, frowning, ...).

voice/
  voice_measurements_P1.csv   Voice measurements for each participant,
  voice_measurements_P2.csv   several times a second.
  speaking_turns.csv          One row each time someone spoke.

calibration/<id>/        Only if a participant was calibrated: their
                          measurements and a photo of each expression.

review/                  Only if the post-call review was run (review_2/
                          and so on if it was run again):
  answers.csv            Everything each person wrote, one row per answer.
  settings.txt           The review settings that were used.

Times
-----
"date" and "time" (and started_date/started_time, stopped_date/stopped_time)
are your computer's own local clock, e.g. "Aug 18, 2026" and
"3:46:51.175 PM" — not UTC.

"elapsed_ms" is milliseconds since the whole session began (including any
time spent in the waiting room before the conversation started).

"conversation_elapsed_ms" (face_and_voice_changes files) is milliseconds since
the researcher actually started the live conversation — blank while still
in the waiting room, ~0 the moment the conversation starts. Recordings also
start at that same moment, so this number is effectively the timestamp
inside the recorded video: to find when something happened in the video,
look up its conversation_elapsed_ms directly instead of subtracting times.

Post-call review (review/answers.csv)
-------------------------------------
After the conversation, both participants rewatched it together in turns:
Participant 1's video for the first part, then Participant 2's video for
the same part, then Participant 1's next part, and so on. In each turn
both people wrote at the same time.

turn: 1, 2, 3, ... in the order they were watched.
clip_from / clip_to: which part of the conversation the turn showed, as
minutes:seconds. This is the same as the time inside the videos.
whose_video: whose video the turn showed (participant ID).
written_by: who wrote this answer (participant ID).
question: "their own feelings" when someone wrote about their own video,
"their partner's feelings" when they wrote about their partner's.
answer: exactly what they typed. An answer starting with = + - or @ has an
apostrophe (') added in front, so spreadsheet programs show it as text.
how_saved: "pressed Done", or if they hadn't yet: "researcher moved on",
"moved on automatically", or "review ended early". In those cases whatever
they had typed so far is what was saved.
date / time: when the answer was saved.
view: what they were looking at: active speaker (only the person whose
turn it was), single (their partner), or gallery (everyone).
seconds_on_original_video / switches_between_videos: only filled in when
participants were allowed to see the original (unchanged) video: how long
it was on their screen, and how many times they switched between the
changed and original video.

Face and voice change numbers
------------------------------
self_face_change / partner_face_change: 0 = normal (no change). Higher than
0 = more smiling. Lower than 0 = more frowning.
self_voice_change / partner_voice_change: 0 = normal (no change). Positive
= pitched up. Negative = pitched down.
self_voice_smile / partner_voice_smile: 0 = normal (no change). 1 = full
smiling voice (vocal resonances raised, pitch unchanged). Negative = darker.
"self" is this file's own participant; "partner" is what was being done to
the other participant, at that same moment.

Voice columns (voice/voice_measurements_P1.csv, _P2.csv)
---------------------------------------------------------
Several rows a second per participant. Laid out like the face file: who and
when, then the main readings, the changes applied, how in sync the pair
was, the raw measurements, and quality checks last.

speaking: true while they were talking.
pitch_hz: how high their voice was (typical speaking voices are roughly
80-250). loudness_db: how loud their microphone signal was; 0 is the
loudest possible, so numbers are negative and closer to 0 is louder. This
is the recording level, not how loud they were in the room.
relative_pitch / relative_loudness: the same, on their OWN scale (0 = their
usual voice; positive = higher or louder than usual). pitch_range /
loudness_range: how much their voice was varying over the last few seconds.
partner_heard_pitch_hz / partner_heard_loudness_db: what their partner
actually heard, after any change.
voice_baseline: whether enough of their natural speech had been heard to
know their usual voice (collecting, usable, strong). Own-scale values are
blank until then.

voice_condition: the voice setting in use (natural = no change, or
audibility, match, detone). voice_change_active: whether a change was
actually being applied at that moment. pitch_change (semitones) and
volume_change (decibels): 0 = no change. pitch_range_change /
loudness_range_change: 1 = no change, above 1 = more varied, below 1 =
flatter. fell_back_to_natural_because: if filled in, the app sent their
natural voice instead, for the reason given.

pitch_sync / loudness_sync / turn_taking_sync / convergence / overall_sync:
how closely the two people's voices tracked each other, from -1 to 1.
These are exploratory measures of the sound only, not validated measures of
rapport or emotion. paired_turns: how many back-and-forth turns they are
based on.

raw_clean_* / raw_altered_*: every individual measurement, before ("clean")
and after ("altered") any change, kept for later analysis.

noise_floor_db / signal_to_noise_db / clipping_rate / voice_processor:
recording quality. A high noise floor, low signal-to-noise or clipping
above 0 means the measurements may be unreliable.

voice/speaking_turns.csv has one row each time someone spoke: how long,
how high and loud their voice was on average, the same on their own scale,
how quickly they started after their partner (gap_after_partner_ms) and
how much they talked over them (overlap_with_partner_ms). usable is false
for turns too short or unclear to measure.

Facial expression columns
--------------------------
expression / smile_type / expression_confidence / smile_type_confidence:
the app's overall read of the participant's real (unmodified) face —
neutral/smiling/frowning, and if smiling, which kind (reward, affiliative,
or dominance), each with a confidence score from 0 to 1.

smile_type_trusted: true if the smile_type reading above should be trusted,
false if it's a low-confidence guess, blank if the person isn't smiling
(smile_type doesn't apply).

normalized_smile / normalized_frown / normalized_openness /
smile_margin / frown_margin: this participant's raw expression readings
placed on their OWN scale, where 0 is their relaxed face and 1 is the
biggest expression they made during calibration. Blank if this participant
wasn't calibrated that session (normalization_applied will be false/blank
in that case). normalization_version identifies which formula produced
these values.

talking: true while the participant was speaking. Frowns are deliberately
not reported during speech — ordinary talking makes the same mouth shapes
the frown reading keys on, so a frown logged mid-sentence would usually be
a false alarm. Smiles are still reported while talking.

How much modification was really applied
------------------------------------------
commanded_alpha is what the researcher asked for. applied_alpha is what was
actually put on the participant's face, and it is the number to analyse.
The two differ because the cap is on the TOTAL: a participant's own
expression plus the modification is never allowed to go past the biggest
expression they made during calibration.

live_level is how far their real face was toward their own maximum at that
moment (0 to 1), and headroom is what was left over for the modification
(1 minus live_level). So a participant who is already grinning receives
less added smile than the same preset would give them at rest — by design.
applied_alpha is also reduced while the mouth is open, where this kind of
mouth-corner reshaping looks least convincing.

calibrated: true if this participant had been calibrated by this point in
the session. When false, the modification falls back to one fixed amount
for everybody, which is the old behaviour.

Where calibration itself is recorded
------------------------------------------
Before the conversation, each participant is guided through four short
takes: relax your face (3s), biggest smile with lips together (4s),
biggest smile showing teeth (4s), and biggest frown (4s). Two different
things come out of it — the range their expressions are judged against, and
how far their mouth corners actually move, which is what the modification
is scaled to.

Each take is written to events.csv as its own row (event
calibration_step_completed or calibration_retake_recommended, with the
numbers in the "details" column as JSON). When the researcher accepts the
result, a calibration_applied row logs the final profile, and the full
measurements plus a photo of each take are saved to:

  calibration/<participant_id>/calibration.json
  calibration/<participant_id>/neutral.jpg
  calibration/<participant_id>/max_smile_closed.jpg
  calibration/<participant_id>/max_smile_open.jpg
  calibration/<participant_id>/max_frown.jpg

Those files hold every individual facial-movement reading for each take
(average and spread), so the numbers the modification was scaled against
travel with the session they were used in.

raw_* columns: the individual facial-movement readings the app actually
measures (0 to 1 each) — the "ingredients" that expression/smile_type/etc.
are built from. These come from this app's face-tracking software
(MediaPipe); they are NOT OpenFace or FACS-coded Action Units, so please
don't cite them as such. Roughly: the app calls someone "smiling" once
their mouth-corner-raise reading rises clearly above their own relaxed
face (or above about 0.6 if they weren't calibrated), and once smiling,
"reward" means the mouth is opening (teeth showing), "dominance"
means the two sides of the face disagree with each other, and
"affiliative" is a strong, even, closed-mouth smile that's neither of
those. See docs/for-technical-users.md section 4 in the project's GitHub
repo for the exact thresholds and formulas.

frames_per_second: how smoothly this participant's video was updating,
averaged over the last second. Can legitimately read low for about the
first second right after the pipeline starts up (the one-second average
hasn't filled up yet) — that's expected, not a fault.
`

/** A position in the conversation as m:ss, e.g. 2:30. */
function minSec(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Folder-name timestamp on your computer's own clock, e.g. 2026-10-18_17-33-05. */
function localStamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}-${two(d.getMinutes())}-${two(d.getSeconds())}`
}

/**
 * Free text typed by participants: a leading = + - @ would make Excel or
 * Sheets read the cell as a formula (even an answer like "- a bit tense"),
 * so such text gets a leading apostrophe. Explained in README.txt.
 */
function spreadsheetSafe(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
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

/** Strip anything that is not safe in a folder name (participant IDs are free text). */
function sanitizeName(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return cleaned || 'unknown'
}

/** Decode a `data:image/jpeg;base64,…` URL. Returns null if it is not one. */
function decodeDataUrl(dataUrl: string): Buffer | null {
  const match = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl)
  if (!match) return null
  try {
    return Buffer.from(match[1], 'base64')
  } catch {
    return null
  }
}

export class SessionLogger {
  readonly voice: VoiceLogger
  readonly dir: string
  readonly eventsPath: string
  readonly startedAtIso: string
  private readonly startedAtMs: number
  private events: fs.WriteStream
  private recordings: fs.WriteStream
  private stateStreams = new Map<string, fs.WriteStream>()
  /** review/ (then review_2/, … if the researcher runs it again), created when a review starts. */
  private reviewDir: string | null = null
  private reviewCount = 0
  private answers: fs.WriteStream | null = null
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
    this.voice = new VoiceLogger(path.join(dir, 'voice'), this.startedAtMs)
    this.events = fs.createWriteStream(this.eventsPath, { flags: 'a' })
    this.events.write(EVENT_HEADER)
    this.recordings = fs.createWriteStream(path.join(dir, 'videos', 'recordings.csv'), { flags: 'a' })
    this.recordings.write(RECORDINGS_HEADER)
  }

  static async create(outputRoot: string): Promise<SessionLogger> {
    const dir = path.join(outputRoot, `session_${localStamp(new Date())}`)
    await fsp.mkdir(path.join(dir, 'videos'), { recursive: true })
    await fsp.writeFile(path.join(dir, 'README.txt'), README_CONTENT, 'utf-8')
    return new SessionLogger(dir)
  }

  get recordingsDir(): string {
    return path.join(this.dir, 'videos')
  }

  /**
   * Write one participant's accepted calibration into the session folder:
   * calibration/<participant_id>/calibration.json plus the peak-frame
   * screenshot of each phase.
   *
   * It lives with the session's own data rather than in a shared store, so a
   * folder of results always carries the measurements the morph was actually
   * scaled against, and no session can be analysed using numbers that were
   * silently recorded somewhere else.
   */
  async writeCalibration(
    slot: string,
    profile: { participantId?: string; phases?: Record<string, { screenshot?: string }> },
    screenshots: Record<string, string>,
  ): Promise<string | null> {
    try {
      const key = sanitizeName(profile.participantId || slot)
      const dir = path.join(this.dir, 'calibration', key)
      await fsp.mkdir(dir, { recursive: true })
      const jsonPath = path.join(dir, 'calibration.json')
      await fsp.writeFile(jsonPath, JSON.stringify(profile, null, 2), 'utf-8')
      for (const [phase, dataUrl] of Object.entries(screenshots)) {
        const filename = profile.phases?.[phase]?.screenshot
        const bytes = decodeDataUrl(dataUrl)
        if (!filename || !bytes) continue
        await fsp.writeFile(path.join(dir, filename), bytes)
      }
      return jsonPath
    } catch (err) {
      console.warn('[logger] could not write calibration', err)
      return null
    }
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
          csvField(formatLocalDate(now)),
          csvField(formatLocalTimeOfDay(now)),
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
      fs.mkdirSync(path.join(this.dir, 'face'), { recursive: true })
      s = fs.createWriteStream(path.join(this.dir, 'face', `face_and_voice_changes_${key}.csv`), { flags: 'a' })
      s.write(STATE_HEADER.trimEnd() + ',voice_mode,voice_target,voice_calibration_state,voice_calibration_confidence,voice_applied_pitch_st,voice_applied_gain_db,voice_effect_active,voice_fallback_reason,self_voice_smile,partner_voice_smile\n')
      this.stateStreams.set(key, s)
    }
    return s
  }

  effectState(input: EffectStateInput): void {
    if (this.closed) return
    const now = Date.now()

    // classifier mode/version never change mid-session — captured once here
    // instead of repeating it on every single row; written into session_summary.json.
    if (!this.detectorInfo.has(input.slot) && (input.classifierMode || input.classifierVersion)) {
      this.detectorInfo.set(input.slot, {
        classifierMode: input.classifierMode,
        classifierVersion: input.classifierVersion,
      })
    }

    const conversationElapsedMs =
      input.phase !== 'waiting' && input.liveStartedAtMs != null
        ? now - input.liveStartedAtMs
        : ''

    this.stateStreamFor(input.slot).write(
      [
        csvField(input.dyadId ?? ''),
        csvField(input.participantId),
        csvField(input.partnerId ?? ''),
        csvField(input.slot),
        csvField(formatLocalDate(now)),
        csvField(formatLocalTimeOfDay(now)),
        now - this.startedAtMs,
        conversationElapsedMs,
        csvField(input.phase),
        input.selfAlpha,
        input.selfVoiceSemitones,
        input.partnerAlpha ?? '',
        input.partnerVoiceSemitones ?? '',
        csvField(input.expressionLabel ?? ''),
        csvField(input.smileType ?? ''),
        csvField(input.labelConfidence ?? ''),
        csvField(input.smileTypeConfidence ?? ''),
        csvField(input.smileTypeTrusted ?? ''),
        csvField(input.normalizedSmile ?? ''),
        csvField(input.normalizedFrown ?? ''),
        csvField(input.normalizedOpenness ?? ''),
        csvField(input.smileMargin ?? ''),
        csvField(input.frownMargin ?? ''),
        csvField(input.normalizationApplied ?? ''),
        csvField(input.normalizationVersion ?? ''),
        csvField(input.calibrated ?? ''),
        csvField(input.commandedAlpha ?? ''),
        csvField(input.appliedAlpha ?? ''),
        csvField(input.liveLevel ?? ''),
        csvField(input.headroom ?? ''),
        csvField(input.talking ?? ''),
        input.rawMouthSmileLeft ?? '',
        input.rawMouthSmileRight ?? '',
        input.rawMouthFrownLeft ?? '',
        input.rawMouthFrownRight ?? '',
        input.rawLipPressLeft ?? '',
        input.rawLipPressRight ?? '',
        input.rawUpperLipRaiseLeft ?? '',
        input.rawUpperLipRaiseRight ?? '',
        input.rawJawOpen ?? '',
        input.rawLowerLipDropLeft ?? '',
        input.rawLowerLipDropRight ?? '',
        input.rawEyeSquintLeft ?? '',
        input.rawEyeSquintRight ?? '',
        input.rawCheekSquintLeft ?? '',
        input.rawCheekSquintRight ?? '',
        input.faceFound,
        input.cameraOn,
        Math.round(input.fps * 10) / 10,
        csvField(input.voice ? modeName(input.voice.condition.mode) : ''),
        csvField(input.voice?.condition.targetSlot ?? ''),
        csvField(input.voice?.calibration.state ?? ''),
        csvField(input.voice?.calibration.confidence ?? ''),
        csvField(input.voice?.applied.pitchSemitones ?? ''),
        csvField(input.voice?.applied.gainDb ?? ''),
        csvField(input.voice?.applied.active ?? ''),
        csvField(input.voice?.applied.fallbackReason ?? ''),
        input.selfVoiceSmile,
        input.partnerVoiceSmile ?? '',
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
        csvField(formatLocalDate(pending.startedAtMs)),
        csvField(formatLocalTimeOfDay(pending.startedAtMs)),
        csvField(formatLocalDate(now)),
        csvField(formatLocalTimeOfDay(now)),
        pending.startedElapsedMs,
        stoppedElapsedMs,
        Math.round(durationMs / 100) / 10,
        csvField(pending.path),
        sizeMb,
      ].join(',') + '\n',
    )
  }

  async writeManifest(manifest: unknown): Promise<string> {
    const p = path.join(this.dir, 'session_summary.json')
    const withDetection = {
      ...(manifest as Record<string, unknown>),
      detection: Object.fromEntries(this.detectorInfo),
      voice: this.voice.manifest(),
    }
    await fsp.writeFile(p, JSON.stringify(withDetection, null, 2), 'utf-8')
    return p
  }

  // ---- Post-call review ----

  /** A review is starting: its own folder, with a plain note of the settings used. */
  startReview(input: ReviewSettingsInput): void {
    if (this.closed) return
    this.reviewCount += 1
    this.answers?.end()
    this.answers = null
    this.reviewDir = path.join(this.dir, this.reviewCount === 1 ? 'review' : `review_${this.reviewCount}`)
    const c = input.config
    const now = Date.now()
    const lines: [string, string][] = [
      ['Started', `${formatLocalDate(now)} ${formatLocalTimeOfDay(now).replace(/\.\d+ /, ' ')}`],
      ['Conversation reviewed', `${minSec(input.conversationMs)}, in ${input.turns} turns`],
      ['View', `${VIEW_TEXT[c.viewMode]}`],
      ['Turn length', `${c.segmentSec} seconds`],
      ['Goes first', input.firstPerson],
      ['Next turn starts', c.advance === 'auto' ? 'automatically, 10 seconds after the clip ends' : 'when both press Done'],
      ['Original video shown', c.showOriginal ? 'yes' : 'no'],
      ['Participants could pause', c.allowPause ? 'yes' : 'no'],
    ]
    const text =
      'Review settings\n===============\n' +
      lines.map(([k, v]) => `${(k + ':').padEnd(27)}${v}`).join('\n') +
      '\n'
    try {
      fs.mkdirSync(this.reviewDir, { recursive: true })
      fs.writeFileSync(path.join(this.reviewDir, 'settings.txt'), text, 'utf-8')
    } catch (err) {
      console.warn('[logger] could not write review settings', err)
    }
  }

  /** One answer: one row of review/answers.csv. */
  reviewAnswer(r: ReviewResponseRecord): void {
    if (this.closed || !this.reviewDir) return
    if (!this.answers) {
      this.answers = fs.createWriteStream(path.join(this.reviewDir, 'answers.csv'), { flags: 'a' })
      this.answers.write(REVIEW_ANSWERS_HEADER)
    }
    this.answers.write(
      [
        csvField(r.writer.dyadId || r.about.dyadId),
        r.segment.index,
        minSec(r.segment.startMs),
        minSec(r.segment.endMs),
        csvField(r.about.participantId || r.segment.targetSeat),
        csvField(r.writer.participantId || r.writerSlot),
        csvField(QUESTION_TEXT[r.responseType]),
        csvField(spreadsheetSafe(r.text)),
        csvField(HOW_SAVED_TEXT[r.submittedBy]),
        csvField(formatLocalDate(r.submittedAtMs)),
        csvField(formatLocalTimeOfDay(r.submittedAtMs)),
        csvField(VIEW_TEXT[r.viewMode]),
        r.originalShown ? Math.round(r.stats.msClean / 1000) : '',
        r.originalShown ? r.stats.toggles : '',
      ].join(',') + '\n',
    )
  }

  /** Safe filename for a recording, namespaced under videos/. */
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
    for (const s of [...this.stateStreams.values(), ...(this.answers ? [this.answers] : [])]) {
      ends.push(new Promise<void>((r) => s.end(() => r())))
    }
    await Promise.all(ends)
    await this.voice.close()
  }
}
