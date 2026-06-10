// CaptureStation: the self-contained capture engine.
//
// Owns the camera, runs the facial morph (canvas) and voice shift (Web Audio),
// renders the participant-facing "altered" view, and records both the clean and
// altered streams. It works in a plain browser (records download to disk) and in
// Electron (records save to a structured session folder via window.ipc).
//
// Deliberately no cross-window IPC bus: one page owns everything, which is
// simpler and does not crash outside Electron.

import { FaceMorphProcessor } from './faceMorph'
import { VoiceProcessor } from './voice'
import { getPreset } from './presets'
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
  private voice: VoiceProcessor | null = null
  private raf: number | null = null

  private alteredRecorder: MediaRecorder | null = null
  private cleanRecorder: MediaRecorder | null = null
  private alteredChunks: Blob[] = []
  private cleanChunks: Blob[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private elapsed = 0
  private startedAt: string | null = null

  private config: SessionConfig | null = null
  private alpha = 1.0
  private voiceSemitones = 0
  private overlay = false

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
    this.setVoiceSemitones(p.voiceSemitones)
  }
  setAlpha(alpha: number) {
    this.alpha = alpha
    this.face.setAlpha(alpha)
  }
  setVoiceSemitones(semitones: number) {
    this.voiceSemitones = semitones
    this.voice?.setSemitones(semitones)
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

    // Voice graph from the mic.
    try {
      this.voice = new VoiceProcessor(new MediaStream(this.camera.getAudioTracks()))
      await this.voice.resume()
      this.voice.setSemitones(this.voiceSemitones)
      this.log('Voice processor ready', 'success')
    } catch (err) {
      this.log(`Voice processor unavailable: ${err}`, 'warn')
    }

    // Altered stream = morphed canvas video + pitch-shifted audio (fallback: raw).
    const canvasStream = this.alteredCanvas.captureStream(30)
    const alteredAudio = this.voice?.outputStream.getAudioTracks() ?? this.camera.getAudioTracks()
    this.alteredStream = new MediaStream([...canvasStream.getVideoTracks(), ...alteredAudio])

    this.startRenderLoop(w, h)
    this.connection = 'connected'
    this.emit()
    this.log('Capture station live', 'success')
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
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm'
    const rec = new MediaRecorder(stream, { mimeType: mime })
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

    try {
      await this.saveSession(
        new Blob(altered, { type: 'video/webm' }),
        new Blob(clean, { type: 'video/webm' }),
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
      const dir = await ipc.invoke<string>('session:create-dir', {
        saveRoot: cfg.saveRoot,
        studyId: cfg.studyId,
        dyadId: cfg.dyadId,
        participantId: cfg.participantId,
      })
      for (const [kind, blob] of pairs) {
        const filename = `${cfg.dyadId}_${cfg.participantId}_${kind}.webm`
        const buffer = await blob.arrayBuffer()
        const path = await ipc.invoke<string>('session:save-recording', { dir, filename, buffer })
        files.push({ kind, filename, path, bytes: blob.size })
        this.log(`Saved ${kind}: ${(blob.size / 1048576).toFixed(1)} MB`, 'success')
      }
      const manifest = this.buildManifest(cfg, preset, startedAt, stoppedAt, files)
      const manifestPath = await ipc.invoke<string>('session:write-manifest', { dir, manifest })
      this.log(`Wrote manifest: ${manifestPath}`, 'success')
      this.cb.onSaved(manifest)
    } else {
      // Browser fallback: download both files.
      for (const [kind, blob] of pairs) {
        const filename = `${cfg.dyadId || 'session'}_${cfg.participantId || 'p'}_${kind}.webm`
        this.download(blob, filename)
        files.push({ kind, filename, path: filename, bytes: blob.size })
        this.log(`Downloaded ${kind}: ${(blob.size / 1048576).toFixed(1)} MB`, 'success')
      }
      this.cb.onSaved(this.buildManifest(cfg, preset, startedAt, stoppedAt, files))
    }
  }

  private buildManifest(
    cfg: SessionConfig,
    preset: ReturnType<typeof getPreset>,
    startedAt: string | null,
    stoppedAt: string,
    files: RecordingFile[],
  ): SessionManifest {
    return {
      schemaVersion: 1,
      app: APP_NAME,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      config: cfg,
      preset,
      appliedParams: { alpha: this.alpha, voiceSemitones: this.voiceSemitones, overlay: this.overlay },
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
    this.voice?.close()
    this.voice = null
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
