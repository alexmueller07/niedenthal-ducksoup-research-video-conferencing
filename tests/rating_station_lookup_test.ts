import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findRatingRecordings, normalizeRatingDyad } from '../main/ratingStation'

assert.equal(normalizeRatingDyad('dyad-014-room2'), '014')
assert.equal(normalizeRatingDyad('14'), '014')
assert.equal(normalizeRatingDyad('no number'), '')

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'rating-lookup-'))
try {
  const root = path.join(temp, 'research')
  await fs.mkdir(root)
  for (const sessionId of ['take-1', 'take-2']) {
    const dir = path.join(root, sessionId)
    await fs.mkdir(path.join(dir, 'videos'), { recursive: true })
    await fs.writeFile(path.join(dir, 'session_summary.json'), JSON.stringify({ participants: [
      { slot: 'P1', identity: { dyadId: '14', participantId: 'P101' } },
      { slot: 'P2', identity: { dyadId: '014', participantId: 'P102' } },
    ] }))
    const rows = ['seat,participant_id,type,file_path']
    for (const seat of ['P1', 'P2']) for (const kind of ['clean', 'altered']) {
      const file = path.join(dir, 'videos', `${seat}_${kind}.mp4`)
      await fs.writeFile(file, 'fixture')
      rows.push(`${seat},${seat},${kind},${file}`)
    }
    await fs.writeFile(path.join(dir, 'videos', 'recordings.csv'), rows.join('\n'))
  }
  const unrelated = path.join(root, 'other')
  await fs.mkdir(unrelated)
  await fs.writeFile(path.join(unrelated, 'session_summary.json'), JSON.stringify({ participants: [{ slot: 'P1', identity: { dyadId: '015' } }] }))
  await fs.mkdir(path.join(root, 'dyad-014'))
  await fs.writeFile(path.join(root, 'dyad-014', 'dyad-014_20261023.mp4'), 'suite fixture')
  const found = await findRatingRecordings(root, '014')
  assert.equal(found.length, 3)
  assert.equal(found.filter(c => c.source === 'session').length, 2)
  assert.ok(found.filter(c => c.source === 'session').every(c => c.recordings.length === 4 && c.participantIds.P1 === 'P101'))
  assert.equal(found.filter(c => c.source === 'suite').length, 1)
  assert.deepEqual(await findRatingRecordings(root, '015'), [{ id: 'other', label: 'other', modifiedAt: (await fs.stat(path.join(unrelated, 'session_summary.json'))).mtime.toISOString(), recordings: [], participantIds: { P1: '' }, source: 'session' }])
  const outside = path.join(temp, 'outside.mp4')
  await fs.writeFile(outside, 'outside')
  const escaped = path.join(root, 'take-1', 'videos', 'P1_clean.mp4')
  await fs.unlink(escaped)
  await fs.symlink(outside, escaped)
  const after = await findRatingRecordings(root, '014')
  assert.equal(after.find(c => c.id === 'take-1')?.recordings.length, 3)

  const copied = path.join(root, '2026', 'dyad-016', 'copied-take')
  await fs.mkdir(path.join(copied, 'videos'), { recursive: true })
  await fs.writeFile(path.join(copied, 'session_summary.json'), JSON.stringify({ participants: [{ slot: 'P1', identity: { dyadId: '016' } }] }))
  const copiedRows = ['seat,type,file_path']
  for (const seat of ['P1', 'P2']) for (const kind of ['clean', 'altered']) {
    const name = `${seat}_${kind}.mp4`
    await fs.writeFile(path.join(copied, 'videos', name), 'copied fixture')
    copiedRows.push(`${seat},${kind},C:\\OriginalComputer\\recordings\\${name}`)
  }
  await fs.writeFile(path.join(copied, 'videos', 'recordings.csv'), copiedRows.join('\n'))
  const relocated = await findRatingRecordings(root, '16')
  assert.equal(relocated.length, 1)
  assert.equal(relocated[0].recordings.length, 4)
  const realCopied = await fs.realpath(copied)
  assert.ok(relocated[0].recordings.every(recording => recording.path.startsWith(realCopied)))
  const direct = await findRatingRecordings(copied, '016')
  assert.equal(direct[0].id, '.')
  assert.equal(direct[0].recordings.length, 4)

  await fs.writeFile(path.join(root, 'dyad-0140-other.mp4'), 'different dyad')
  assert.equal((await findRatingRecordings(root, '014')).filter(c => c.source === 'suite').length, 1)
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
console.log('rating station lookup tests passed')
