export type DataCategory =
  | 'recordings'
  | 'measurements'
  | 'events'
  | 'calibration'
  | 'ratings'
  | 'session'
export interface SessionDataFile {
  relativePath: string
  size: number
  modifiedAt: string
  category: DataCategory
}
export interface CatalogSession {
  id: string
  files: SessionDataFile[]
}
export interface SessionCatalog {
  root: string
  sessions: CatalogSession[]
  warnings: string[]
}

export function dataCategory(relativePath: string): DataCategory {
  const p = relativePath.toLowerCase().replace(/\\/g, '/')
  if (/\.(mp4|webm|m4a|wav|mp3|ogg)$/.test(p)) return 'recordings'
  if (/(^|\/)calibration(\/|\.)/.test(p)) return 'calibration'
  if (
    /(^|\/)(review(_\d+)?|ratings?)(\/|\.)/.test(p) ||
    /answers\.csv$/.test(p)
  )
    return 'ratings'
  if (/(^|\/)events\.csv$/.test(p)) return 'events'
  if (
    /(^|\/)(face|voice)\//.test(p) ||
    /telemetry|expression|measurement|face_and_voice/.test(p)
  )
    return 'measurements'
  return 'session'
}
