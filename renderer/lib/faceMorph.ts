// Real-time facial smile morph + real-expression detection, using in-browser
// face-landmark detection.
//
// MediaPipe FaceLandmarker (WASM) detects the 468-point face mesh each frame;
// we warp a grid over the mouth region so the mouth corners move with the alpha
// control. Because the warp tracks the actual mouth it reads as an expression
// change rather than a video glitch, and it does nothing when no face is found.
//
// Morph geometry (reworked after the 2026-07 lab demo feedback):
//   smile — corners travel OUT and UP at ~25° above horizontal (mostly outward),
//           instead of the old straight-vertical lift the RAs flagged as
//           unnatural.
//   frown — parabolic: the corners (the outer nodes) pull down and slightly
//           inward while the area just below the centre of the lower lip drops
//           a little, mimicking a protruding lower lip.
//   Both are attenuated as the head turns toward a side profile, where the
//   planar warp used to look "very weird" (RA note).
//   Alpha changes are tweened (~350 ms time constant) so preset buttons ease in
//   rather than snapping.
//
// Expression detection: the landmarker also outputs face blendshapes, computed
// on the RAW camera frame — i.e. the participant's genuine expression, never
// the morphed output. We classify smiling/frowning plus a heuristic smile
// sub-type following the lab's reward / affiliative / dominance framework
// (Martin et al. 2021; Rychlowska et al. 2021). The sub-type mapping is a
// starting heuristic to calibrate with lab data:
//   reward      — symmetric smile with eye/cheek constriction (Duchenne marker)
//   dominance   — clearly asymmetric smile, or nose wrinkle / sneer component
//   affiliative — everything else (often with a lip-press component)

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import {
  BLENDSHAPE_KEYS,
  TalkingDetector,
  cappedAlpha,
  exceedsCalibratedMax,
  geometricLevel,
  morphDirectionFor,
  normalizedLevel,
  openMouthScale,
  type CalibrationFrame,
  type GeometryFrame,
} from './calibration'
import type {
  CalibrationProfile,
  CalibrationRuntimeState,
  ExpressionLabel,
  ExpressionState,
  FaceShapeMetrics,
  SmileType,
} from './protocol'

// Vendored locally (renderer/public/mediapipe/) so a session starts fast and
// works offline. The CDN is only a fallback if the local assets are missing.
const LOCAL_WASM_BASE = '/mediapipe/wasm'
const LOCAL_MODEL_URL = '/mediapipe/face_landmarker.task'
const CDN_WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const CDN_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Outer-lip landmark indices (MediaPipe FaceMesh) used to bound the mouth ROI.
const LIP_INDICES = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37,
  39, 40, 185,
]
const LEFT_CORNER = 61
const RIGHT_CORNER = 291
const UPPER_INNER_LIP = 13
const LOWER_INNER_LIP = 14
// Outer centre of the lower lip — the point a frown's pout drags down.
const LOWER_LIP_CENTER = 17
const LEFT_OUTER_EYE = 33
const RIGHT_OUTER_EYE = 263
const LEFT_INNER_EYE = 133
const RIGHT_INNER_EYE = 362
// Upper/lower lids, used to size the protected zone around each eye.
const LEFT_UPPER_LID = 159
const LEFT_LOWER_LID = 145
const RIGHT_UPPER_LID = 386
const RIGHT_LOWER_LID = 374
// Brows: inner ends move toward each other in a furrow, the mid points ride up
// and down with a raise.
const LEFT_BROW_INNER = 107
const RIGHT_BROW_INNER = 336
const LEFT_BROW_MID = 105
const RIGHT_BROW_MID = 334
// Mid-cheek, kept low on the face: on a glasses wearer the lower rim sits on
// the upper cheek, and bending a rigid frame looks far worse than a stiff cheek.
const LEFT_CHEEK = 205
const RIGHT_CHEEK = 425
// Yaw estimation: nose tip vs. the two face-oval cheek extremes.
const NOSE_TIP = 1
const LEFT_FACE_EDGE = 234
const RIGHT_FACE_EDGE = 454

// ---- Morph tuning ----
//
// Corner travel and direction are per participant, measured by calibration
// (renderer/lib/calibration.ts) so alpha 1.0 moves THIS person's mouth exactly
// as far as their own biggest expression and never further. Without a profile
// the fallbacks in calibration.ts reproduce the old fixed geometry exactly.
const ALPHA_TWEEN_TAU_MS = 350 // preset transitions ease in over ~1 s
// Below this left/right face-half symmetry the morph fades out (side profile).
const YAW_FADE_START = 0.65
const YAW_FADE_END = 0.35
const CLASSIFIER_MODE = 'heuristic-subtype' as const
const CLASSIFIER_VERSION = 'heuristic-contract-v1'
export const NORMALIZED_CLASSIFIER_VERSION = 'heuristic-contract-v2-face-shape-normalized'

// ---- Detection tuning ----
//
// Calibrated 2026-07 against the lab's five example photos (smile_examples/):
// FaceLandmarker blendshapes were measured for each image and the thresholds
// below chosen so all five classify correctly. Findings that drove the design:
//   - a relaxed "straight" face can score mouthSmile ≈ 0.54, so the smiling
//     threshold must sit well above that;
//   - cheekSquint and noseSneer are ~0 on every image (dead features here), and
//     eyeSquint is contaminated by blinking/looking down — so the classic
//     Duchenne eye cue is NOT usable as the reward marker with this model;
//   - what actually separates the three smile types in the examples:
//       reward      → mouth opens / teeth show (mouthUpperUp ≈ 0.65 vs ≈ 0.005)
//       dominance   → left/right asymmetry of smile + lip press (rel. ≈ 0.21)
//       affiliative → strong smile with closed lips and none of the above;
//   - the frown example peaks at mouthFrown ≈ 0.12 with smile ≈ 0, so frowning
//     uses a low mouthFrown threshold gated on the absence of a smile.
// Still a heuristic — recalibrate when new example photos land.
export const DETECTION_TUNING = {
  smileOn: 0.6,
  smileOff: 0.45,
  frownOn: 0.03,
  frownOff: 0.01,
  /** Openness (upper-lip raise + jaw + lower-lip drop) above this → reward. */
  rewardOpenness: 0.2,
  /** Relative L/R asymmetry (smile + lip press, ÷ smile level) above this → dominance. */
  dominanceRelAsymmetry: 0.12,
  /** Below this, a smile is published without a trusted sub-type. */
  minPublishedSubtypeConfidence: 0.55,
  /**
   * EMA time constant for blendshape smoothing. Short on purpose: with a
   * per-person dead zone from calibration there is no longer any need to
   * average away a global threshold's false positives, and long averaging was
   * most of the old ~0.6 s reporting lag.
   */
  emaTauMs: 80,
  /** A new label/sub-type must persist this long before it is published. */
  debounceMs: 100,
  /** While the participant is speaking, the smile dead zone is raised by this. */
  talkingDeadZoneMultiplier: 1.5,
}

/**
 * Which smoothing slot below holds each MediaPipe blendshape. The slots are
 * named for readability in the maths; calibration needs them back under their
 * MediaPipe names.
 */
const EMA_KEY_FOR: Record<string, string> = {
  mouthSmileLeft: 'smileL',
  mouthSmileRight: 'smileR',
  mouthFrownLeft: 'frownL',
  mouthFrownRight: 'frownR',
  mouthPressLeft: 'pressL',
  mouthPressRight: 'pressR',
  mouthUpperUpLeft: 'upperUpL',
  mouthUpperUpRight: 'upperUpR',
  jawOpen: 'jawOpen',
  mouthLowerDownLeft: 'lowerDownL',
  mouthLowerDownRight: 'lowerDownR',
  eyeSquintLeft: 'eyeSquintL',
  eyeSquintRight: 'eyeSquintR',
  cheekSquintLeft: 'cheekSquintL',
  cheekSquintRight: 'cheekSquintR',
  mouthPucker: 'pucker',
  mouthFunnel: 'funnel',
  mouthShrugLower: 'shrugLower',
}

interface Pt {
  x: number
  y: number
}

/** Landmark positions the displacement field is built around, in pixels. */
interface FaceAnchors {
  mouthCenterX: number
  mouthCenterY: number
  leftEye: Pt
  rightEye: Pt
  eyeWidth: number
  eyeHeight: number
  leftCheek: Pt
  rightCheek: Pt
  leftBrow: Pt
  rightBrow: Pt
}

export class FaceMorphProcessor {
  private landmarker: FaceLandmarker | null = null
  private src: HTMLCanvasElement // holds the raw frame for sampling
  private srcCtx: CanvasRenderingContext2D
  private alphaTarget = 0
  private alphaCurrent = 0
  private lastTweenTs: number | null = null
  private cols = 12
  private rows = 8
  private lastFaceFound = false

  // Expression state (smoothed + debounced).
  private ema: Record<string, number> = {}
  private publishedLabel: ExpressionLabel = 'neutral'
  private publishedType: SmileType | null = null
  private candidateLabel: ExpressionLabel = 'neutral'
  private candidateType: SmileType | null = null
  private candidateSince = 0
  private lastExpression: ExpressionState | null = null
  private lastFaceTs = 0
  private calibrationProfile: CalibrationProfile | null = null
  private lastGeometry: GeometryFrame | null = null
  private lastBlendshapes: Record<string, number> = {}
  private talkingDetector = new TalkingDetector()
  private micRms = 0
  private reportedExceeded = false
  /**
   * Multiplier on the cheek/brow movement only. 1 = exactly what calibration
   * measured. Exposed for tuning against a real face, because how much of this
   * looks right is a judgement call that no test can settle — and it depends on
   * things the landmarks don't see, like glasses.
   */
  private faceCouplingScale = 1
  // Live cap state, reported in telemetry so the logs show what was actually
  // applied rather than only what was commanded.
  private liveLevel = 0
  private headroom = 1
  private appliedAlpha = 0

  constructor() {
    this.src = document.createElement('canvas')
    const ctx = this.src.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    this.srcCtx = ctx
  }

  async init(): Promise<void> {
    try {
      this.landmarker = await this.create(LOCAL_WASM_BASE, LOCAL_MODEL_URL)
    } catch (err) {
      console.warn('[faceMorph] local MediaPipe assets missing, falling back to CDN', err)
      this.landmarker = await this.create(CDN_WASM_BASE, CDN_MODEL_URL)
    }
  }

  private async create(wasmBase: string, modelUrl: string): Promise<FaceLandmarker> {
    const fileset = await FilesetResolver.forVisionTasks(wasmBase)
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      // Blendshapes drive real-expression detection (smile/frown + sub-type).
      outputFaceBlendshapes: true,
    })
  }

  /** Set the morph target; the render loop eases toward it (smooth transitions). */
  setAlpha(alpha: number) {
    this.alphaTarget = alpha
  }

  /** Scale the cheek/brow movement. 1 = as measured, 0 = mouth only. */
  setFaceCoupling(scale: number) {
    this.faceCouplingScale = Number.isFinite(scale) ? Math.min(1.5, Math.max(0, scale)) : 1
  }

  get faceCoupling() {
    return this.faceCouplingScale
  }

  /** Apply this participant's calibration. Null clears it back to the fallbacks. */
  setCalibrationProfile(profile: CalibrationProfile | null) {
    this.calibrationProfile = profile
    this.talkingDetector.setBaseline(profile?.derived.talking.openRatioStdNeutral ?? 0.006)
    this.talkingDetector.reset()
  }

  get calibrationProfile_(): CalibrationProfile | null {
    return this.calibrationProfile
  }

  /**
   * Latest short-window microphone level, 0..1. The talking detector needs the
   * mic to agree with the mouth movement — geometry alone mistakes chewing,
   * laughing and yawning for speech.
   */
  setMicLevel(rms: number) {
    this.micRms = Number.isFinite(rms) ? rms : 0
  }

  /** One frame in the shape calibration records. Null until a face has been seen. */
  sample(tsMs: number): CalibrationFrame | null {
    const e = this.lastExpression
    if (!e || !this.lastGeometry) return null
    return {
      tsMs,
      faceFound: this.lastFaceFound,
      blendshapes: { ...this.lastBlendshapes },
      scores: {
        smile: e.smile,
        frown: e.frown,
        openness: e.openness,
        lipPress: e.lipPress,
        asymmetry: e.asymmetry,
      },
      geometry: { ...this.lastGeometry },
    }
  }

  /** The current RAW camera frame as a JPEG data URL, for calibration screenshots. */
  snapshot(maxWidth = 480, quality = 0.7): string | null {
    if (!this.src.width || !this.src.height) return null
    const scale = Math.min(1, maxWidth / this.src.width)
    const out = document.createElement('canvas')
    out.width = Math.round(this.src.width * scale)
    out.height = Math.round(this.src.height * scale)
    const ctx = out.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(this.src, 0, 0, out.width, out.height)
    try {
      return out.toDataURL('image/jpeg', quality)
    } catch {
      return null
    }
  }

  get ready() {
    return this.landmarker !== null
  }

  get faceFound() {
    return this.lastFaceFound
  }

  /** Latest detected REAL expression (null until a face has been seen). */
  get expression(): ExpressionState | null {
    return this.lastExpression
  }

  get calibration(): CalibrationRuntimeState {
    return {
      calibrated: this.calibrationProfile !== null,
      acceptedAt: this.calibrationProfile?.acceptedAt,
      participantId: this.calibrationProfile?.participantId,
      liveLevel: round2(this.liveLevel),
      headroom: round2(this.headroom),
      appliedAlpha: round2(this.appliedAlpha),
      talking: this.talkingDetector.talking,
    }
  }

  /**
   * Draw one processed frame to `dstCtx`. Returns true if a face was morphed.
   */
  render(
    video: HTMLVideoElement,
    dstCtx: CanvasRenderingContext2D,
    width: number,
    height: number,
    tsMs: number,
  ): boolean {
    // Snapshot the raw frame (used both as the displayed base and warp source).
    if (this.src.width !== width || this.src.height !== height) {
      this.src.width = width
      this.src.height = height
    }
    this.srcCtx.drawImage(video, 0, 0, width, height)
    dstCtx.drawImage(this.src, 0, 0, width, height)

    // Tween alpha toward its target (dt-based, so it is framerate-independent).
    const dt = this.lastTweenTs === null ? 16 : Math.min(100, tsMs - this.lastTweenTs)
    this.lastTweenTs = tsMs
    const k = 1 - Math.exp(-dt / ALPHA_TWEEN_TAU_MS)
    this.alphaCurrent += (this.alphaTarget - this.alphaCurrent) * k
    if (Math.abs(this.alphaCurrent - this.alphaTarget) < 0.004) {
      this.alphaCurrent = this.alphaTarget
    }

    if (!this.landmarker) {
      this.lastFaceFound = false
      return false
    }

    // Detection always runs (it feeds expression rules even at neutral alpha),
    // and always on the RAW video frame — never the morphed canvas.
    let result
    try {
      result = this.landmarker.detectForVideo(video, tsMs)
    } catch {
      return false
    }
    const faces = result?.faceLandmarks
    if (!faces || faces.length === 0) {
      this.lastFaceFound = false
      // A briefly lost face (hand wave, look-away) keeps the last expression;
      // after a second we decay to neutral so rules do not hold forever.
      if (this.lastExpression && tsMs - this.lastFaceTs > 1000) {
        this.updateExpressionFromRaw(tsMs, null, null)
      }
      return false
    }
    this.lastFaceFound = true
    this.lastFaceTs = tsMs

    const lm = faces[0]
    const toPx = (i: number): Pt => ({ x: lm[i].x * width, y: lm[i].y * height })
    const geometry = this.computeGeometry(toPx)
    this.lastGeometry = geometry

    this.updateExpressionFromRaw(
      tsMs,
      result.faceBlendshapes?.[0]?.categories ?? null,
      geometry,
    )

    // Measured every frame, not only while morphing, so the dashboard readout
    // and the logs keep tracking the participant's real face at neutral alpha.
    const direction = this.alphaCurrent >= 0 ? 'smile' : 'frown'
    this.liveLevel = geometricLevel(this.calibrationProfile, geometry, direction)
    this.headroom = Math.max(0, 1 - this.liveLevel)

    if (Math.abs(this.alphaCurrent) < 0.02) {
      this.appliedAlpha = 0
      return false
    }

    // Mouth geometry.
    const lc = toPx(LEFT_CORNER)
    const rc = toPx(RIGHT_CORNER)
    const centerX = (lc.x + rc.x) / 2
    const centerY = (lc.y + rc.y) / 2
    const mouthWidth = Math.hypot(rc.x - lc.x, rc.y - lc.y)

    // Head-yaw attenuation: compare the two face halves (nose tip → cheek
    // edge). Near-frontal ≈ 1; a side profile pushes the ratio toward 0 and the
    // morph fades out instead of smearing across the cheek.
    const nose = toPx(NOSE_TIP)
    const lEdge = toPx(LEFT_FACE_EDGE)
    const rEdge = toPx(RIGHT_FACE_EDGE)
    const dl = Math.abs(nose.x - lEdge.x)
    const dr = Math.abs(rEdge.x - nose.x)
    const symmetry = Math.min(dl, dr) / Math.max(1e-3, Math.max(dl, dr))
    const yawScale = clamp01((symmetry - YAW_FADE_END) / (YAW_FADE_START - YAW_FADE_END))
    if (yawScale <= 0.01) return false

    // The cap is on the TOTAL: what their real face is already doing plus what
    // the morph adds must not exceed their own calibrated maximum. So the morph
    // only gets the headroom that is left.
    const capped = cappedAlpha(this.alphaCurrent, this.liveLevel)
    this.appliedAlpha = capped
    if (Math.abs(capped) < 0.02) return false

    const openScale = openMouthScale(this.calibrationProfile, geometry.mouthOpenRatio)
    const strength = capped * yawScale * openScale
    const direction_ = this.morphDirection(strength)
    // Does anything beyond the mouth actually move for this person? If not
    // (uncalibrated, or a calibration recorded before cheeks and brows were
    // measured) keep the original tight mouth box and mesh, so the morph is
    // byte-for-byte what it was and no extra area gets rendered for nothing.
    const couples =
      Math.abs(direction_.cheekRise) > 0 ||
      Math.abs(direction_.browRise) > 0 ||
      Math.abs(direction_.browFurrow) > 0

    // ROI bounding box, expanded to include surrounding skin so the warp blends
    // naturally. Lips only when the mouth moves alone; brow-to-chin when the
    // rest of the face comes with it, so the cheek between mouth and eye is
    // inside one continuous field instead of a frozen band between two patches.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const bounds = couples
      ? [...LIP_INDICES, LEFT_BROW_MID, RIGHT_BROW_MID, LEFT_BROW_INNER, RIGHT_BROW_INNER,
         LEFT_CHEEK, RIGHT_CHEEK, LEFT_OUTER_EYE, RIGHT_OUTER_EYE]
      : LIP_INDICES
    for (const i of bounds) {
      const p = toPx(i)
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const padX = mouthWidth * 0.55
    const padY = mouthWidth * 0.7
    // Extra headroom above the brows so the window has somewhere to fade out
    // rather than cutting off mid-forehead.
    const padTop = couples ? mouthWidth * 0.85 : padY
    const roi = {
      x: Math.max(0, minX - padX),
      y: Math.max(0, minY - padTop),
      w: Math.min(width, maxX + padX) - Math.max(0, minX - padX),
      h: Math.min(height, maxY + padY) - Math.max(0, minY - padTop),
    }

    const anchors: FaceAnchors = {
      mouthCenterX: centerX,
      mouthCenterY: centerY,
      leftEye: midpoint(toPx(LEFT_OUTER_EYE), toPx(LEFT_INNER_EYE)),
      rightEye: midpoint(toPx(RIGHT_OUTER_EYE), toPx(RIGHT_INNER_EYE)),
      eyeWidth: Math.max(
        distance(toPx(LEFT_OUTER_EYE), toPx(LEFT_INNER_EYE)),
        distance(toPx(RIGHT_OUTER_EYE), toPx(RIGHT_INNER_EYE)),
      ),
      eyeHeight: Math.max(
        distance(toPx(LEFT_UPPER_LID), toPx(LEFT_LOWER_LID)),
        distance(toPx(RIGHT_UPPER_LID), toPx(RIGHT_LOWER_LID)),
      ),
      leftCheek: toPx(LEFT_CHEEK),
      rightCheek: toPx(RIGHT_CHEEK),
      leftBrow: toPx(LEFT_BROW_MID),
      rightBrow: toPx(RIGHT_BROW_MID),
    }

    this.warp(dstCtx, roi, anchors, mouthWidth, strength, couples)
    return true
  }

  // ---- Expression detection ----

  private updateExpressionFromRaw(
    tsMs: number,
    categories: Array<{ categoryName: string; score: number }> | null,
    geometry: GeometryFrame | null,
  ) {
    // Raw scores (0 when the face is lost → everything decays to neutral).
    const raw: Record<string, number> = {}
    if (categories) {
      for (const c of categories) raw[c.categoryName] = c.score
    }
    const g = (name: string) => raw[name] ?? 0

    const dt = 33 // called once per rendered frame; exact dt matters little here
    const k = 1 - Math.exp(-dt / DETECTION_TUNING.emaTauMs)
    const ema = (key: string, v: number) => {
      const prev = this.ema[key] ?? v
      const next = prev + (v - prev) * k
      this.ema[key] = next
      return next
    }

    // Every raw MediaPipe facial-movement score is smoothed individually first
    // (kept around for the raw_* telemetry columns), then combined below into
    // the same smile/frown/openness/etc. features as before — EMA is linear,
    // so smoothing-then-combining gives identical results to the old
    // combine-then-smooth approach.
    const smileL = ema('smileL', g('mouthSmileLeft'))
    const smileR = ema('smileR', g('mouthSmileRight'))
    const smile = (smileL + smileR) / 2
    const frownL = ema('frownL', g('mouthFrownLeft'))
    const frownR = ema('frownR', g('mouthFrownRight'))
    const pressL = ema('pressL', g('mouthPressLeft'))
    const pressR = ema('pressR', g('mouthPressRight'))
    const lipPress = (pressL + pressR) / 2
    const pucker = ema('pucker', g('mouthPucker'))
    const funnel = ema('funnel', g('mouthFunnel'))
    const shrugLower = ema('shrugLower', g('mouthShrugLower'))
    const cornerFrown = (frownL + frownR) / 2
    // MediaPipe's mouthFrown can miss a closed-lip pout, so frown evidence also
    // includes clear lip protrusion/funneling while suppressing it during actual
    // smiles. Plain lip pressure is deliberately excluded: relaxed closed lips
    // can press together naturally and should not read as frowning.
    const smileSuppression = 1 - clamp01(((smileL + smileR) / 2 - 0.25) / 0.45)
    const poutShape = Math.max(pucker * 0.55, funnel * 0.5, shrugLower * 0.6)
    const cornerSupport = clamp01((cornerFrown - 0.006) / 0.035)
    const pressPenalty = clamp01(1 - Math.max(0, lipPress - 0.22) / 0.25)
    const poutClarity = clamp01((poutShape - 0.045) / 0.09) * Math.max(0.45, cornerSupport) * pressPenalty
    const poutFrown = poutShape * poutClarity * smileSuppression
    const frown = Math.max(cornerFrown, poutFrown)
    const upperUpL = ema('upperUpL', g('mouthUpperUpLeft'))
    const upperUpR = ema('upperUpR', g('mouthUpperUpRight'))
    const jawOpen = ema('jawOpen', g('jawOpen'))
    const lowerDownL = ema('lowerDownL', g('mouthLowerDownLeft'))
    const lowerDownR = ema('lowerDownR', g('mouthLowerDownRight'))
    // Openness: how much the smile bares teeth (the reward-smile separator).
    const openness =
      (upperUpL + upperUpR) / 2 + jawOpen * 0.8 + ((lowerDownL + lowerDownR) / 2) * 0.8
    // Combined smile + lip-press asymmetry, relative to how strong the smile
    // is (the dominance-smile separator).
    const asymmetry = Math.abs(smileL - smileR) + Math.abs(pressL - pressR)
    const relAsymmetry = asymmetry / Math.max(0.3, Math.max(smileL, smileR))
    const eyeSquintL = ema('eyeSquintL', g('eyeSquintLeft'))
    const eyeSquintR = ema('eyeSquintR', g('eyeSquintRight'))
    const cheekSquintL = ema('cheekSquintL', g('cheekSquintLeft'))
    const cheekSquintR = ema('cheekSquintR', g('cheekSquintRight'))
    // Kept for logging/telemetry even though it no longer drives the
    // classifier (unreliable on lab webcams — see calibration note above).
    const eyeConstriction = ema(
      'eye',
      (g('eyeSquintLeft') + g('eyeSquintRight') + g('cheekSquintLeft') + g('cheekSquintRight')) / 4,
    )
    const smoothedGeometry: GeometryFrame | null = geometry
      ? {
          cornerSpreadX: ema('geoSpreadX', geometry.cornerSpreadX),
          cornerLiftY: ema('geoLiftY', geometry.cornerLiftY),
          lowerLipDropY: ema('geoLipDrop', geometry.lowerLipDropY),
          mouthOpenRatio: ema('geoOpenRatio', geometry.mouthOpenRatio),
          mouthWidthToFaceWidth: ema('geoMouthFace', geometry.mouthWidthToFaceWidth),
          mouthCornerTilt: ema('geoCornerTilt', geometry.mouthCornerTilt),
          yawSymmetry: ema('geoYawSymmetry', geometry.yawSymmetry),
          cheekRaiseY: ema('geoCheekRaise', geometry.cheekRaiseY),
          browRaiseY: ema('geoBrowRaise', geometry.browRaiseY),
          browGapX: ema('geoBrowGap', geometry.browGapX),
        }
      : null
    const smoothedFaceShape: FaceShapeMetrics | undefined = smoothedGeometry
      ? {
          mouthWidthToFaceWidth: round2(smoothedGeometry.mouthWidthToFaceWidth),
          mouthOpenRatio: round2(smoothedGeometry.mouthOpenRatio),
          mouthCornerTilt: round2(smoothedGeometry.mouthCornerTilt),
          yawSymmetry: round2(smoothedGeometry.yawSymmetry),
        }
      : undefined

    // Keep the smoothed raw scores around so calibration records every
    // blendshape the pipeline reads, not just the combined ones.
    this.lastBlendshapes = {}
    for (const key of BLENDSHAPE_KEYS) this.lastBlendshapes[key] = this.ema[EMA_KEY_FOR[key]] ?? 0

    // Talking: speech is a modulated mouth shape, an expression is a sustained
    // one. Both the mouth wobble and the microphone have to agree.
    const talking = smoothedGeometry
      ? this.talkingDetector.push(tsMs, smoothedGeometry.mouthOpenRatio, this.micRms)
      : this.talkingDetector.talking

    // ---- Per-person levels ----
    //
    // With a calibration profile, "smiling" means well past THIS person's own
    // resting noise, on their own neutral..max scale. Without one we fall back
    // to the global thresholds tuned against the lab's example photos.
    const profile = this.calibrationProfile
    const neutralScores = profile?.phases.neutral?.scores
    const T = DETECTION_TUNING
    let labelSmile: number
    let labelFrown: number
    let smileOn: number
    let smileOff: number
    let frownOn: number
    let frownOff: number
    let rewardOpenness: number

    if (profile && neutralScores) {
      labelSmile = normalizedLevel(smile, neutralScores.smile.mean, profile.derived.smile.range)
      labelFrown = normalizedLevel(frown, neutralScores.frown.mean, profile.derived.frown.range)
      // Smiling while talking is real and common, so the smile bar is only
      // raised. Frowning is suppressed outright below: the pout heuristic
      // fires on the pucker and funnel shapes of ordinary speech.
      smileOn = profile.derived.smile.deadZone * (talking ? T.talkingDeadZoneMultiplier : 1)
      smileOff = smileOn * 0.6
      frownOn = profile.derived.frown.deadZone
      frownOff = frownOn * 0.6
      rewardOpenness = normalizedLevel(
        openness,
        profile.derived.openness.neutral,
        Math.max(0.05, profile.derived.openness.max - profile.derived.openness.neutral),
      )
      if (
        exceedsCalibratedMax(smile, neutralScores.smile.mean, profile.derived.smile.range) &&
        !this.reportedExceeded
      ) {
        this.reportedExceeded = true
        console.info('[faceMorph] real smile exceeded the calibrated maximum')
      }
    } else {
      labelSmile = smile
      labelFrown = frown
      smileOn = T.smileOn
      smileOff = T.smileOff
      frownOn = T.frownOn
      frownOff = T.frownOff
      rewardOpenness = openness
    }

    // Label with hysteresis: harder to enter a state than to stay in it (the
    // "off" bar only applies to whichever state is currently published).
    //
    // Smile and frown are checked independently rather than smile-first: a
    // relaxed face's raw mouthSmile score can sit high enough that a fixed
    // smile-then-frown order could keep a stale "smiling" label (or block
    // "frowning" outright). When both cross their bar at once, trust whichever
    // is over it by the larger margin.
    const smileBar = this.publishedLabel === 'smiling' ? smileOff : smileOn
    const frownBar = this.publishedLabel === 'frowning' ? frownOff : frownOn
    const smileCandidate = labelSmile >= smileBar
    const frownCandidate = !talking && labelFrown >= frownBar
    let label: ExpressionLabel
    if (smileCandidate && frownCandidate) {
      label = labelSmile - smileBar >= labelFrown - frownBar ? 'smiling' : 'frowning'
    } else if (smileCandidate) {
      label = 'smiling'
    } else if (frownCandidate) {
      label = 'frowning'
    } else if (talking && this.publishedLabel === 'frowning') {
      // Do not let a frown published before speech started hang around.
      label = 'neutral'
    } else {
      label = 'neutral'
    }

    const labelConfidence = this.labelConfidence(label, labelSmile, labelFrown, {
      smileOn,
      smileOff,
      frownOn,
      frownOff,
    })
    let smileType: SmileType | null = null
    let smileTypeConfidence: number | undefined
    let subtypeUntrustworthy = false
    if (label === 'smiling') {
      const subtype = this.classifySmileSubtype(rewardOpenness, relAsymmetry, labelSmile)
      smileTypeConfidence = subtype.confidence
      if (subtype.confidence >= T.minPublishedSubtypeConfidence) {
        smileType = subtype.type
      } else {
        subtypeUntrustworthy = true
      }
    }

    // Debounce: a new label/sub-type must persist before it is published.
    if (label !== this.candidateLabel || smileType !== this.candidateType) {
      this.candidateLabel = label
      this.candidateType = smileType
      this.candidateSince = tsMs
    } else if (
      (label !== this.publishedLabel || smileType !== this.publishedType) &&
      tsMs - this.candidateSince >= T.debounceMs
    ) {
      this.publishedLabel = label
      this.publishedType = smileType
    }

    this.lastExpression = {
      label: this.publishedLabel,
      smileType: this.publishedLabel === 'smiling' ? this.publishedType : null,
      smile: round2(smile),
      frown: round2(frown),
      asymmetry: round2(relAsymmetry),
      eyeConstriction: round2(eyeConstriction),
      lipPress: round2(lipPress),
      openness: round2(openness),
      faceShape: smoothedFaceShape,
      normalizedSmile: profile ? round2(labelSmile) : undefined,
      normalizedFrown: profile ? round2(labelFrown) : undefined,
      normalizedOpenness: profile ? round2(rewardOpenness) : undefined,
      smileMargin: profile ? round2(labelSmile - smileOn) : undefined,
      frownMargin: profile ? round2(labelFrown - frownOn) : undefined,
      normalizationApplied: !!profile,
      normalizationVersion: profile?.version,
      geometricSmileLevel:
        profile && smoothedGeometry
          ? round2(geometricLevel(profile, smoothedGeometry, 'smile'))
          : undefined,
      geometricFrownLevel:
        profile && smoothedGeometry
          ? round2(geometricLevel(profile, smoothedGeometry, 'frown'))
          : undefined,
      talking,
      labelConfidence: round2(labelConfidence),
      smileTypeConfidence:
        this.publishedLabel === 'smiling' && this.publishedType ? round2(smileTypeConfidence ?? 0) : undefined,
      smileTypeTrusted:
        this.publishedLabel === 'smiling'
          ? !subtypeUntrustworthy && this.publishedType !== null && (smileTypeConfidence ?? 0) > 0
          : undefined,
      classifierMode: CLASSIFIER_MODE,
      classifierVersion: profile ? NORMALIZED_CLASSIFIER_VERSION : CLASSIFIER_VERSION,
      rawMouthSmileLeft: round2(smileL),
      rawMouthSmileRight: round2(smileR),
      rawMouthFrownLeft: round2(frownL),
      rawMouthFrownRight: round2(frownR),
      rawLipPressLeft: round2(pressL),
      rawLipPressRight: round2(pressR),
      rawUpperLipRaiseLeft: round2(upperUpL),
      rawUpperLipRaiseRight: round2(upperUpR),
      rawJawOpen: round2(jawOpen),
      rawLowerLipDropLeft: round2(lowerDownL),
      rawLowerLipDropRight: round2(lowerDownR),
      rawEyeSquintLeft: round2(eyeSquintL),
      rawEyeSquintRight: round2(eyeSquintR),
      rawCheekSquintLeft: round2(cheekSquintL),
      rawCheekSquintRight: round2(cheekSquintR),
    }
  }

  private labelConfidence(
    label: ExpressionLabel,
    smile: number,
    frown: number,
    thresholds = {
      smileOn: DETECTION_TUNING.smileOn,
      smileOff: DETECTION_TUNING.smileOff,
      frownOn: DETECTION_TUNING.frownOn,
      frownOff: DETECTION_TUNING.frownOff,
    },
  ): number {
    if (label === 'smiling') {
      return clamp01(
        (smile - thresholds.smileOff) / Math.max(0.01, thresholds.smileOn - thresholds.smileOff),
      )
    }
    if (label === 'frowning') {
      return clamp01(
        (frown - thresholds.frownOff) / Math.max(0.01, thresholds.frownOn - thresholds.frownOff),
      )
    }
    const smilePressure = smile / Math.max(0.01, thresholds.smileOn)
    const frownPressure = frown / Math.max(0.01, thresholds.frownOn)
    return clamp01(1 - Math.max(smilePressure, frownPressure))
  }

  private classifySmileSubtype(
    openness: number,
    relAsymmetry: number,
    smile: number,
  ): { type: SmileType; confidence: number } {
    const T = DETECTION_TUNING
    const rewardEvidence = openness / Math.max(0.01, T.rewardOpenness)
    const dominanceEvidence = relAsymmetry / Math.max(0.01, T.dominanceRelAsymmetry)

    if (rewardEvidence >= 1) {
      return { type: 'reward', confidence: clamp01(0.65 + (rewardEvidence - 1) * 0.25) }
    }
    if (dominanceEvidence >= 1) {
      return { type: 'dominance', confidence: clamp01(0.65 + (dominanceEvidence - 1) * 0.25) }
    }

    // Affiliative is the most dangerous bucket to over-claim. Confidence is
    // highest when the smile is strong and both reward/dominance evidence are
    // comfortably below their thresholds.
    const nearOtherSubtype = Math.max(rewardEvidence, dominanceEvidence)
    const smileStrength = clamp01((smile - T.smileOn) / 0.25)
    return {
      type: 'affiliative',
      confidence: clamp01(0.62 + smileStrength * 0.18 - nearOtherSubtype * 0.25),
    }
  }

  /**
   * Landmark geometry for one frame, normalized by face width so it does not
   * change when the participant leans toward or away from the camera. This is
   * what calibration measures the morph in — blendshape scores describe how
   * much of an expression is present, not how far the mouth actually moved.
   */
  private computeGeometry(toPx: (i: number) => Pt): GeometryFrame {
    const lc = toPx(LEFT_CORNER)
    const rc = toPx(RIGHT_CORNER)
    const upperLip = toPx(UPPER_INNER_LIP)
    const lowerLip = toPx(LOWER_INNER_LIP)
    const lowerLipCenter = toPx(LOWER_LIP_CENTER)
    const lEye = toPx(LEFT_OUTER_EYE)
    const rEye = toPx(RIGHT_OUTER_EYE)
    const nose = toPx(NOSE_TIP)
    const lEdge = toPx(LEFT_FACE_EDGE)
    const rEdge = toPx(RIGHT_FACE_EDGE)

    const faceWidth = Math.max(1e-3, distance(lEdge, rEdge))
    const mouthWidth = distance(lc, rc)
    const cornerMeanY = (lc.y + rc.y) / 2
    const eyeMeanY = (lEye.y + rEye.y) / 2
    const cheekMeanY = (toPx(LEFT_CHEEK).y + toPx(RIGHT_CHEEK).y) / 2
    const browMeanY = (toPx(LEFT_BROW_MID).y + toPx(RIGHT_BROW_MID).y) / 2
    const mouthOpen = Math.abs(lowerLip.y - upperLip.y)
    const dl = Math.abs(nose.x - lEdge.x)
    const dr = Math.abs(rEdge.x - nose.x)

    return {
      cornerSpreadX: Math.abs(rc.x - lc.x) / faceWidth,
      // Corners rising toward the eyes makes this grow, in image coordinates
      // where y increases downward.
      cornerLiftY: (eyeMeanY - cornerMeanY) / faceWidth,
      lowerLipDropY: (lowerLipCenter.y - cornerMeanY) / faceWidth,
      mouthOpenRatio: safeRatio(mouthOpen, mouthWidth),
      mouthWidthToFaceWidth: mouthWidth / faceWidth,
      mouthCornerTilt: safeRatio(Math.abs(lc.y - rc.y), mouthWidth),
      yawSymmetry: Math.min(dl, dr) / Math.max(1e-3, Math.max(dl, dr)),
      // How the rest of the face moves with the expression. Same face-width
      // normalization, so these are comparable across people and distances.
      cheekRaiseY: (cheekMeanY - eyeMeanY) / faceWidth,
      browRaiseY: (eyeMeanY - browMeanY) / faceWidth,
      browGapX: Math.abs(toPx(RIGHT_BROW_INNER).x - toPx(LEFT_BROW_INNER).x) / faceWidth,
    }
  }

  // ---- Warp ----

  /** Calibrated warp geometry with the cheek/brow tuning multiplier applied. */
  private morphDirection(strength: number) {
    const d = morphDirectionFor(this.calibrationProfile, strength)
    const k = this.faceCouplingScale
    if (k === 1) return d
    return {
      ...d,
      cheekRise: d.cheekRise * k,
      browRise: d.browRise * k,
      browFurrow: d.browFurrow * k,
    }
  }

  /**
   * Mesh-warp the ROI. `strength` is alpha after yaw attenuation:
   * positive → smile (corners out+up), negative → frown (parabolic, pout).
   */
  /**
   * Warp the ROI. `strength` is the capped alpha after the head-turn and
   * open-mouth fades: positive → smile, negative → frown.
   *
   * When this person's cheeks and brows move with their expression, all of it
   * is one continuous field over one mesh. That matters: a mouth that moves
   * while the cheek just above it stays frozen is what reads as fake, and two
   * separate patches would leave exactly that frozen band between them.
   */
  private warp(
    ctx: CanvasRenderingContext2D,
    roi: { x: number; y: number; w: number; h: number },
    a: FaceAnchors,
    mouthWidth: number,
    strength: number,
    couples: boolean,
  ) {
    const sigmaY = mouthWidth * 0.6
    const smiling = strength > 0
    const mag = Math.abs(strength) * mouthWidth
    // Corner travel and direction come from this participant's calibration, so
    // the same alpha moves a small mouth and a wide one by their own amounts.
    const { cornerTravel, cornerAngleRad, poutDrop, cheekRise, browRise, browFurrow } =
      this.morphDirection(strength)
    const travelX = Math.cos(cornerAngleRad)
    const travelY = -Math.sin(cornerAngleRad)
    // The lower-lip pout centre sits slightly below the mouth line.
    const poutY = a.mouthCenterY + mouthWidth * 0.22
    const poutSigma = mouthWidth * 0.35

    // Spread of each off-mouth contribution. Kept fairly tight so the movement
    // stays where it belongs instead of sliding the whole face around.
    const cheekSigma = mouthWidth * 0.55
    const browSigmaX = mouthWidth * 0.6
    const browSigmaY = mouthWidth * 0.3
    // Protected zone over each eye: wide enough to cover a spectacle lens,
    // shallow enough that the cheek below and brow above still move. Bending a
    // rigid glasses frame looks broken in a way a stiff cheek never does.
    const guardSigmaX = a.eyeWidth * 0.8
    const guardSigmaY = Math.max(a.eyeHeight * 1.3, a.eyeWidth * 0.42)
    const cols = couples ? 16 : this.cols
    const rows = couples ? 14 : this.rows

    this.meshWarp(ctx, roi, cols, rows, (sx, sy, u, v) => {
      // Horizontal position relative to mouth center, normalised to corners.
      const xn = (sx - a.mouthCenterX) / (mouthWidth / 2)
      // Vertical gaussian falloff around the mouth line.
      const vy = Math.exp(-((sy - a.mouthCenterY) ** 2) / (2 * sigmaY * sigmaY))
      // Edge window → 0 at ROI border so the warp blends seamlessly.
      const win = Math.sin(Math.PI * u) * Math.sin(Math.PI * v)
      // Corner weight: strongest at the mouth corners (xn² → 1), ~0 mid-mouth.
      const cornerW = Math.min(1.6, xn * xn) * vy * win

      // ---- Mouth: one formula for both directions, since the calibrated
      // angle already points out+up for a smile and down+in for a frown. ----
      const d = mag * cornerTravel * cornerW
      let dx = Math.sign(xn) * travelX * d
      let dy = travelY * d
      if (!smiling) {
        // The centre of the lower lip also drops → a parabolic mouth with a
        // hint of protruding lower lip, not a straight shift.
        const centerW = Math.max(0, 1 - xn * xn)
        const vb = Math.exp(-((sy - poutY) ** 2) / (2 * poutSigma * poutSigma))
        dy += mag * poutDrop * centerW * vb * win
      }

      if (!couples) return { x: dx, y: dy }

      // ---- Everything above the mouth, held off the eyes themselves. ----
      const guard = clamp01(
        1 -
          gauss2(sx - a.leftEye.x, sy - a.leftEye.y, guardSigmaX, guardSigmaY) -
          gauss2(sx - a.rightEye.x, sy - a.rightEye.y, guardSigmaX, guardSigmaY),
      )
      const coupled = win * guard

      // Cheeks rise toward the eyes.
      if (cheekRise !== 0) {
        const w =
          gauss2(sx - a.leftCheek.x, sy - a.leftCheek.y, cheekSigma, cheekSigma) +
          gauss2(sx - a.rightCheek.x, sy - a.rightCheek.y, cheekSigma, cheekSigma)
        dy -= mag * cheekRise * Math.min(1, w) * coupled
      }

      // Brows rise or drop, whichever this person actually does, and pull
      // toward each other for a frown.
      if (browRise !== 0 || browFurrow !== 0) {
        const wl = gauss2(sx - a.leftBrow.x, sy - a.leftBrow.y, browSigmaX, browSigmaY)
        const wr = gauss2(sx - a.rightBrow.x, sy - a.rightBrow.y, browSigmaX, browSigmaY)
        const w = Math.min(1, wl + wr)
        dy -= mag * browRise * w * coupled
        if (browFurrow !== 0) {
          // Each brow moves toward the midline between them.
          const midX = (a.leftBrow.x + a.rightBrow.x) / 2
          dx += Math.sign(midX - sx) * mag * browFurrow * w * coupled
        }
      }

      return { x: dx, y: dy }
    })
  }

  /** Shared grid-warp mechanics: build a uniform grid over `roi`, displace each
   * point per `displace`, and mesh-triangulate source → displaced destination. */
  private meshWarp(
    ctx: CanvasRenderingContext2D,
    roi: { x: number; y: number; w: number; h: number },
    cols: number,
    rows: number,
    displace: (sx: number, sy: number, u: number, v: number) => Pt,
  ) {
    const srcPts: Pt[] = []
    const dstPts: Pt[] = []
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const u = c / cols
        const v = r / rows
        const sx = roi.x + u * roi.w
        const sy = roi.y + v * roi.h
        srcPts.push({ x: sx, y: sy })
        const d = displace(sx, sy, u, v)
        dstPts.push({ x: sx + d.x, y: sy + d.y })
      }
    }

    const idx = (r: number, c: number) => r * (cols + 1) + c
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = idx(r, c)
        const b = idx(r, c + 1)
        const d = idx(r + 1, c)
        const e = idx(r + 1, c + 1)
        this.drawTriangle(ctx, srcPts[a], srcPts[b], srcPts[d], dstPts[a], dstPts[b], dstPts[d])
        this.drawTriangle(ctx, srcPts[b], srcPts[e], srcPts[d], dstPts[b], dstPts[e], dstPts[d])
      }
    }
  }

  /** Affine-map source triangle → destination triangle and draw it (clipped). */
  private drawTriangle(
    ctx: CanvasRenderingContext2D,
    s0: Pt, s1: Pt, s2: Pt,
    d0: Pt, d1: Pt, d2: Pt,
  ) {
    ctx.save()
    // Slightly expand the dest triangle to hide seams between triangles.
    const cx = (d0.x + d1.x + d2.x) / 3
    const cy = (d0.y + d1.y + d2.y) / 3
    const grow = 0.6
    const g = (p: Pt): Pt => ({
      x: p.x + (p.x - cx === 0 ? 0 : Math.sign(p.x - cx) * grow),
      y: p.y + (p.y - cy === 0 ? 0 : Math.sign(p.y - cy) * grow),
    })
    const e0 = g(d0)
    const e1 = g(d1)
    const e2 = g(d2)

    ctx.beginPath()
    ctx.moveTo(e0.x, e0.y)
    ctx.lineTo(e1.x, e1.y)
    ctx.lineTo(e2.x, e2.y)
    ctx.closePath()
    ctx.clip()

    // Affine transform mapping s → d.
    const denom =
      s0.x * (s2.y - s1.y) - s1.x * s2.y + s2.x * s1.y + (s1.x - s2.x) * s0.y
    if (Math.abs(denom) < 1e-6) {
      ctx.restore()
      return
    }
    const m11 =
      -(s0.y * (d2.x - d1.x) - s1.y * d2.x + s2.y * d1.x + (s1.y - s2.y) * d0.x) /
      denom
    const m12 =
      (s1.y * d2.y + s0.y * (d1.y - d2.y) - s2.y * d1.y + (s2.y - s1.y) * d0.y) /
      denom
    const m21 =
      (s0.x * (d2.x - d1.x) - s1.x * d2.x + s2.x * d1.x + (s1.x - s2.x) * d0.x) /
      denom
    const m22 =
      -(s1.x * d2.y + s0.x * (d1.y - d2.y) - s2.x * d1.y + (s2.x - s1.x) * d0.y) /
      denom
    const dx =
      (s0.x * (s2.y * d1.x - s1.y * d2.x) +
        s0.y * (s1.x * d2.x - s2.x * d1.x) +
        (s2.x * s1.y - s1.x * s2.y) * d0.x) /
      denom
    const dy =
      (s0.x * (s2.y * d1.y - s1.y * d2.y) +
        s0.y * (s1.x * d2.y - s2.x * d1.y) +
        (s2.x * s1.y - s1.x * s2.y) * d0.y) /
      denom

    ctx.setTransform(m11, m12, m21, m22, dx, dy)
    ctx.drawImage(this.src, 0, 0)
    ctx.restore()
  }

  close() {
    this.landmarker?.close()
    this.landmarker = null
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** Elliptical gaussian, 1 at the centre and falling off faster on the tight axis. */
function gauss2(dx: number, dy: number, sigmaX: number, sigmaY: number): number {
  const sx = Math.max(1e-3, sigmaX)
  const sy = Math.max(1e-3, sigmaY)
  return Math.exp(-((dx * dx) / (2 * sx * sx) + (dy * dy) / (2 * sy * sy)))
}

function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 1e-6) {
    return 0
  }
  return numerator / denominator
}
