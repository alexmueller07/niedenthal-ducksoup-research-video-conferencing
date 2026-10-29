import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

// Supply a real, decodable video of at least 600 seconds; playback is accelerated only at block boundaries.
const media = process.env.RATING_TEST_VIDEO
assert.ok(media, 'Set RATING_TEST_VIDEO to a video fixture at least 600 seconds long.')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rating-station-ui-'))
async function fixture(folder: string, dyad: string, valid: boolean) {
  const session = path.join(folder, 'session-1')
  await fs.mkdir(path.join(session, 'videos'), { recursive: true })
  await fs.writeFile(path.join(session, 'session_summary.json'), JSON.stringify({ participants: [
    { slot: 'P1', identity: { dyadId: dyad, participantId: 'P101' } },
    { slot: 'P2', identity: { dyadId: dyad, participantId: 'P102' } },
  ] }))
  const rows = ['seat,participant_id,type,file_path']
  for (const seat of ['P1', 'P2']) for (const kind of ['clean', 'altered']) {
    const name = `${seat}_${kind}.mp4`
    if (valid) await fs.copyFile(media!, path.join(session, 'videos', name))
    else await fs.writeFile(path.join(session, 'videos', name), 'invalid-media')
    rows.push(`${seat},${seat},${kind},C:\\recording-computer\\videos\\${name}`)
  }
  await fs.writeFile(path.join(session, 'videos', 'recordings.csv'), rows.join('\n'))
  return session
}
await fixture(path.join(root, 'research', '2026'), '014', true)
const corrupt = await fixture(path.join(root, 'invalid'), '015', false)
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('rating-station:') && (window as unknown as { rejectRatingSave?: boolean }).rejectRatingSave) throw new Error('Test storage failure')
      return original.call(this, key, value)
    }
  })
  await page.goto('http://localhost:8888/rating/', { waitUntil: 'networkidle' })
  await page.locator('input[type=file]').setInputFiles(path.join(root, 'research'))
  await page.getByLabel('Find by participant ID', { exact: true }).fill('p101')
  await expect(page.getByRole('button', { name: /2026\/session-1/ })).toBeVisible()
  await expect(page.getByRole('group', { name: 'Seat in recording' }).getByRole('button', { name: 'P1', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('Participant ID', { exact: true })).toHaveValue('P101')
  await page.getByRole('group', { name: 'Seat in recording' }).getByRole('button', { name: 'P2', exact: true }).click()
  await expect(page.getByLabel('Participant ID', { exact: true })).toHaveValue('P102')
  await expect(page.getByLabel('Partner ID', { exact: true })).toHaveValue('P101')
  await page.getByRole('group', { name: 'Seat in recording' }).getByRole('button', { name: 'P1', exact: true }).click()
  await page.getByLabel('Subject initials', { exact: true }).fill('AB')
  await page.getByLabel('RA name', { exact: true }).fill('Test researcher')
  await expect(page.getByRole('button', { name: 'Start participant task' })).toBeEnabled()
  await page.screenshot({ path: '/tmp/rating-refined-ready-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: '/tmp/rating-refined-mobile.png', fullPage: true })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: 'Start participant task' }).click()
  await expect(page.getByRole('heading', { name: 'Your conversation', exact: true })).toBeVisible()
  assert.equal(await page.locator('.suite-sidebar').evaluate(el => (el as HTMLElement).inert), true)
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Keep answering' }).click()
  for (const question of await page.locator('.rating-question').all()) await question.getByRole('button', { name: '0', exact: true }).click()
  await page.screenshot({ path: '/tmp/rating-refined-questionnaire.png', fullPage: true })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  for (let i = 1; i <= 6; i++) {
    await expect(page.locator('.rating-eyebrow')).toContainText(`${i} of 6`)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  assert.equal(await page.locator('video').count(), 2)

  for (let block = 1; block <= 4; block++) {
    await page.getByRole('button', { name: 'Begin part', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => !v.paused && v.readyState >= 3))
    assert.equal(await page.locator('video').evaluateAll(videos => videos.every(v => !v.muted && !v.controls && v.disablePictureInPicture)), true)
    await page.getByRole('slider').fill(String(55 + block))
    if (block === 1) {
      await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('rating-station:') && JSON.parse(sessionStorage.getItem(key)!).samples.length > 0))
      await page.screenshot({ path: '/tmp/rating-refined-playback.png', fullPage: true })
      const at = await page.locator('video').first().evaluate(v => v.currentTime)
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: true, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await expect(page.getByRole('button', { name: 'Continue playback' })).toBeVisible()
      assert.equal(await page.locator('video').evaluateAll(videos => videos.every(v => v.paused)), true)
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { value: false, configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await page.getByRole('button', { name: 'Continue playback' }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => !v.paused))
      await expect(page.getByRole('slider')).toBeEnabled()
      const resumed = await page.locator('video').first().evaluate(v => v.currentTime)
      assert.ok(resumed >= at && resumed < at + 2, `Resume position changed: ${at} -> ${resumed}`)
      await page.locator('video').last().evaluate(v => v.dispatchEvent(new Event('waiting')))
      await expect(page.getByRole('button', { name: 'Continue playback' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue playback' }).click()
      await page.waitForFunction(() => [...document.querySelectorAll('video')].every(v => !v.paused))
      await expect(page.getByRole('slider')).toBeEnabled()
    }
    await page.locator('video').first().evaluate((video, end) => {
      video.currentTime = end
      video.dispatchEvent(new Event('timeupdate'))
    }, block * 150)
    await expect(page.getByLabel('Describe feelings')).toBeVisible()
    await page.getByLabel('Describe feelings').fill(`Reflection ${block}`)
    await page.getByRole('button', { name: '5', exact: true }).click()
    if (block === 4) {
      await page.evaluate(() => { (window as unknown as { rejectRatingSave: boolean }).rejectRatingSave = true })
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.locator('.rating-warning[role=alert]')).toContainText('Responses could not be saved')
      await expect(page.getByLabel('Describe feelings')).toHaveValue('Reflection 4')
      await page.evaluate(() => { (window as unknown as { rejectRatingSave: boolean }).rejectRatingSave = false })
    }
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'You have finished. Thank you.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Return to station setup' })).toBeDisabled()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download responses' }).click()
  const downloaded = await download
  const output = path.join(root, 'responses.json')
  await downloaded.saveAs(output)
  const result = JSON.parse(await fs.readFile(output, 'utf8'))
  assert.equal(result.status, 'done')
  assert.equal(result.reflections.length, 4)
  assert.deepEqual(result.reflections.map((r: { block: number }) => r.block), [1, 2, 3, 4])
  assert.equal(result.setup.participantId, 'P101')
  assert.ok(result.samples.length > 0)
  assert.equal(result.interruptions.length, 2)
  await page.getByRole('button', { name: 'Return to station setup' }).click()
  assert.equal(await page.locator('.suite-sidebar').evaluate(el => (el as HTMLElement).inert), false)

  // Selecting a session folder directly works; invalid videos fail before participant handoff.
  await page.getByLabel('Find by participant ID', { exact: true }).fill('')
  await page.locator('input[type=file]').setInputFiles(corrupt)
  await page.getByLabel('Dyad ID (optional)', { exact: true }).fill('15')
  await expect(page.getByRole('button', { name: /session-1/ })).toBeVisible()
  await page.getByLabel('Subject initials', { exact: true }).fill('AB')
  await page.getByRole('button', { name: 'Start participant task' }).click()
  await expect(page.locator('.rating-warning[role=alert]')).toContainText('cannot be read')
  await expect(page.getByRole('heading', { name: 'Set up this station' })).toBeVisible()
  await page.getByLabel('Dyad ID (optional)', { exact: true }).fill('16')
  await page.getByLabel('Dyad ID (optional)', { exact: true }).fill('')
  await expect(page.getByText('Find a conversation', { exact: true })).toBeVisible()
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('Rating station: real video preflight, both audio tracks, all four blocks, pause recovery, save retry, export, copied folders, and responsive layout passed')
} finally {
  await browser.close()
  await fs.rm(root, { recursive: true, force: true })
}
