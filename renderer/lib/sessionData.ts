import { dataCategory } from '../../shared/sessionData'
import type { SessionCatalog, SessionDataFile } from '../../shared/sessionData'

export const DATA_CATEGORIES = [
  { id: 'recordings', label: 'Recordings' },
  { id: 'measurements', label: 'Face & voice' },
  { id: 'events', label: 'Events' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'ratings', label: 'Ratings & review' },
  { id: 'session', label: 'Session files' },
] as const

export function catalogFromFiles(files: File[]): {
  catalog: SessionCatalog
  fileMap: Map<string, File>
} {
  const groups = new Map<string, SessionDataFile[]>()
  const fileMap = new Map<string, File>()
  const paths = files.map((f) => (f.webkitRelativePath || f.name).split('/'))
  const directSession = paths.some(
    (p) =>
      p.length === 2 &&
      /^(events\.csv|session_summary\.json|manifest\.json)$/i.test(p[1]),
  )
  files.forEach((file, index) => {
    const parts = paths[index]
    const id = directSession || parts.length < 3 ? '.' : parts[1]
    const relativePath = parts
      .slice(id === '.' ? (parts.length > 1 ? 1 : 0) : 2)
      .join('/')
    const group = groups.get(id) || []
    group.push({
      relativePath,
      size: file.size,
      modifiedAt: new Date(file.lastModified).toISOString(),
      category: dataCategory(relativePath),
    })
    groups.set(id, group)
    fileMap.set(`${id}/${relativePath}`, file)
  })
  return {
    catalog: {
      root: paths[0]?.[0] || '',
      sessions: [...groups]
        .map(([id, entries]) => ({ id, files: entries }))
        .sort((a, b) => b.id.localeCompare(a.id)),
      warnings: [],
    },
    fileMap,
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
