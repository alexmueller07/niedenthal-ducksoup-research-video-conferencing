// Per-participant calibration: pure maths only, no DOM and no timers, so it
// can be unit-tested against recorded frames without a camera.
//
// The guided sequence (see calibrationRunner.ts) records four phases — relaxed
// face, biggest closed-mouth smile, biggest open-mouth smile, biggest frown —
// and this file turns those frames into the two things the pipeline needs:
//
//   detection — this person's own neutral..max range and the dead zone implied
//               by how much their resting face wobbles.
//   morphing  — the real mouth-corner displacement of their maximum
//               expression, in mouth-widths, so alpha 1.0 moves their mouth
//               exactly that far and never further.
//
// Why two smiles: the warp only moves mouth corners. In a big open grin a lot
// of the corner travel is jaw drop, which a corner-pull warp cannot reproduce,
// so using it as the morph gain overshoots badly on a closed mouth. The
// closed-mouth smile therefore sets the gain; the open-mouth one sets the
// detection range, and the difference between them gives this person's
// jaw-to-corner coupling — which is what lets us subtract talking back out of
// the live signal.

import type {
  BlendshapeStats,
  CalibrationDirection,
  CalibrationPeak,
  CalibrationPhase,
  CalibrationPhaseSummary,
  CalibrationProfile,
  CalibrationQualityFlag,
  GeometryStats,
  ScoreStats,
  Stat,
} from './protocol'
import { CALIBRATION_PHASES } from './protocol'

export const CALIBRATION_VERSION = 'per-participant-geometry-v2-face-coupling'
export const CALIBRATION_SCHEMA_VERSION = 2
/** Older files are still readable; they simply carry no cheek/brow data. */
const SUPPORTED_SCHEMA_VERSIONS = [1, 2]

// ---- Timing ----

export const CALIBRATION_PREP_MS = 1500
export const CALIBRATION_NEUTRAL_MS = 3000
export const CALIBRATION_EXPRESSION_MS = 4000
export const CALIBRATION_SAMPLE_MS = 33
export const CALIBRATION_PEAK_FRAMES = 5
export const CALIBRATION_SETTLE_MS = 650

export function phaseDurationMs(phase: CalibrationPhase): number {
  return phase === 'neutral' ? CALIBRATION_NEUTRAL_MS : CALIBRATION_EXPRESSION_MS
}

export const CALIBRATION_PROMPTS: Record<
  CalibrationPhase,
  { title: string; instruction: string; shortLabel: string }
> = {
  neutral: {
    title: 'Relax your face',
    instruction: 'Look at the centre of the screen and let your face go completely relaxed.',
    shortLabel: 'Neutral',
  },
  smileClosed: {
    title: 'Biggest smile — lips together',
    instruction: 'Smile as big as you can, but keep your lips closed.',
    shortLabel: 'Max smile (closed)',
  },
  smileOpen: {
    title: 'Biggest smile — show your teeth',
    instruction: 'Now the same big smile, but let your mouth open and show your teeth.',
    shortLabel: 'Max smile (open)',
  },
  frown: {
    title: 'Biggest frown',
    instruction: 'Frown as hard as you can, pulling the corners of your mouth down.',
    shortLabel: 'Max frown',
  },
}

export const QUALITY_FLAG_LABELS: Record<CalibrationQualityFlag, string> = {
  insufficient_samples: 'Not enough frames captured',
  face_not_visible: 'Face was not visible often enough',
  off_axis_face: 'Face was turned away from the camera',
  not_relaxed: 'Face was not relaxed',
  mouth_open_during_closed_smile: 'Mouth opened during the closed-lip smile',
  too_close_to_neutral: 'Too close to their relaxed face to measure',
}

// ---- Uncalibrated fallbacks ----
//
// These reproduce the pre-calibration morph exactly, so alpha 1.0 without a
// profile behaves as alpha 1.0 always did and the scale stays continuous.
// The frown vector is today's (0.25 inward, 1.0 down) × 0.13 rewritten as a
// magnitude and an angle.

export const FALLBACK_SMILE: CalibrationDirection = {
  range: 0.35,
  deadZone: 0.25,
  cornerTravel: 0.17,
  cornerAngleRad: (25 * Math.PI) / 180,
}

export const FALLBACK_FROWN: CalibrationDirection & { poutDrop: number } = {
  range: 0.1,
  deadZone: 0.25,
  cornerTravel: 0.134,
  cornerAngleRad: Math.atan2(-1, -0.25),
  poutDrop: 0.065,
}

/** Safety rails, so a bad calibration cannot produce a dead or grotesque morph. */
export const MORPH_TRAVEL_MIN = 0.04
export const MORPH_TRAVEL_MAX = 0.35
export const MORPH_ANGLE_MIN_RAD = (10 * Math.PI) / 180
export const MORPH_ANGLE_MAX_RAD = (45 * Math.PI) / 180

/** Detection dead zone bounds, as a fraction of the person's own range. */
export const DEAD_ZONE_MIN = 0.08
export const DEAD_ZONE_MAX = 0.6
/** A phase must clear this many neutral standard deviations to be usable. */
export const NEUTRAL_SIGMA_MARGIN = 3
/** Absolute floors, for faces whose neutral is unusually steady. */
export const MIN_SMILE_RANGE = 0.06
export const MIN_FROWN_RANGE = 0.015
/** Below this left/right symmetry a calibration frame is off-axis. */
export const MIN_YAW_SYMMETRY = 0.55
/** Above this mouth-open ratio, a "closed-lip" smile was not closed. */
export const MAX_CLOSED_SMILE_OPEN_RATIO = 0.12

/** How far the morph fades at a wide-open mouth (1 − this = the floor). */
export const OPEN_MOUTH_FADE = 0.6

/**
 * Caps on how far the rest of the face is allowed to move, in mouth-widths.
 *
 * Deliberately tighter than the mouth's own cap. The cheek and brow areas sit
 * under glasses frames on a lot of people, and a bent frame reads as broken in
 * a way a slightly stiff cheek never does — so a mis-measurement here is much
 * more costly than under-moving.
 */
export const MAX_CHEEK_RISE = 0.12
export const MAX_BROW_RISE = 0.08
export const MAX_BROW_FURROW = 0.06
/** Below this the measurement is noise, and moving by it would only add jitter. */
export const MIN_FACE_COUPLING = 0.004

// ---- Frame shape ----

/** Every blendshape the pipeline reads, in the order they are stored. */
export const BLENDSHAPE_KEYS = [
  'mouthSmileLeft',
  'mouthSmileRight',
  'mouthFrownLeft',
  'mouthFrownRight',
  'mouthPressLeft',
  'mouthPressRight',
  'mouthUpperUpLeft',
  'mouthUpperUpRight',
  'jawOpen',
  'mouthLowerDownLeft',
  'mouthLowerDownRight',
  'eyeSquintLeft',
  'eyeSquintRight',
  'cheekSquintLeft',
  'cheekSquintRight',
  'mouthPucker',
  'mouthFunnel',
  'mouthShrugLower',
] as const

export interface GeometryFrame {
  cornerSpreadX: number
  cornerLiftY: number
  lowerLipDropY: number
  cheekRaiseY: number
  browRaiseY: number
  browGapX: number
  mouthOpenRatio: number
  mouthWidthToFaceWidth: number
  mouthCornerTilt: number
  yawSymmetry: number
}

export interface ScoreFrame {
  smile: number
  frown: number
  openness: number
  lipPress: number
  asymmetry: number
}

/** One sampled frame during calibration. `faceFound` false means the rest is stale. */
export interface CalibrationFrame {
  tsMs: number
  faceFound: boolean
  blendshapes: Record<string, number>
  scores: ScoreFrame
  geometry: GeometryFrame
}

const GEOMETRY_KEYS: Array<keyof GeometryFrame> = [
  'cornerSpreadX',
  'cornerLiftY',
  'lowerLipDropY',
  'cheekRaiseY',
  'browRaiseY',
  'browGapX',
  'mouthOpenRatio',
  'mouthWidthToFaceWidth',
  'mouthCornerTilt',
  'yawSymmetry',
]

const SCORE_KEYS: Array<keyof ScoreFrame> = [
  'smile',
  'frown',
  'openness',
  'lipPress',
  'asymmetry',
]

// ---- Summarizing a phase ----

/**
 * Rank frames by the score this phase is about and return the strongest ones.
 * A single frame is too noisy to be anyone's maximum, so the peak is the mean
 * of the top N.
 */
export function pickPeakFrames(
  frames: CalibrationFrame[],
  phase: CalibrationPhase,
  count = CALIBRATION_PEAK_FRAMES,
): CalibrationFrame[] {
  if (phase === 'neutral') return []
  const key: keyof ScoreFrame = phase === 'frown' ? 'frown' : 'smile'
  return [...frames]
    .filter((f) => f.faceFound)
    .sort((a, b) => b.scores[key] - a.scores[key])
    .slice(0, Math.max(1, count))
}

export function summarizePhase(
  phase: CalibrationPhase,
  frames: CalibrationFrame[],
  durationMs = phaseDurationMs(phase),
): CalibrationPhaseSummary {
  const usable = frames.filter((f) => f.faceFound)
  const faceVisibleRatio = frames.length === 0 ? 0 : usable.length / frames.length
  const basis = usable.length > 0 ? usable : frames

  const summary: CalibrationPhaseSummary = {
    phase,
    status: 'ok',
    capturedAt: new Date().toISOString(),
    durationMs,
    frames: frames.length,
    faceVisibleRatio: round3(faceVisibleRatio),
    blendshapes: blendshapeStats(basis),
    scores: scoreStats(basis),
    geometry: geometryStats(basis),
    qualityFlags: [],
  }

  if (phase !== 'neutral') {
    const peakFrames = pickPeakFrames(frames, phase)
    if (peakFrames.length > 0) {
      const key: keyof ScoreFrame = phase === 'frown' ? 'frown' : 'smile'
      const strongest = peakFrames.reduce((best, f) =>
        f.scores[key] > best.scores[key] ? f : best,
      )
      summary.peak = {
        topFrames: peakFrames.length,
        peakFrameIndex: frames.indexOf(strongest),
        peakTsMs: strongest.tsMs,
        blendshapes: blendshapeStats(peakFrames),
        scores: scoreStats(peakFrames),
        geometry: geometryStats(peakFrames),
      } satisfies CalibrationPeak
    }
  }

  return summary
}

/**
 * Decide whether a phase is good enough to keep. The researcher can redo a
 * single flagged phase without restarting the whole sequence.
 */
export function validatePhase(
  summary: CalibrationPhaseSummary,
  neutral?: CalibrationPhaseSummary,
): CalibrationPhaseSummary {
  const flags: CalibrationQualityFlag[] = []

  if (summary.frames < 10) flags.push('insufficient_samples')
  if (summary.faceVisibleRatio < 0.8) flags.push('face_not_visible')
  if (summary.geometry.yawSymmetry.mean < MIN_YAW_SYMMETRY) flags.push('off_axis_face')

  if (summary.phase === 'neutral') {
    // A resting face that is already pulling a shape gives every later
    // measurement a wrong zero, so this one is worth rejecting outright.
    if (summary.geometry.mouthOpenRatio.mean > 0.12 || summary.scores.lipPress.mean > 0.35) {
      flags.push('not_relaxed')
    }
  } else {
    if (
      summary.phase === 'smileClosed' &&
      summary.peak &&
      summary.peak.geometry.mouthOpenRatio.mean > MAX_CLOSED_SMILE_OPEN_RATIO
    ) {
      flags.push('mouth_open_during_closed_smile')
    }
    if (!summary.peak) {
      flags.push('insufficient_samples')
    } else if (neutral) {
      const key: keyof ScoreFrame = summary.phase === 'frown' ? 'frown' : 'smile'
      const floor = summary.phase === 'frown' ? MIN_FROWN_RANGE : MIN_SMILE_RANGE
      const range = summary.peak.scores[key].mean - neutral.scores[key].mean
      const noise = NEUTRAL_SIGMA_MARGIN * neutral.scores[key].std
      if (range < Math.max(floor, noise)) flags.push('too_close_to_neutral')
    }
  }

  return { ...summary, qualityFlags: flags, status: flags.length > 0 ? 'needs-redo' : 'ok' }
}

// ---- Building the profile ----

export interface CalibrationMeta {
  participantId: string
  dyadId: string
  studyId: string
  seat: CalibrationProfile['seat']
  appVersion: string
  camera: { width: number; height: number }
}

/**
 * Turn four accepted phases into the runtime profile. Returns null if any
 * phase is missing — a partial calibration is worse than none, because the
 * morph would be scaled against a range that was never measured.
 */
export function buildCalibrationProfile(
  phases: Partial<Record<CalibrationPhase, CalibrationPhaseSummary>>,
  meta: CalibrationMeta,
  acceptedAt = new Date().toISOString(),
): CalibrationProfile | null {
  const neutral = phases.neutral
  const smileClosed = phases.smileClosed
  const smileOpen = phases.smileOpen
  const frown = phases.frown
  if (!neutral || !smileClosed?.peak || !smileOpen?.peak || !frown?.peak) return null

  const n = neutral.geometry
  // Everything geometric is measured in face widths; the warp works in mouth
  // widths, so convert once here using the RESTING mouth width (mouth width
  // itself grows with a smile, which would otherwise hide the effect).
  const toMouthWidths = 1 / Math.max(1e-3, n.mouthWidthToFaceWidth.mean)

  // Morph gain comes from the closed-lip smile; detection range from the open
  // one, which is this person's true maximum smile signal.
  const smileVec = cornerVector(n, smileClosed.peak.geometry, toMouthWidths)
  const frownVec = cornerVector(n, frown.peak.geometry, toMouthWidths)

  const smileRange = Math.max(
    MIN_SMILE_RANGE,
    smileOpen.peak.scores.smile.mean - neutral.scores.smile.mean,
  )
  const frownRange = Math.max(
    MIN_FROWN_RANGE,
    frown.peak.scores.frown.mean - neutral.scores.frown.mean,
  )

  const poutDrop = Math.max(
    0,
    (frown.peak.geometry.lowerLipDropY.mean - n.lowerLipDropY.mean) * toMouthWidths,
  )

  // How much the rest of the face moves with each expression, measured on the
  // same takes and in the same units as the mouth.
  const smileCoupling = faceCoupling(n, smileClosed.peak.geometry, toMouthWidths)
  const frownCoupling = faceCoupling(n, frown.peak.geometry, toMouthWidths)

  // How much of a smile's corner travel is really the jaw dropping: the gap
  // between the open and closed smile, per unit of mouth opening. Subtracting
  // this at runtime is what stops talking from reading as an expression.
  const openVec = cornerVector(n, smileOpen.peak.geometry, toMouthWidths)
  const openRatioGap =
    smileOpen.peak.geometry.mouthOpenRatio.mean - smileClosed.peak.geometry.mouthOpenRatio.mean
  const jawCoupling = clamp(
    openRatioGap > 0.02 ? (openVec.travel - smileVec.travel) / openRatioGap : 0,
    0,
    1.5,
  )

  const validationPhases: CalibrationProfile['validation']['phases'] = {}
  const validationFlags: CalibrationQualityFlag[] = []
  for (const phase of CALIBRATION_PHASES) {
    const summary = phases[phase]
    if (!summary) continue
    validationPhases[phase] = summary.status
    for (const flag of summary.qualityFlags) {
      if (!validationFlags.includes(flag)) validationFlags.push(flag)
    }
  }

  return {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    version: CALIBRATION_VERSION,
    participantId: meta.participantId,
    dyadId: meta.dyadId,
    studyId: meta.studyId,
    seat: meta.seat,
    appVersion: meta.appVersion,
    capturedAt: neutral.capturedAt,
    acceptedAt,
    camera: meta.camera,
    phases,
    derived: {
      smile: {
        range: round3(smileRange),
        deadZone: round3(deadZoneFor(neutral.scores.smile.std, smileRange)),
        cornerTravel: round3(clamp(smileVec.travel, MORPH_TRAVEL_MIN, MORPH_TRAVEL_MAX)),
        cornerAngleRad: round3(
          clamp(smileVec.angle, MORPH_ANGLE_MIN_RAD, MORPH_ANGLE_MAX_RAD),
        ),
        ...smileCoupling,
      },
      frown: {
        range: round3(frownRange),
        deadZone: round3(deadZoneFor(neutral.scores.frown.std, frownRange)),
        cornerTravel: round3(clamp(frownVec.travel, MORPH_TRAVEL_MIN, MORPH_TRAVEL_MAX)),
        // A frown points down, so its angle lives in the lower half-plane and
        // gets the same clamp mirrored.
        cornerAngleRad: round3(
          -clamp(-frownVec.angle, MORPH_ANGLE_MIN_RAD, Math.PI - MORPH_ANGLE_MIN_RAD),
        ),
        poutDrop: round3(Math.min(poutDrop, MORPH_TRAVEL_MAX)),
        ...frownCoupling,
      },
      openness: {
        neutral: round3(neutral.scores.openness.mean),
        max: round3(smileOpen.peak.scores.openness.mean),
      },
      jawCoupling: round3(jawCoupling),
      openScaleRange: {
        neutralOpen: round3(n.mouthOpenRatio.mean),
        openSmileOpen: round3(
          Math.max(
            n.mouthOpenRatio.mean + 0.05,
            smileOpen.peak.geometry.mouthOpenRatio.mean,
          ),
        ),
      },
      talking: { openRatioStdNeutral: round3(Math.max(0.002, n.mouthOpenRatio.std)) },
    },
    validation: { phases: validationPhases, flags: validationFlags },
  }
}

/**
 * Corner displacement between a neutral baseline and a peak, as a magnitude in
 * mouth-widths plus the direction it travelled.
 *
 * Only half the change in corner spread is used: `cornerSpreadX` is the gap
 * between both corners, so each individual corner moves half of it.
 */
function cornerVector(
  neutral: GeometryStats,
  peak: GeometryStats,
  toMouthWidths: number,
): { travel: number; angle: number; dx: number; dy: number } {
  const dx = ((peak.cornerSpreadX.mean - neutral.cornerSpreadX.mean) / 2) * toMouthWidths
  const dy = (peak.cornerLiftY.mean - neutral.cornerLiftY.mean) * toMouthWidths
  return { travel: Math.hypot(dx, dy), angle: Math.atan2(dy, dx), dx, dy }
}

/**
 * Cheek, brow and brow-furrow travel between a neutral baseline and a peak, in
 * mouth-widths.
 *
 * Signs are chosen so that positive always means "the thing people expect":
 * cheeks up, brows up, inner brows together. `cheekRaiseY` and `browGapX`
 * shrink as those happen, hence the flipped subtraction.
 *
 * Anything below the noise floor comes back as 0, so a person whose cheeks
 * genuinely do not move gets a mouth-only morph rather than a jittery one.
 */
function faceCoupling(
  neutral: GeometryStats,
  peak: GeometryStats,
  toMouthWidths: number,
): { cheekRise: number; browRise: number; browFurrow: number } {
  const cheekRise = (neutral.cheekRaiseY.mean - peak.cheekRaiseY.mean) * toMouthWidths
  const browRise = (peak.browRaiseY.mean - neutral.browRaiseY.mean) * toMouthWidths
  const browFurrow = (neutral.browGapX.mean - peak.browGapX.mean) * toMouthWidths
  return {
    // Brow movement keeps its sign: some people raise their brows when they
    // smile and others lower them, and the whole point is to copy what this
    // person does rather than assume.
    cheekRise: round3(deadband(clamp(cheekRise, 0, MAX_CHEEK_RISE))),
    browRise: round3(deadband(clamp(browRise, -MAX_BROW_RISE, MAX_BROW_RISE))),
    browFurrow: round3(deadband(clamp(browFurrow, 0, MAX_BROW_FURROW))),
  }
}

function deadband(value: number): number {
  return Math.abs(value) < MIN_FACE_COUPLING ? 0 : value
}

export function deadZoneFor(neutralStd: number, range: number): number {
  return clamp(
    (NEUTRAL_SIGMA_MARGIN * neutralStd) / Math.max(1e-6, range),
    DEAD_ZONE_MIN,
    DEAD_ZONE_MAX,
  )
}

/** Reload a written calibration.json. Returns null if it is not one we understand. */
export function parseCalibrationFile(raw: unknown): CalibrationProfile | null {
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Partial<CalibrationProfile>
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(candidate.schemaVersion as number)) return null
  if (!candidate.derived?.smile || !candidate.derived?.frown) return null
  if (!candidate.phases?.neutral) return null
  return candidate as CalibrationProfile
}

// ---- Runtime: detection ----

/**
 * How far a score sits between this person's neutral and their own maximum.
 * Clamps at 1 when they exceed what calibration measured — the caller logs
 * that, so an under-measured calibration is visible rather than silent.
 */
export function normalizedLevel(current: number, neutralMean: number, range: number): number {
  return clamp01((current - neutralMean) / Math.max(1e-6, range))
}

export function exceedsCalibratedMax(
  current: number,
  neutralMean: number,
  range: number,
): boolean {
  return current - neutralMean > range
}

// ---- Runtime: morph ----

export interface MorphDirection {
  cornerTravel: number
  cornerAngleRad: number
  poutDrop: number
  cheekRise: number
  browRise: number
  browFurrow: number
}

/** The per-person warp geometry for a given alpha, or today's constants if uncalibrated. */
export function morphDirectionFor(
  profile: CalibrationProfile | null,
  alpha: number,
): MorphDirection {
  if (alpha >= 0) {
    const d = profile?.derived.smile ?? FALLBACK_SMILE
    return {
      cornerTravel: d.cornerTravel,
      cornerAngleRad: d.cornerAngleRad,
      poutDrop: 0,
      // Absent on an uncalibrated participant and on files written before the
      // cheeks and brows were measured — both fall back to a mouth-only morph.
      cheekRise: d.cheekRise ?? 0,
      browRise: d.browRise ?? 0,
      browFurrow: 0,
    }
  }
  const d = profile?.derived.frown ?? FALLBACK_FROWN
  return {
    cornerTravel: d.cornerTravel,
    cornerAngleRad: d.cornerAngleRad,
    poutDrop: d.poutDrop,
    cheekRise: d.cheekRise ?? 0,
    browRise: d.browRise ?? 0,
    browFurrow: d.browFurrow ?? 0,
  }
}

/**
 * How far this person's real face has already travelled toward their own
 * maximum, 0..1, measured from landmark geometry rather than blendshapes —
 * the thing being capped is corner displacement, so the cap has to be in the
 * same units as the warp.
 *
 * The live corner movement is projected onto the direction calibration
 * measured, so a sideways or lopsided mouth movement does not read as a smile,
 * and the jaw's own contribution is subtracted first so talking does not eat
 * the headroom.
 */
export function geometricLevel(
  profile: CalibrationProfile | null,
  live: GeometryFrame,
  direction: 'smile' | 'frown',
): number {
  const neutral = profile?.phases.neutral?.geometry
  if (!profile || !neutral) return 0

  const toMouthWidths = 1 / Math.max(1e-3, neutral.mouthWidthToFaceWidth.mean)
  const dx = ((live.cornerSpreadX - neutral.cornerSpreadX.mean) / 2) * toMouthWidths
  const dy = (live.cornerLiftY - neutral.cornerLiftY.mean) * toMouthWidths

  const d = direction === 'smile' ? profile.derived.smile : profile.derived.frown
  const projected = dx * Math.cos(d.cornerAngleRad) + dy * Math.sin(d.cornerAngleRad)

  const jawAdjust =
    profile.derived.jawCoupling *
    Math.max(0, live.mouthOpenRatio - profile.derived.openScaleRange.neutralOpen)

  return clamp01((projected - jawAdjust) / Math.max(1e-6, d.cornerTravel))
}

/**
 * The morph's share of this person's maximum, after their real expression has
 * taken its share. Their current expression plus the morph must never exceed
 * what their face can actually do.
 */
export function cappedAlpha(commandedAlpha: number, liveLevel: number): number {
  const headroom = clamp01(1 - liveLevel)
  const magnitude = Math.min(Math.abs(clamp(commandedAlpha, -1, 1)), headroom)
  return commandedAlpha < 0 ? -magnitude : magnitude
}

/**
 * Fade the corner morph out as the mouth opens. A planar corner-pull warp looks
 * worst across a wide-open mouth, and that is also where the effect is least
 * noticeable — so this is a continuous fade to a floor, never an on/off gate
 * that would pulse during speech.
 */
export function openMouthScale(profile: CalibrationProfile | null, openRatio: number): number {
  if (!profile) return 1
  const { neutralOpen, openSmileOpen } = profile.derived.openScaleRange
  const span = Math.max(1e-3, openSmileOpen - neutralOpen)
  return 1 - OPEN_MOUTH_FADE * clamp01((openRatio - neutralOpen) / span)
}

// ---- Runtime: talking ----

export const TALKING_WINDOW_MS = 600
export const TALKING_RELEASE_MS = 400
export const TALKING_STD_MULTIPLIER = 3
export const TALKING_MIC_RMS_ON = 0.02

/**
 * Speech is a modulated mouth shape; an expression is a sustained one. So we
 * watch how much the mouth opening is *wobbling* against this person's own
 * resting wobble, and require the microphone to agree — geometry alone
 * mistakes chewing, laughing and yawning for speech.
 */
export class TalkingDetector {
  private window: Array<{ tsMs: number; openRatio: number }> = []
  private talkingSince = 0
  private quietSince = 0
  private active = false

  constructor(private neutralOpenRatioStd = 0.006) {}

  setBaseline(std: number) {
    this.neutralOpenRatioStd = Math.max(0.002, std)
  }

  /** Feed one frame. `micRms` is 0 when no microphone signal is available. */
  push(tsMs: number, openRatio: number, micRms: number): boolean {
    this.window.push({ tsMs, openRatio })
    while (this.window.length > 1 && tsMs - this.window[0].tsMs > TALKING_WINDOW_MS) {
      this.window.shift()
    }

    const values = this.window.map((w) => w.openRatio)
    const moving = values.length >= 4 && std(values) > TALKING_STD_MULTIPLIER * this.neutralOpenRatioStd
    const audible = micRms > TALKING_MIC_RMS_ON

    if (moving && audible) {
      this.talkingSince = this.talkingSince || tsMs
      this.quietSince = 0
      this.active = true
    } else {
      this.quietSince = this.quietSince || tsMs
      this.talkingSince = 0
      // Hold briefly through the gaps between words rather than flickering.
      if (this.active && tsMs - this.quietSince >= TALKING_RELEASE_MS) this.active = false
    }
    return this.active
  }

  get talking() {
    return this.active
  }

  reset() {
    this.window = []
    this.active = false
    this.talkingSince = 0
    this.quietSince = 0
  }
}

// ---- Stats helpers ----

function blendshapeStats(frames: CalibrationFrame[]): BlendshapeStats {
  const out: BlendshapeStats = {}
  for (const key of BLENDSHAPE_KEYS) {
    out[key] = statOf(frames.map((f) => f.blendshapes[key] ?? 0))
  }
  return out
}

function scoreStats(frames: CalibrationFrame[]): ScoreStats {
  const out = {} as ScoreStats
  for (const key of SCORE_KEYS) {
    out[key] = statOf(frames.map((f) => f.scores[key]))
  }
  return out
}

function geometryStats(frames: CalibrationFrame[]): GeometryStats {
  const out = {} as GeometryStats
  for (const key of GEOMETRY_KEYS) {
    out[key] = statOf(frames.map((f) => f.geometry[key]))
  }
  return out
}

export function statOf(values: number[]): Stat {
  const finite = values.filter((v) => Number.isFinite(v))
  if (finite.length === 0) return { mean: 0, std: 0 }
  const mean = finite.reduce((sum, v) => sum + v, 0) / finite.length
  return { mean: round4(mean), std: round4(std(finite, mean)) }
}

function std(values: number[], knownMean?: number): number {
  if (values.length < 2) return 0
  const mean = knownMean ?? values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function round3(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0
}

function round4(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10000) / 10000 : 0
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}
