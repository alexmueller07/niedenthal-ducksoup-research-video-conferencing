// LiveEffects: a participant machine's outgoing-media pipeline.
//
// Owns the camera and produces two streams:
//   cleanStream   — the raw camera + raw mic. Shown in the participant's own
//                   self-view PiP and sent to the researcher for reference.
//   alteredStream — face-morphed canvas video + pitch-shifted mic. This is what
//                   the partner sees/hears and what the researcher monitors.
//
// The whole pipeline starts during the waiting screen — model loaded, render
// loop running, audio graph live at neutral settings — so the first researcher
// command changes parameters on an already-hot path instead of cold-starting
// anything mid-conversation.

import { FaceMorphProcessor } from './faceMorph'
import { VoiceProcessor } from './voice'
import type { Telemetry } from './protocol'

export interface EffectsStatus {
  camera: boolean
  faceModel: boolean
  voice: boolean
}

export class LiveEffects {
  private face = new FaceMorphProcessor()
  private voice: VoiceProcessor | null = null
  private camera: MediaStream | null = null
  private hiddenVideo: HTMLVideoElement
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private raf: number | null = null

  private alpha = 1.0
  private semitones = 0
  private frameTimes: number[] = []

  cleanStream: MediaStream | null = null
  alteredStream: MediaStream | null = null
  status: EffectsStatus = { camera: false, faceModel: false, voice: false }

  constructor() {
    this.hiddenVideo = document.createElement('video')
    this.hiddenVideo.muted = true
    this.hiddenVideo.playsInline = true
    this.canvas = document.createElement('canvas')
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable')
    this.ctx = ctx
  }

  /**
   * Bring the full pipeline up. Tolerant of partial failure: if the face model
   * cannot load (offline first run), video passes through unmorphed; if the
   * audio graph fails, raw mic audio is used. Status reports what is real.
   */
  async start(onLog: (msg: string, level?: 'info' | 'warn' | 'error') => void): Promise<void> {
    try {
      await this.face.init()
      this.status.faceModel = true
      onLog('Face-landmark model ready')
    } catch (err) {
      onLog(`Face model failed to load (video passes through unmorphed): ${err}`, 'warn')
    }

    this.camera = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: { echoCancellation: true, noiseSuppression: true },
    })
    this.status.camera = true
    this.cleanStream = this.camera

    this.hiddenVideo.srcObject = this.camera
    await this.hiddenVideo.play().catch(() => {})

    const settings = this.camera.getVideoTracks()[0]?.getSettings()
    const w = settings?.width ?? 1280
    const h = settings?.height ?? 720
    this.canvas.width = w
    this.canvas.height = h

    try {
      this.voice = new VoiceProcessor(new MediaStream(this.camera.getAudioTracks()))
      await this.voice.resume()
      this.voice.setSemitones(this.semitones)
      this.status.voice = true
      onLog('Voice processor ready')
    } catch (err) {
      onLog(`Voice processor unavailable (raw mic audio used): ${err}`, 'warn')
    }

    const canvasStream = this.canvas.captureStream(30)
    const alteredAudio =
      this.voice?.outputStream.getAudioTracks() ?? this.camera.getAudioTracks()
    this.alteredStream = new MediaStream([...canvasStream.getVideoTracks(), ...alteredAudio])

    this.face.setAlpha(this.alpha)
    this.startRenderLoop(w, h)
    onLog('Outgoing media pipeline live')
  }

  private startRenderLoop(w: number, h: number) {
    let lastTs = -1
    const loop = () => {
      const ts = performance.now()
      const monotonic = ts <= lastTs ? lastTs + 1 : ts
      lastTs = monotonic
      this.face.render(this.hiddenVideo, this.ctx, w, h, monotonic)
      this.frameTimes.push(ts)
      while (this.frameTimes.length > 0 && this.frameTimes[0] < ts - 1000) {
        this.frameTimes.shift()
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  setAlpha(alpha: number) {
    this.alpha = alpha
    this.face.setAlpha(alpha)
  }

  setSemitones(semitones: number) {
    this.semitones = semitones
    this.voice?.setSemitones(semitones)
  }

  telemetry(): Telemetry {
    return {
      alpha: this.alpha,
      voiceSemitones: this.semitones,
      faceFound: this.face.faceFound,
      fps: this.frameTimes.length,
      cameraOn: !!this.camera && this.camera.getVideoTracks().some((t) => t.readyState === 'live'),
    }
  }

  stop() {
    if (this.raf !== null) cancelAnimationFrame(this.raf)
    this.raf = null
    this.face.close()
    this.voice?.close()
    this.voice = null
    this.camera?.getTracks().forEach((t) => t.stop())
    this.camera = null
    this.cleanStream = null
    this.alteredStream = null
    this.hiddenVideo.srcObject = null
    this.status = { camera: false, faceModel: false, voice: false }
  }
}
