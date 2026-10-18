import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ReviewMediaRoute, parseRange } from '../main/mediaRoute'

// ---- Range parsing ----
assert.equal(parseRange(undefined, 100), null)
assert.deepEqual(parseRange('bytes=0-9', 100), [0, 9])
assert.deepEqual(parseRange('bytes=90-', 100), [90, 99])
assert.deepEqual(parseRange('bytes=90-500', 100), [90, 99], 'end clamped to the file')
assert.deepEqual(parseRange('bytes=-10', 100), [90, 99], 'suffix range')
assert.equal(parseRange('bytes=100-', 100), 'invalid')
assert.equal(parseRange('bytes=5-2', 100), 'invalid')
assert.equal(parseRange('bytes=-', 100), 'invalid')
assert.equal(parseRange('bytes=0-1,5-6', 100), 'invalid', 'multiple ranges are not supported')

// ---- Serving ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-media-'))
const file = path.join(dir, 'P1_abc_altered.mp4')
const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256))
fs.writeFileSync(file, body)
fs.writeFileSync(path.join(dir, 'secret.txt'), 'not for participants')

const route = new ReviewMediaRoute()
const server = http.createServer((req, res) => {
  if (!route.handle(req, res)) res.writeHead(404).end()
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const { port } = server.address() as { port: number }
const base = `http://127.0.0.1:${port}`

// Nothing is served before a review opens.
assert.equal((await fetch(`${base}/review/abc/P1_abc_altered.mp4`)).status, 403)

const [url] = route.open([file])
assert.match(url, /^\/review\/[0-9a-f]{32}\/1\.mp4$/, 'served under a neutral name')

const full = await fetch(base + url)
assert.equal(full.status, 200)
assert.equal(full.headers.get('content-type'), 'video/mp4')
assert.equal(full.headers.get('accept-ranges'), 'bytes')
assert.deepEqual(Buffer.from(await full.arrayBuffer()), body)

const part = await fetch(base + url, { headers: { Range: 'bytes=100-199' } })
assert.equal(part.status, 206)
assert.equal(part.headers.get('content-range'), 'bytes 100-199/1000')
assert.deepEqual(Buffer.from(await part.arrayBuffer()), body.subarray(100, 200))

const bad = await fetch(base + url, { headers: { Range: 'bytes=5000-' } })
assert.equal(bad.status, 416)
assert.equal(bad.headers.get('content-range'), 'bytes */1000')

const head = await fetch(base + url, { method: 'HEAD' })
assert.equal(head.status, 200)
assert.equal(head.headers.get('content-length'), '1000')

// Wrong token, unregistered file, and path tricks are all refused.
const token = url.split('/')[2]
assert.equal((await fetch(`${base}/review/${'0'.repeat(32)}/1.mp4`)).status, 403)
assert.equal((await fetch(`${base}/review/${token}/P1_abc_altered.mp4`)).status, 404, 'real names are not served')
assert.equal((await fetch(`${base}/review/${token}/secret.txt`)).status, 404)
assert.equal((await fetch(`${base}/review/${token}/..%2Fsecret.txt`)).status, 404)
assert.equal((await fetch(`${base}/review/${token}/%E0%A4%A`)).status, 400)
assert.equal((await fetch(`${base}/other`)).status, 404)
assert.equal((await fetch(base + url, { method: 'POST' })).status, 405)

// A second audience gets its own token; neither reaches the other's files.
const other = path.join(dir, 'P1_abc_clean.mp4')
fs.writeFileSync(other, Buffer.from('original'))
const [otherUrl] = route.open([other])
assert.notEqual(otherUrl.split('/')[2], token)
assert.equal(Buffer.from(await (await fetch(base + otherUrl)).arrayBuffer()).toString(), 'original')
assert.deepEqual(Buffer.from(await (await fetch(base + url)).arrayBuffer()), body, 'first token still serves its own file')
assert.equal((await fetch(`${base}/review/${token}/2.mp4`)).status, 404)

// Closing the review turns every link off.
route.close()
assert.equal((await fetch(base + url)).status, 403)
assert.equal((await fetch(base + otherUrl)).status, 403)

await new Promise<void>((r) => server.close(() => r()))
fs.rmSync(dir, { recursive: true, force: true })

console.log('review media checks passed')
