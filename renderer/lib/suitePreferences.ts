import type { ReviewConfig } from './protocol'
import { DEFAULT_REVIEW_CONFIG } from './protocol'
import { hasIpc, ipcInvoke } from './ipcUtil'

export interface DevicePreferences {
  cameraId: string
  microphoneId: string
}
export interface StudyPreferences {
  studyId: string
}

function readLocal<T>(key: string, fallback: T): T {
  try {
    return {
      ...fallback,
      ...JSON.parse(localStorage.getItem(`session-view:${key}`) || '{}'),
    }
  } catch {
    return fallback
  }
}
export function readDevices(): DevicePreferences {
  return readLocal('devices', { cameraId: '', microphoneId: '' })
}
export function readStudy(): StudyPreferences {
  return readLocal('study', { studyId: '' })
}
export function saveDevices(value: DevicePreferences) {
  localStorage.setItem('session-view:devices', JSON.stringify(value))
}
export function saveStudy(value: StudyPreferences) {
  localStorage.setItem('session-view:study', JSON.stringify(value))
}

export function preferredConstraints(
  constraints: MediaStreamConstraints,
): MediaStreamConstraints {
  const { cameraId, microphoneId } = readDevices()
  return {
    ...constraints,
    ...(constraints.video && cameraId
      ? {
          video: {
            ...(typeof constraints.video === 'object' ? constraints.video : {}),
            deviceId: { ideal: cameraId },
          },
        }
      : {}),
    ...(constraints.audio && microphoneId
      ? {
          audio: {
            ...(typeof constraints.audio === 'object' ? constraints.audio : {}),
            deviceId: { ideal: microphoneId },
          },
        }
      : {}),
  }
}

export async function readReviewDefaults(): Promise<ReviewConfig> {
  const saved = hasIpc()
    ? await ipcInvoke<Partial<ReviewConfig>>('prefs:get', 'reviewConfig')
    : readLocal<Partial<ReviewConfig>>('review', {})
  return {
    ...DEFAULT_REVIEW_CONFIG,
    ...saved,
    viewMode:
      saved && ['active', 'single', 'gallery'].includes(saved.viewMode || '')
        ? saved.viewMode!
        : DEFAULT_REVIEW_CONFIG.viewMode,
    segmentSec:
      saved?.segmentSec && saved.segmentSec >= 10 && saved.segmentSec <= 1800
        ? saved.segmentSec
        : DEFAULT_REVIEW_CONFIG.segmentSec,
    minTailSec: DEFAULT_REVIEW_CONFIG.minTailSec,
  }
}
export async function saveReviewDefaults(config: ReviewConfig) {
  if (hasIpc()) await ipcInvoke('prefs:set', 'reviewConfig', config)
  else localStorage.setItem('session-view:review', JSON.stringify(config))
}
