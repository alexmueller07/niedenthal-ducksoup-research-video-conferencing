// Real-time facial smile morph using in-browser face-landmark detection.
//
// This is the Windows/no-backend path. MediaPipe FaceLandmarker (WASM) detects
// the 468-point face mesh each frame; we warp a grid over the mouth region so the
// mouth corners lift (smile) or drop (frown) with the alpha control. Unlike a
// blind frame warp, this tracks the actual mouth, so it reads as an expression
// change rather than video glitch, and it does nothing when no face is found.
//
// On lab hardware the genuine Mozza/dlib transformation replaces this; the
// control (`alpha`) is the same, so the experimenter UX is identical.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// Loaded from CDN for the demo (needs internet at first run). For an offline lab
// build, vendor these two assets locally and point these at the local paths.
const WASM_BASE =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// Outer-lip landmark indices (MediaPipe FaceMesh) used to bound the mouth ROI.
const LIP_INDICES = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37,
  39, 40, 185,
]
const LEFT_CORNER = 61
const RIGHT_CORNER = 291

interface Pt {
  x: number
  y: number
}

export class FaceMorphProcessor {
  private landmarker: FaceLandmarker | null = null
  private src: HTMLCanvasElement // holds the raw frame for sampling
  private srcCtx: CanvasRenderingContext2D
  private alpha = 1.0
  private cols = 12
  private rows = 8
  private lastFaceFound = false

  constructor() {
    this.src = document.createElement('canvas')
    const ctx = this.src.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    this.srcCtx = ctx
  }

  async init(): Promise<void> {
    const fileset = await FilesetResolver.forVisionTasks(WASM_BASE)
    this.landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
    })
  }

  setAlpha(alpha: number) {
    this.alpha = alpha
  }

  get ready() {
    return this.landmarker !== null
  }

  get faceFound() {
    return this.lastFaceFound
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

    if (!this.landmarker || Math.abs(this.alpha - 1) < 0.02) {
      this.lastFaceFound = false
      return false
    }

    let result
    try {
      result = this.landmarker.detectForVideo(video, tsMs)
    } catch {
      return false
    }
    const faces = result?.faceLandmarks
    if (!faces || faces.length === 0) {
      this.lastFaceFound = false
      return false
    }
    this.lastFaceFound = true

    const lm = faces[0]
    const toPx = (i: number): Pt => ({ x: lm[i].x * width, y: lm[i].y * height })

    // Mouth geometry.
    const lc = toPx(LEFT_CORNER)
    const rc = toPx(RIGHT_CORNER)
    const centerX = (lc.x + rc.x) / 2
    const centerY = (lc.y + rc.y) / 2
    const mouthWidth = Math.hypot(rc.x - lc.x, rc.y - lc.y)

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

    // Smile strength in pixels. alpha>1 lifts corners, alpha<1 drops them.
    const strength = (this.alpha - 1) * 0.14 * mouthWidth

    this.warp(dstCtx, roi, centerX, centerY, mouthWidth, strength)
    return true
  }

  /** Mesh-warp the ROI; mouth corners displaced vertically by `strength`. */
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
        // Corners (xn^2 → 1) lift more than centre.
        const dy = -strength * Math.min(1.6, xn * xn) * vy * win
        dstPts.push({ x: sx, y: sy + dy })
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
