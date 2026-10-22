import fs from 'fs/promises'
import path from 'path'

import { dataCategory } from '../shared/sessionData'
import type {
  CatalogSession,
  SessionCatalog,
  SessionDataFile,
} from '../shared/sessionData'

const allowedFile = /\.(csv|json|txt|mp4|webm|m4a|wav|mp3|ogg|png|jpe?g)$/i
const MAX_FILES = 20000

export async function scanSessionRoot(root: string): Promise<SessionCatalog> {
  const resolved = await fs.realpath(root)
  const sessions: CatalogSession[] = []
  const warnings: string[] = []
  let count = 0
  async function walk(
    dir: string,
    prefix: string,
    files: SessionDataFile[],
    depth: number,
  ): Promise<void> {
    if (depth > 8 || count >= MAX_FILES) return
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const file = path.join(dir, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(file, relativePath, files, depth + 1)
      else if (entry.isFile() && allowedFile.test(entry.name)) {
        if (++count > MAX_FILES) break
        const stat = await fs.stat(file)
        files.push({
          relativePath,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          category: dataCategory(relativePath),
        })
      }
    }
  }
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  const isSession = entries.some(
    (e) =>
      e.isFile() &&
      /^(events\.csv|session_summary\.json|manifest\.json)$/i.test(e.name),
  )
  if (isSession) {
    const files: SessionDataFile[] = []
    await walk(resolved, '', files, 0)
    sessions.push({ id: '.', files })
  } else {
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        entry.name.startsWith('.')
      )
        continue
      const files: SessionDataFile[] = []
      try {
        await walk(path.join(resolved, entry.name), '', files, 0)
      } catch {
        warnings.push(`Could not read ${entry.name}.`)
      }
      if (files.length) sessions.push({ id: entry.name, files })
    }
  }
  if (count >= MAX_FILES)
    warnings.push(
      'File limit reached. Select a smaller session folder to see all files.',
    )
  sessions.sort((a, b) => b.id.localeCompare(a.id))
  return { root: resolved, sessions, warnings }
}

// Every file operation resolves through the indexed root; symlinks cannot escape it.
export async function resolveSessionFile(
  root: string,
  session: string,
  relativePath: string,
): Promise<string> {
  if (
    !session ||
    !relativePath ||
    path.isAbsolute(relativePath) ||
    path.isAbsolute(session)
  )
    throw new Error('Invalid session path.')
  const base = await fs.realpath(root)
  const file = await fs.realpath(path.resolve(base, session, relativePath))
  const relative = path.relative(base, file)
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    throw new Error('File is outside the selected folder.')
  if (!(await fs.stat(file)).isFile()) throw new Error('Select a file.')
  if (!allowedFile.test(file)) throw new Error('Unsupported session file type.')
  return file
}
