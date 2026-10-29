import fs from 'fs/promises'
import path from 'path'
import { parse } from 'csv-parse/sync'

export type RatingRecording = { seat: 'P1' | 'P2'; kind: 'clean' | 'altered'; path: string }
export type RatingCandidate = {
  id: string
  label: string
  modifiedAt: string
  recordings: RatingRecording[]
  participantIds: Partial<Record<'P1' | 'P2', string>>
  dyadId?: string
  source: 'session' | 'suite'
}

export function normalizeRatingDyad(raw: string): string {
  const match = /\d+/.exec(raw)
  if (!match) return ''
  return match[0].replace(/^0+(?=\d)/, '').padStart(3, '0')
}

async function inside(root: string, file: string): Promise<boolean> {
  try {
    const real = await fs.realpath(file)
    const rel = path.relative(root, real)
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && (await fs.stat(real)).isFile()
  } catch { return false }
}

async function sessionCandidate(root: string, dir: string, id: string, dyad: string, participantId?: string): Promise<RatingCandidate | null> {
  const summaryPath = path.join(dir, 'session_summary.json')
  let summary: any
  try { summary = JSON.parse(await fs.readFile(summaryPath, 'utf8')) } catch { return null }
  const people = Array.isArray(summary?.participants) ? summary.participants : []
  const matched = participantId
    ? people.find((p: any) => String(p?.identity?.participantId ?? '').trim().toLowerCase() === participantId.trim().toLowerCase())
    : people.find((p: any) => normalizeRatingDyad(String(p?.identity?.dyadId ?? '')) === dyad)
  if (!matched) return null
  const participantIds: RatingCandidate['participantIds'] = {}
  for (const p of people) {
    if (p?.slot === 'P1') participantIds.P1 = String(p.identity?.participantId ?? '')
    if (p?.slot === 'P2') participantIds.P2 = String(p.identity?.participantId ?? '')
  }
  const recordings: RatingRecording[] = []
  try {
    const rows = parse(await fs.readFile(path.join(dir, 'videos', 'recordings.csv'), 'utf8'), { columns: true, skip_empty_lines: true }) as Record<string, string>[]
    for (const row of rows) {
      if (row.seat !== 'P1' && row.seat !== 'P2') continue
      if (row.type !== 'clean' && row.type !== 'altered') continue
      const recordedPath = row.file_path || ''
      const name = recordedPath.split(/[\\/]/).pop() || ''
      if (!/\.(mp4|webm)$/i.test(name)) continue
      // A Research Drive copy must use its local files, even if the CSV names the original computer.
      const options = [path.resolve(dir, recordedPath), path.join(dir, 'videos', name), path.join(dir, name)]
      for (const file of options) {
        if (await inside(dir, file)) {
          recordings.push({ seat: row.seat, kind: row.type, path: file })
          break
        }
      }
    }
  } catch { /* A matching session with missing recordings is still shown as incomplete. */ }
  return { id, label: id, modifiedAt: (await fs.stat(summaryPath)).mtime.toISOString(), recordings, participantIds,
    ...(participantId ? { dyadId: normalizeRatingDyad(String(matched.identity?.dyadId ?? '')) } : {}), source: 'session' }
}

async function findRatingCandidates(rootPath: string, dyad: string, participantId?: string): Promise<RatingCandidate[]> {
  if (!dyad && !participantId) return []
  const root = await fs.realpath(rootPath)
  const candidates: RatingCandidate[] = []
  const scan = async (dir: string, depth: number) => {
    const id = path.relative(root, dir) || '.'
    const found = await sessionCandidate(root, dir, id, dyad, participantId)
    if (found) candidates.push(found)
    if (depth >= 3) return
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || /^(videos|rating-station|review(?:_\d+)?)$/.test(entry.name)) continue
      await scan(path.join(dir, entry.name), depth + 1)
    }
  }
  await scan(root, 0)
  if (participantId) return candidates.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  const folder = `dyad-${dyad}`
  for (const dir of [root, path.join(root, folder)]) {
    let files: string[]
    try { files = await fs.readdir(dir) } catch { continue }
    for (const file of files) {
      if (!/\.(mp4|webm|m4v)$/i.test(file)) continue
      if (dir === root && !new RegExp(`^${folder}(?:[_ .-]|$)`, 'i').test(file)) continue
      const full = path.join(dir, file)
      if (!await inside(root, full)) continue
      candidates.push({ id: `${dir === root ? '.' : folder}/${file}`, label: file, modifiedAt: (await fs.stat(full)).mtime.toISOString(), recordings: [], participantIds: {}, source: 'suite' })
    }
  }
  return candidates.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
}

export function findRatingRecordings(rootPath: string, rawDyad: string): Promise<RatingCandidate[]> {
  return findRatingCandidates(rootPath, normalizeRatingDyad(rawDyad))
}

export function findRatingRecordingsByParticipant(rootPath: string, participantId: string): Promise<RatingCandidate[]> {
  const id = participantId.trim()
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return Promise.resolve([])
  return findRatingCandidates(rootPath, '', id)
}
