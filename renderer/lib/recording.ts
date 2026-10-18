// Recorder format selection: prefer MP4, fall back to WebM.
//
// The RAs asked for .mp4 output (it opens everywhere the lab works). Chromium
// in this Electron version can mux MediaRecorder output straight to fragmented
// MP4 (H.264 + AAC); fragmented MP4 also stays playable if the app crashes
// mid-recording, same as the old WebM path. If the running Chromium cannot do
// MP4 for a given stream type we quietly fall back to WebM rather than fail.

export interface RecorderFormat {
  mimeType: string
  ext: 'mp4' | 'webm'
}

const VIDEO_CANDIDATES: RecorderFormat[] = [
  { mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
  { mimeType: 'video/mp4', ext: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mimeType: 'video/webm', ext: 'webm' },
]

const AUDIO_CANDIDATES: RecorderFormat[] = [
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', ext: 'mp4' },
  { mimeType: 'audio/mp4', ext: 'mp4' },
  { mimeType: 'audio/webm', ext: 'webm' },
]

/**
 * Copy a stream's video onto a fixed-size canvas, with its audio alongside.
 *
 * WebRTC changes a stream's resolution on the fly (it starts small and steps
 * up as the connection allows). Chromium's MP4 recorder cannot follow a size
 * change: everything recorded after one fails to decode. Recording a canvas
 * that never changes size avoids that; the picture is letterboxed to fit.
 */
export function fixedSizeStream(
  source: MediaStream,
  width = 1280,
  height = 720,
  fps = 30,
): { stream: MediaStream; stop: () => void } {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.srcObject = source
  void video.play().catch(() => {})
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  // A timer rather than requestAnimationFrame, so recording carries on while
  // the dashboard window is hidden or minimised.
  const timer = setInterval(() => {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return
    const scale = Math.min(width / vw, height / vh)
    const w = Math.round(vw * scale)
    const h = Math.round(vh * scale)
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(video, Math.round((width - w) / 2), Math.round((height - h) / 2), w, h)
  }, 1000 / fps)
  const canvasTrack = canvas.captureStream(fps).getVideoTracks()[0]
  const stream = new MediaStream([canvasTrack, ...source.getAudioTracks()])
  return {
    stream,
    stop: () => {
      clearInterval(timer)
      canvasTrack.stop()
      video.pause()
      video.srcObject = null
    },
  }
}

export function pickRecorderFormat(hasVideo: boolean): RecorderFormat {
  const candidates = hasVideo ? VIDEO_CANDIDATES : AUDIO_CANDIDATES
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c
  }
  // Last resort: let MediaRecorder pick; label it webm (Chromium's default).
  return { mimeType: '', ext: 'webm' }
}
