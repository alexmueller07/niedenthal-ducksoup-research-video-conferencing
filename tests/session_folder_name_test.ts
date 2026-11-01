import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { renameSessionToDyad } from '../main/logger'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dyad-folder-'))
try {
  const dir = path.join(root, 'session_2026-11-01_10-00-00')
  await fs.mkdir(dir)
  await fs.writeFile(path.join(dir, 'events.csv'), 'x')
  const renamed = await renameSessionToDyad(dir, 'Dyad 14')
  assert.equal(path.basename(renamed), 'dyad_014_2026-11-01_10-00-00')
  assert.ok((await fs.stat(path.join(renamed, 'events.csv'))).isFile())

  const other = path.join(root, 'session_2026-11-01_11-00-00')
  await fs.mkdir(other)
  assert.equal(await renameSessionToDyad(other, ''), other, 'no dyad id keeps the name')
  assert.equal(await renameSessionToDyad('/nope/other_folder', '5'), '/nope/other_folder', 'only session_ folders are renamed')

  const taken = path.join(root, 'session_2026-11-01_10-00-00')
  await fs.mkdir(taken)
  assert.equal(await renameSessionToDyad(taken, '14'), taken, 'an existing name is never overwritten')
  console.log('session folder name checks passed')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
