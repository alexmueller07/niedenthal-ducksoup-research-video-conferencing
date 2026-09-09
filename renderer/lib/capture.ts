// CaptureStation: the self-contained, single-person capture engine.
//
// Owns the camera, runs the facial morph (canvas), renders the participant-
// facing "altered" view, and records both the clean and altered streams. On
// start, it also runs an automatic neutral/smile/frown setup check (see
// runCalibration below) before recording begins, so detection is judged
// against this person's own baseline rather than generic thresholds. It works
// in a plain browser (records download to disk) and in Electron (records save
// to a structured session folder via window.ipc).
//
// Deliberately no cross-window IPC bus: one page owns everything, which is
// simpler and does not crash outside Electron.

import { FaceMorphProcessor } from './faceMorph'
import { getPreset } from './presets'
import { pickRecorderFormat, type RecorderFormat } from './recording'
import {
  CALIBRATION_STEPS,
  CALIBRATION_PROMPTS,
  CALIBRATION_PREP_MS,
  CALIBRATION_COLLECT_MS,
  CALIBRATION_SAMPLE_MS,
  CALIBRATION_READY_TIMEOUT_MS,
  CALIBRATION_MAX_AUTO_RETRIES,
  CALIBRATION_RETRY_PAUSE_MS,
  calibrationStepReadiness,
  summarizeCalibrationStep,
  buildExpressionCalibrationProfile,
  type CalibrationSample,
} from './calibration'
import type { ExpressionState, CalibrationStep, CalibrationStepResult, Telemetry } from './protocol'
import type {
  ConnectionStatus,
  RecordingFile,
  RecordingStatus,
  SessionConfig,
  SessionManifest,
} from './types'

const APP_NAME = 'DuckSoup Experimenter Platform'
const APP_VERSION = '2.0.0'

type LogLevel = 'info' | 'warn' | 'error' | 'success'

export interface CaptureCallbacks {
  onStatus: (connection: ConnectionStatus, recording: RecordingStatus) => void
  onLog: (message: string, level?: LogLevel) => void
  onTime: (seconds: number) => void
  onSaved: (manifest: SessionManifest) => void
  onFaceState?: (found: boolean) => void
  onExpression?: (state: ExpressionState) => void
  /** Progress text during the automatic setup-check calibration, or null when not calibrating. */
  onCalibrationStatus?: (text: string | null) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function hasIpc(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { ipc?: unknown }).ipc !== 'undefined'
}

export class CaptureStation {
  private cleanVideo: HTMLVideoElement
  private alteredCanvas: HTMLCanvasElement
  private alteredCtx: CanvasRenderingContext2D
  private hiddenVideo: HTMLVideoElement // raw camera source for morphing
  private cb: CaptureCallbacks

  private camera: MediaStream | null = null
  private alteredStream: MediaStream | null = null
  private face = new FaceMorphProcessor()
  private raf: number | null = null

  private alteredRecorder: MediaRecorder | null = null
  private cleanRecorder: MediaRecorder | null = null
  private alteredChunks: Blob[] = []
  private cleanChunks: Blob[] = []
  private recFormat: RecorderFormat = { mimeType: 'video/webm', ext: 'webm' }
  private timer: ReturnType<typeof setInterval> | null = null
  private elapsed = 0
  private startedAt: string | null = null

  private config: SessionConfig | null = null
  private alpha = 0
  private overlay = false
  private lastExpressionKey = ''

  private connection: ConnectionStatus = 'disconnected'
  private recording: RecordingStatus = 'idle'

  constructor(
    cleanVideo: HTMLVideoElement,
    alteredCanvas: HTMLCanvasElement,
    hiddenVideo: HTMLVideoElement,
    cb: CaptureCallbacks,
  ) {
    this.cleanVideo = cleanVideo
    this.alteredCanvas = alteredCanvas
    this.hiddenVideo = hiddenVideo
    const ctx = alteredCanvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    this.alteredCtx = ctx
    this.cb = cb
  }

  private log(message: string, level: LogLevel = 'info') {
    this.cb.onLog(message, level)
  }
  private emit() {
    this.cb.onStatus(this.connection, this.recording)
  }

  setConfig(config: SessionConfig) {
    this.config = config
    const p = getPreset(config.presetId)
    this.setAlpha(p.alpha)
  }
  setAlpha(alpha: number) {
    this.alpha = alpha
    this.face.setAlpha(alpha)
  }
  setOverlay(on: boolean) {
    this.overlay = on
  }

  async start() {
    if (this.connection !== 'disconnected') return
    this.connection = 'connecting'
    this.emit()
    this.log('Loading face-landmark model…')

    try {
      await this.face.init()
      this.log('Face-landmark model ready', 'success')
    } catch (err) {
      this.log(`Face model failed to load (continuing without morph): ${err}`, 'warn')
    }

    try {
      this.camera = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720 },
        audio: true,
      })
    } catch (err) {
      this.connection = 'error'
      this.emit()
      this.log(`Could not access camera/mic: ${err}`, 'error')
      return
    }

    this.cleanVideo.srcObject = this.camera
    await this.cleanVideo.play().catch(() => {})
    this.hiddenVideo.srcObject = this.camera
    await this.hiddenVideo.play().catch(() => {})

    const settings = this.camera.getVideoTracks()[0]?.getSettings()
    const w = settings?.width ?? 1280
    const h = settings?.height ?? 720
    this.alteredCanvas.width = w
    this.alteredCanvas.height = h

    // Altered stream = morphed canvas video + raw mic audio.
    const canvasStream = this.alteredCanvas.captureStream(30)
    this.alteredStream = new MediaStream([...canvasStream.getVideoTracks(), ...this.camera.getAudioTracks()])

    this.startRenderLoop(w, h)

    await this.runCalibration()

    this.connection = 'connected'
    this.emit()
    this.log('Capture station live', 'success')
    this.startRecording()
  }

  /**
   * Automatic neutral/smile/frown setup check, reusing the same pure logic the
   * three-seat app's waiting room uses (renderer/lib/calibration.ts) — sampled
   * directly from this.face.expression instead of over a websocket. There is no
   * researcher here to rescue a stuck participant, so a step that keeps failing
   * is skipped rather than blocked on: worse detection accuracy beats an app
   * that never starts.
   */
  private async runCalibration() {
    const results: Partial<Record<CalibrationStep, CalibrationStepResult>> = {}
    for (const step of CALIBRATION_STEPS) {
      const prompt = CALIBRATION_PROMPTS[step]
      const maxAttempts = CALIBRATION_MAX_AUTO_RETRIES + 1
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.cb.onCalibrationStatus?.(`Setting up: ${prompt.instruction}`)
        await sleep(CALIBRATION_PREP_MS)
        const result = await this.collectCalibrationStep(step)
        if (result.status === 'complete') {
          results[step] = result
          break
        }
        if (attempt < maxAttempts) {
          this.cb.onCalibrationStatus?.(`Setting up: let's try that again — ${prompt.instruction.toLowerCase()}`)
          await sleep(CALIBRATION_RETRY_PAUSE_MS)
          continue
        }
        this.log(`Setup check for "${step}" did not pass after retries — continuing without it`, 'warn')
        results[step] = result
      }
    }
    this.cb.onCalibrationStatus?.(null)

    const profile = buildExpressionCalibrationProfile(results)
    if (profile) {
      this.face.setCalibrationProfile(profile)
      this.log('Personal setup check applied', 'success')
    } else {
      this.log('Setup check incomplete — using default detection thresholds', 'warn')
    }
  }

  /** Samples this.face.expression every CALIBRATION_SAMPLE_MS until ready+held, or times out. */
  private collectCalibrationStep(step: CalibrationStep): Promise<CalibrationStepResult> {
    return new Promise((resolve) => {
      const requestId = `local_${Date.now()}`
      const samples: CalibrationSample[] = []
      let heldSamples: CalibrationSample[] = []
      let readyStartedAt: number | null = null
      const startedAt = performance.now()

      const finish = (fromHeld: boolean) => {
        clearInterval(interval)
        resolve(summarizeCalibrationStep(requestId, step, fromHeld ? heldSamples : samples))
      }

      const interval = setInterval(() => {
        const expression = this.face.expression
        const sample: CalibrationSample = {
          expression,
          telemetry: expression ? ({ faceFound: true } as Telemetry) : null,
        }
        samples.push(sample)
        const readiness = calibrationStepReadiness(step, sample)
        const elapsed = performance.now() - startedAt

        if (!readiness.ready) {
          readyStartedAt = null
          heldSamples = []
          if (elapsed >= CALIBRATION_READY_TIMEOUT_MS) finish(false)
          return
        }

        if (readyStartedAt === null) readyStartedAt = performance.now()
        heldSamples.push(sample)
        const heldMs = performance.now() - readyStartedAt
        if (heldMs >= CALIBRATION_COLLECT_MS) finish(true)
      }, CALIBRATION_SAMPLE_MS)
    })
  }

  private startRenderLoop(w: number, h: number) {
    let lastTs = -1
    const loop = () => {
      const ts = performance.now()
      const monotonic = ts <= lastTs ? lastTs + 1 : ts
      lastTs = monotonic
      const found = this.face.render(this.hiddenVideo, this.alteredCtx, w, h, monotonic)
      if (this.overlay) this.drawOverlay(w, h, found)
      this.cb.onFaceState?.(found)
      const expression = this.face.expression
      if (expression) {
        const key = [
          expression.label,
          expression.smileType ?? '',
          expression.smileTypeTrusted ? 'confident' : 'uncertain',
          Math.round((expression.labelConfidence ?? 0) * 20),
          Math.round((expression.smileTypeConfidence ?? 0) * 20),
          Math.round(expression.smile * 20),
          Math.round(expression.frown * 20),
        ].join('|')
        if (key !== this.lastExpressionKey) {
          this.lastExpressionKey = key
          this.cb.onExpression?.(expression)
        }
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  private drawOverlay(w: number, h: number, faceFound: boolean) {
    const ctx = this.alteredCtx
    ctx.save()
    ctx.fillStyle = faceFound ? 'rgba(40,160,90,0.85)' : 'rgba(180,60,60,0.85)'
    ctx.fillRect(0, 0, 168, 22)
    ctx.fillStyle = '#fff'
    ctx.font = '12px system-ui, sans-serif'
    ctx.fillText(`${faceFound ? 'face tracked' : 'no face'}  α=${this.alpha.toFixed(2)}`, 8, 15)
    ctx.restore()
  }

  startRecording() {
    if (this.connection !== 'connected' || !this.alteredStream || !this.camera) {
      this.log('Connect before recording', 'warn')
      return
    }
    this.alteredChunks = []
    this.cleanChunks = []
    this.recFormat = pickRecorderFormat(true)
    this.alteredRecorder = this.makeRecorder(this.alteredStream, this.alteredChunks)
    this.cleanRecorder = this.makeRecorder(this.camera, this.cleanChunks)
    this.startedAt = new Date().toISOString()
    this.alteredRecorder.start(1000)
    this.cleanRecorder.start(1000)
    this.recording = 'recording'
    this.elapsed = 0
    this.emit()
    this.log('Recording (clean + altered)', 'success')
    this.timer = setInterval(() => {
      this.elapsed += 1
      this.cb.onTime(this.elapsed)
    }, 1000)
  }

  private makeRecorder(stream: MediaStream, sink: Blob[]): MediaRecorder {
    const rec = new MediaRecorder(
      stream,
      this.recFormat.mimeType ? { mimeType: this.recFormat.mimeType } : undefined,
    )
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) sink.push(e.data)
    }
    return rec
  }

  async stopRecording() {
    if (this.recording !== 'recording') return
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.recording = 'saving'
    this.emit()
    this.log('Finalizing recordings…')

    const stoppedAt = new Date().toISOString()
    const altered = await this.finalize(this.alteredRecorder, this.alteredChunks)
    const clean = await this.finalize(this.cleanRecorder, this.cleanChunks)
    this.alteredRecorder = null
    this.cleanRecorder = null

    const blobType = this.recFormat.mimeType || 'video/webm'
    try {
      await this.saveSession(
        new Blob(altered, { type: blobType }),
        new Blob(clean, { type: blobType }),
        this.startedAt,
        stoppedAt,
      )
    } catch (err) {
      this.log(`Save failed: ${err}`, 'error')
    }
    this.recording = 'idle'
    this.emit()
  }

  private finalize(rec: MediaRecorder | null, sink: Blob[]): Promise<Blob[]> {
    return new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') return resolve(sink)
      rec.onstop = () => resolve(sink)
      rec.stop()
    })
  }

  private async saveSession(
    altered: Blob,
    clean: Blob,
    startedAt: string | null,
    stoppedAt: string,
  ) {
    const cfg = this.config!
    const preset = getPreset(cfg.presetId)
    const pairs: Array<['altered' | 'clean', Blob]> = [
      ['clean', clean],
      ['altered', altered],
    ]
    const files: RecordingFile[] = []

    if (hasIpc() && cfg.saveRoot) {
      const ipc = (window as unknown as { ipc: { invoke: <T>(c: string, a?: unknown) => Promise<T> } }).ipc
      const { dir, label } = await ipc.invoke<{ dir: string; label: string }>('session:create-dir', {
        saveRoot: cfg.saveRoot,
      })
      for (const [kind, blob] of pairs) {
        const filename = `${kind}.${this.recFormat.ext}`
        const buffer = await blob.arrayBuffer()
        const path = await ipc.invoke<string>('session:save-recording', { dir, filename, buffer })
        files.push({ kind, filename, path, bytes: blob.size })
        this.log(`Saved ${kind}: ${(blob.size / 1048576).toFixed(1)} MB`, 'success')
      }
      const manifest = this.buildManifest(cfg, preset, startedAt, stoppedAt, files, label)
      const manifestPath = await ipc.invoke<string>('session:write-manifest', { dir, manifest })
      this.log(`Wrote manifest: ${manifestPath}`, 'success')
      this.cb.onSaved(manifest)
    } else {
      // Browser fallback: download both files.
      for (const [kind, blob] of pairs) {
        const filename = `self-test_${kind}.${this.recFormat.ext}`
        this.download(blob, filename)
        files.push({ kind, filename, path: filename, bytes: blob.size })
        this.log(`Downloaded ${kind}: ${(blob.size / 1048576).toFixed(1)} MB`, 'success')
      }
      this.cb.onSaved(this.buildManifest(cfg, preset, startedAt, stoppedAt, files, 'self test'))
    }
  }

  private buildManifest(
    cfg: SessionConfig,
    preset: ReturnType<typeof getPreset>,
    startedAt: string | null,
    stoppedAt: string,
    files: RecordingFile[],
    sessionLabel: string,
  ): SessionManifest {
    return {
      schemaVersion: 1,
      app: APP_NAME,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      sessionLabel,
      config: cfg,
      preset,
      appliedParams: { alpha: this.alpha, overlay: this.overlay },
      startedAt,
      stoppedAt,
      durationSec: this.elapsed,
      files,
    }
  }

  private download(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  stop() {
    if (this.recording === 'recording') void this.stopRecording()
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.face.close()
    this.camera?.getTracks().forEach((t) => t.stop())
    this.camera = null
    this.alteredStream = null
    this.cleanVideo.srcObject = null
    this.hiddenVideo.srcObject = null
    this.connection = 'disconnected'
    this.emit()
    this.log('Stopped')
  }

  getState() {
    return { connection: this.connection, recording: this.recording }
  }
}
