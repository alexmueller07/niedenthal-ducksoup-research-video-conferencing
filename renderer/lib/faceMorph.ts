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
import type { ExpressionLabel, ExpressionState, SmileType } from './protocol'

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
// Yaw estimation: nose tip vs. the two face-oval cheek extremes.
const NOSE_TIP = 1
const LEFT_FACE_EDGE = 234
const RIGHT_FACE_EDGE = 454

// ---- Morph tuning (calibrate with Randy; all displacements scale with mouth width) ----
const SMILE_ANGLE_RAD = (25 * Math.PI) / 180 // corners move out+up at ~25° above horizontal
const SMILE_GAIN = 0.17 // total corner travel per unit of (alpha - 1)
const FROWN_GAIN = 0.13 // corner-down travel per unit of (1 - alpha)
const FROWN_INWARD = 0.25 // slight inward pull of the corners while frowning
const FROWN_POUT = 0.5 // lower-lip-centre drop relative to corner drop
const ALPHA_TWEEN_TAU_MS = 350 // preset transitions ease in over ~1 s
// Below this left/right face-half symmetry the morph fades out (side profile).
const YAW_FADE_START = 0.65
const YAW_FADE_END = 0.35

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
  frownOn: 0.08,
  frownOff: 0.04,
  /** A frown only counts while the smile signal is below this. */
  frownSmileGate: 0.15,
  /** Openness (upper-lip raise + jaw + lower-lip drop) above this → reward. */
  rewardOpenness: 0.2,
  /** Relative L/R asymmetry (smile + lip press, ÷ smile level) above this → dominance. */
  dominanceRelAsymmetry: 0.12,
  /** EMA time constant for blendshape smoothing. */
  emaTauMs: 220,
  /** A new label/sub-type must persist this long before it is published. */
  debounceMs: 350,
}

interface Pt {
  x: number
  y: number
}

export class FaceMorphProcessor {
  private landmarker: FaceLandmarker | null = null
  private src: HTMLCanvasElement // holds the raw frame for sampling
  private srcCtx: CanvasRenderingContext2D
  private alphaTarget = 1.0
  private alphaCurrent = 1.0
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
        this.updateExpressionFromRaw(tsMs, null)
      }
      return false
    }
    this.lastFaceFound = true
    this.lastFaceTs = tsMs

    this.updateExpressionFromRaw(tsMs, result.faceBlendshapes?.[0]?.categories ?? null)

    if (Math.abs(this.alphaCurrent - 1) < 0.02) return false

    const lm = faces[0]
    const toPx = (i: number): Pt => ({ x: lm[i].x * width, y: lm[i].y * height })

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

    // ROI bounding box over the lips, expanded to include surrounding skin so
    // the warp blends naturally.
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const i of LIP_INDICES) {
      const p = toPx(i)
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    const padX = mouthWidth * 0.55
    const padY = mouthWidth * 0.7
    const roi = {
      x: Math.max(0, minX - padX),
      y: Math.max(0, minY - padY),
      w: Math.min(width, maxX + padX) - Math.max(0, minX - padX),
      h: Math.min(height, maxY + padY) - Math.max(0, minY - padY),
    }

    this.warp(dstCtx, roi, centerX, centerY, mouthWidth, (this.alphaCurrent - 1) * yawScale)
    return true
  }

  // ---- Expression detection ----

  private updateExpressionFromRaw(
    tsMs: number,
    categories: Array<{ categoryName: string; score: number }> | null,
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

    const smileL = ema('smileL', g('mouthSmileLeft'))
    const smileR = ema('smileR', g('mouthSmileRight'))
    const smile = (smileL + smileR) / 2
    const frown = ema('frown', (g('mouthFrownLeft') + g('mouthFrownRight')) / 2)
    const pressL = ema('pressL', g('mouthPressLeft'))
    const pressR = ema('pressR', g('mouthPressRight'))
    const lipPress = (pressL + pressR) / 2
    // Openness: how much the smile bares teeth (the reward-smile separator).
    const openness = ema(
      'open',
      (g('mouthUpperUpLeft') + g('mouthUpperUpRight')) / 2 +
        g('jawOpen') * 0.8 +
        ((g('mouthLowerDownLeft') + g('mouthLowerDownRight')) / 2) * 0.8,
    )
    // Combined smile + lip-press asymmetry, relative to how strong the smile
    // is (the dominance-smile separator).
    const asymmetry = Math.abs(smileL - smileR) + Math.abs(pressL - pressR)
    const relAsymmetry = asymmetry / Math.max(0.3, Math.max(smileL, smileR))
    // Kept for logging/telemetry even though it no longer drives the
    // classifier (unreliable on lab webcams — see calibration note above).
    const eyeConstriction = ema(
      'eye',
      (g('eyeSquintLeft') + g('eyeSquintRight') + g('cheekSquintLeft') + g('cheekSquintRight')) / 4,
    )

    // Label with hysteresis: harder to enter a state than to stay in it. A
    // frown needs the smile signal gone (a relaxed face can score smile ≈ 0.5).
    const T = DETECTION_TUNING
    const frowning = (on: boolean) =>
      frown >= (on ? T.frownOn : T.frownOff) && smile < T.frownSmileGate
    let label: ExpressionLabel = this.publishedLabel
    if (this.publishedLabel === 'smiling') {
      label = smile >= T.smileOff ? 'smiling' : frowning(true) ? 'frowning' : 'neutral'
    } else if (this.publishedLabel === 'frowning') {
      label = frowning(false) ? 'frowning' : smile >= T.smileOn ? 'smiling' : 'neutral'
    } else {
      label = smile >= T.smileOn ? 'smiling' : frowning(true) ? 'frowning' : 'neutral'
    }

    let smileType: SmileType | null = null
    if (label === 'smiling') {
      if (openness >= T.rewardOpenness) smileType = 'reward'
      else if (relAsymmetry >= T.dominanceRelAsymmetry) smileType = 'dominance'
      else smileType = 'affiliative'
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
    }
  }

  // ---- Warp ----

  /**
   * Mesh-warp the ROI. `strength` is (alpha − 1) after yaw attenuation:
   * positive → smile (corners out+up), negative → frown (parabolic, pout).
   */
  private warp(
    ctx: CanvasRenderingContext2D,
    roi: { x: number; y: number; w: number; h: number },
    centerX: number,
    centerY: number,
    mouthWidth: number,
    strength: number,
  ) {
    const { cols, rows } = this
    const srcPts: Pt[] = []
    const dstPts: Pt[] = []
    const sigmaY = mouthWidth * 0.6
    const smiling = strength > 0
    const mag = Math.abs(strength) * mouthWidth
    // The lower-lip pout centre sits slightly below the mouth line.
    const poutY = centerY + mouthWidth * 0.22
    const poutSigma = mouthWidth * 0.35

    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const u = c / cols
        const v = r / rows
        const sx = roi.x + u * roi.w
        const sy = roi.y + v * roi.h
        srcPts.push({ x: sx, y: sy })

        // Horizontal position relative to mouth center, normalised to corners.
        const xn = (sx - centerX) / (mouthWidth / 2)
        // Vertical gaussian falloff around the mouth line.
        const vy = Math.exp(-((sy - centerY) ** 2) / (2 * sigmaY * sigmaY))
        // Edge window → 0 at ROI border so the warp blends seamlessly.
        const win = Math.sin(Math.PI * u) * Math.sin(Math.PI * v)
        // Corner weight: strongest at the mouth corners (xn² → 1), ~0 mid-mouth.
        const cornerW = Math.min(1.6, xn * xn) * vy * win

        let dx = 0
        let dy = 0
        if (smiling) {
          // Corners travel out+up at ~25° above horizontal — out first, then up
          // (RA feedback: straight-vertical lift looked unnatural).
          const d = mag * SMILE_GAIN * cornerW
          dx = Math.sign(xn) * Math.cos(SMILE_ANGLE_RAD) * d
          dy = -Math.sin(SMILE_ANGLE_RAD) * d
        } else {
          // Frown: outer nodes pull down and slightly inward…
          const d = mag * FROWN_GAIN * cornerW
          dx = -Math.sign(xn) * FROWN_INWARD * d
          dy = d
          // …while the centre of the lower lip drops a little → a parabolic
          // mouth with a hint of protruding lower lip, not a straight shift.
          const centerW = Math.max(0, 1 - xn * xn)
          const vb = Math.exp(-((sy - poutY) ** 2) / (2 * poutSigma * poutSigma))
          dy += mag * FROWN_GAIN * FROWN_POUT * centerW * vb * win
        }
        dstPts.push({ x: sx + dx, y: sy + dy })
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
