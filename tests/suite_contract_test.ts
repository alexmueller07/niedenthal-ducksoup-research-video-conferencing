import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse } from 'csv-parse/browser/esm/sync'
import { scanSessionRoot, resolveSessionFile } from '../main/sessionCatalog'
import { dataCategory } from '../shared/sessionData'
import { catalogFromFiles } from '../renderer/lib/sessionData'
import { checkReleaseUpdate } from '../shared/releaseUpdate'
import {
  preferredConstraints,
  readDevices,
  saveDevices,
  readReviewDefaults,
  saveReviewDefaults,
} from '../renderer/lib/suitePreferences'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'session-view-suite-'))
try {
  const root = path.join(temp, 'sessions')
  const session = path.join(root, 'session_test')
  await fs.mkdir(path.join(session, 'videos'), { recursive: true })
  await fs.mkdir(path.join(session, 'review_2'), { recursive: true })
  await fs.mkdir(path.join(session, 'calibration', 'P1'), { recursive: true })
  await fs.writeFile(
    path.join(session, 'events.csv'),
    'event,detail\njoined,"a,b"\n',
  )
  await fs.writeFile(path.join(session, 'videos', 'P1_clean.mp4'), 'fixture')
  await fs.writeFile(
    path.join(session, 'review_2', 'answers.csv'),
    'response\nhello\n',
  )
  await fs.writeFile(
    path.join(session, 'calibration', 'P1', 'calibration.json'),
    '{}',
  )
  await fs.writeFile(path.join(temp, 'outside.txt'), 'outside')
  await fs.symlink(
    path.join(temp, 'outside.txt'),
    path.join(session, 'escaped.txt'),
  )
  const catalog = await scanSessionRoot(root)
  assert.equal(catalog.sessions.length, 1)
  assert.equal(catalog.sessions[0].files.length, 4)
  assert.equal(
    catalog.sessions[0].files.find((f) =>
      f.relativePath.endsWith('answers.csv'),
    )?.category,
    'ratings',
  )
  assert.equal(
    await resolveSessionFile(root, 'session_test', 'events.csv'),
    await fs.realpath(path.join(session, 'events.csv')),
  )
  await assert.rejects(resolveSessionFile(root, '..', 'outside.txt'), /outside/)
  await assert.rejects(
    resolveSessionFile(root, 'session_test', 'escaped.txt'),
    /outside/,
  )
  await assert.rejects(
    resolveSessionFile(root, 'session_test', '/etc/passwd'),
    /Invalid/,
  )
  const direct = await scanSessionRoot(session)
  assert.equal(direct.sessions[0].id, '.')
  assert.equal(
    dataCategory('face/face_and_voice_changes_P1.csv'),
    'measurements',
  )
  assert.equal(dataCategory('voice/turns.csv'), 'measurements')
  assert.equal(dataCategory('calibration/P1/smile.jpg'), 'calibration')
  assert.equal(dataCategory('review/settings.txt'), 'ratings')
  assert.equal(dataCategory('session_summary.json'), 'session')
  assert.equal(dataCategory('videos/P1_altered.mp4'), 'recordings')
  const files = [
    'sessions/session_A/events.csv',
    'sessions/session_A/review/answers.csv',
    'sessions/session_B/events.csv',
  ].map((relative) => {
    const file = new File(['fixture'], relative.split('/').pop()!)
    Object.defineProperty(file, 'webkitRelativePath', { value: relative })
    return file
  })
  const browserCatalog = catalogFromFiles(files)
  assert.equal(browserCatalog.catalog.sessions.length, 2)
  assert.equal(
    browserCatalog.fileMap.get('session_A/review/answers.csv'),
    files[1],
  )
  const single = new File(['fixture'], 'events.csv')
  Object.defineProperty(single, 'webkitRelativePath', {
    value: 'session_A/events.csv',
  })
  assert.equal(catalogFromFiles([single]).catalog.sessions[0].id, '.')
  assert.deepEqual(
    parse(
      '\ufeffname,note\r\nA,"quoted, value"\r\nB,"two\nlines"\r\nC,"escaped ""quote"""',
      { bom: true },
    ),
    [
      ['name', 'note'],
      ['A', 'quoted, value'],
      ['B', 'two\nlines'],
      ['C', 'escaped "quote"'],
    ],
  )
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  })
  const constraints = {
    video: { width: 1280, height: 720 },
    audio: { echoCancellation: true, autoGainControl: false, channelCount: 1 },
  }
  assert.deepEqual(preferredConstraints(constraints), constraints)
  saveDevices({ cameraId: 'camera-test', microphoneId: 'mic-test' })
  assert.equal(readDevices().cameraId, 'camera-test')
  assert.deepEqual(preferredConstraints(constraints), {
    video: { ...constraints.video, deviceId: { ideal: 'camera-test' } },
    audio: { ...constraints.audio, deviceId: { ideal: 'mic-test' } },
  })
  assert.deepEqual(preferredConstraints({ video: false, audio: false }), {
    video: false,
    audio: false,
  })
  const defaults = await readReviewDefaults()
  await saveReviewDefaults({ ...defaults, viewMode: 'gallery', segmentSec: 60 })
  assert.equal((await readReviewDefaults()).viewMode, 'gallery')
  assert.equal((await readReviewDefaults()).segmentSec, 60)
  storage.set('session-view:review', '{"viewMode":"broken","segmentSec":-12}')
  assert.equal((await readReviewDefaults()).viewMode, 'active')
  assert.equal((await readReviewDefaults()).segmentSec, 150)
  const realFetch = globalThis.fetch
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v3.1.0',
          assets: [
            {
              name: 'Session-View-3.1.0.exe',
              browser_download_url: 'https://example.org/windows.exe',
            },
            {
              name: 'Session-View-3.1.0.dmg',
              browser_download_url: 'https://example.org/mac.dmg',
            },
          ],
        }),
        { status: 200 },
      )
    assert.equal(
      (await checkReleaseUpdate('3.0.11', 'win32')).downloadUrl,
      'https://example.org/windows.exe',
    )
    assert.equal(
      (await checkReleaseUpdate('3.0.11', 'darwin')).downloadUrl,
      'https://example.org/mac.dmg',
    )
    assert.equal(
      (await checkReleaseUpdate('3.1.0', 'browser')).status,
      'up_to_date',
    )
    assert.equal(
      (await checkReleaseUpdate('3.0.11', 'browser')).downloadUrl,
      undefined,
    )
    globalThis.fetch = async () => new Response('offline', { status: 503 })
    assert.equal(
      (await checkReleaseUpdate('3.0.11', 'win32')).status,
      'unavailable',
    )
  } finally {
    globalThis.fetch = realFetch
  }
  console.log(
    'Suite catalog, file boundaries, CSV parsing, device preferences, and review defaults passed',
  )
} finally {
  await fs.rm(temp, { recursive: true, force: true })
}
