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

export function pickRecorderFormat(hasVideo: boolean): RecorderFormat {
  const candidates = hasVideo ? VIDEO_CANDIDATES : AUDIO_CANDIDATES
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c.mimeType)) return c
  }
  // Last resort: let MediaRecorder pick; label it webm (Chromium's default).
  return { mimeType: '', ext: 'webm' }
}
