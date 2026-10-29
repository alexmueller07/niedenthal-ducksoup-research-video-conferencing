import { parse } from 'csv-parse/browser/esm/sync'
import type { RatingCandidate, RatingRecording } from '../../main/ratingStation'

export type BrowserRatingCandidate = RatingCandidate & { files?: Record<string, File> }
export const RATING_TRACK_KEYS = ['P1:clean', 'P1:altered', 'P2:clean', 'P2:altered']
export const RATING_BLOCK_SECONDS = 150
export const RATING_BLOCK_COUNT = 4

export function normalizeDyad(text: string): string {
  const match = /\d+/.exec(text)
  return match ? match[0].replace(/^0+(?=\d)/, '').padStart(3, '0') : ''
}

export function completeRecording(candidate?: RatingCandidate): boolean {
  return candidate?.source === 'session' && candidate.recordings.length === 4 &&
    RATING_TRACK_KEYS.every(key => candidate.recordings.filter(r => `${r.seat}:${r.kind}` === key).length === 1)
}

export async function browserRatingLookup(files: File[], dyad: string, participantId = ''): Promise<BrowserRatingCandidate[]> {
  const byPath = new Map(files.map(file => [file.webkitRelativePath, file]))
  const found: BrowserRatingCandidate[] = []
  for (const manifestFile of files.filter(file => file.name === 'session_summary.json')) {
    const folder = manifestFile.webkitRelativePath.slice(0, -manifestFile.name.length)
    const id = folder.split('/').slice(1).filter(Boolean).join('/') || '.'
    let manifest: { participants?: { slot?: string; identity?: { dyadId?: string; participantId?: string } }[] }
    try { manifest = JSON.parse(await manifestFile.text()) } catch { continue }
    const people = Array.isArray(manifest?.participants) ? manifest.participants : []
    const matched = participantId
      ? people.find(p => String(p?.identity?.participantId || '').trim().toLowerCase() === participantId.trim().toLowerCase())
      : people.find(p => normalizeDyad(String(p?.identity?.dyadId || '')) === dyad)
    if (!matched) continue
    const participantIds: RatingCandidate['participantIds'] = {}
    for (const person of people) {
      if (person.slot === 'P1' || person.slot === 'P2') participantIds[person.slot] = String(person.identity?.participantId || '')
    }
    const index = byPath.get(`${folder}videos/recordings.csv`)
    const selected: Record<string, File> = {}
    const recordings: RatingRecording[] = []
    if (index) {
      try {
        const rows = parse(await index.text(), { columns: true, skip_empty_lines: true }) as Record<string, string>[]
        for (const row of rows) {
          const key = `${row.seat}:${row.type}`
          if (!RATING_TRACK_KEYS.includes(key)) continue
          const name = row.file_path?.split(/[\\/]/).pop()
          // Recordings are often copied from a different machine. Resolve within this take.
          const file = byPath.get(`${folder}videos/${name}`) || byPath.get(`${folder}${name}`)
          if (file && /\.(mp4|webm)$/i.test(file.name)) {
            selected[key] = file
            recordings.push({ seat: row.seat as 'P1' | 'P2', kind: row.type as 'clean' | 'altered', path: file.name })
          }
        }
      } catch { /* Keep incomplete takes visible so the researcher can identify them. */ }
    }
    found.push({ id, label: id === '.' ? folder.split('/')[0] : id, source: 'session', modifiedAt: new Date(manifestFile.lastModified).toISOString(), recordings, participantIds,
      ...(participantId ? { dyadId: normalizeDyad(String(matched.identity?.dyadId || '')) } : {}), files: selected })
  }
  return found.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

export function inspectRatingVideo(url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    let finished = false
    let seekingEnd = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      const duration = video.duration
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      video.removeEventListener('loadedmetadata', loaded)
      video.removeEventListener('durationchange', loaded)
      video.removeEventListener('error', failed)
      video.removeAttribute('src')
      video.load()
      if (error) reject(error)
      else resolve(duration)
    }
    const abort = () => finish(new Error('Recording check cancelled.'))
    const loaded = () => {
      if (Number.isFinite(video.duration)) {
        if (video.duration < RATING_BLOCK_SECONDS * RATING_BLOCK_COUNT) finish(new Error('This video is shorter than 10 minutes. The task needs four complete 2:30 parts.'))
        else finish()
      } else if (video.duration === Infinity && !seekingEnd) {
        // Some MediaRecorder WebM files reveal duration only after seeking to the end.
        seekingEnd = true
        video.currentTime = 1e10
      }
    }
    const failed = () => finish(new Error('This video cannot be read. Check that the recording finished copying and plays correctly.'))
    const timer = setTimeout(() => finish(new Error('The video check timed out. Check the drive connection and try again.')), 15000)
    signal.addEventListener('abort', abort, { once: true })
    video.addEventListener('loadedmetadata', loaded)
    video.addEventListener('durationchange', loaded)
    video.addEventListener('error', failed)
    if (signal.aborted) abort()
    else video.src = url
  })
}
