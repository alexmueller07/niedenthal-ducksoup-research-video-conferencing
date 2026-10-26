// Serves the session's recordings to the participant machines during the
// post-call review, over the same port as the session WebSocket.
//
// Only files registered for the running review are reachable, and only under
// a random token — the URL stops working the moment the review ends. Each
// audience gets its own token, so participants cannot reach a file (such as
// the original video) that was only opened for the researcher. File names in
// the URL are neutral numbers, so they say nothing about what a file is. Range requests are supported because a <video> element seeks by
// asking for byte ranges; without them every seek would re-download the file.

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { IncomingMessage, ServerResponse } from 'http'

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export class ReviewMediaRoute {
  /** token → (served name → file on disk) */
  private grants = new Map<string, Map<string, string>>()

  /** Serve these files under a new token. Returns the URL path for each, in order. */
  open(filePaths: string[]): string[] {
    const token = crypto.randomBytes(16).toString('hex')
    const files = new Map<string, string>()
    this.grants.set(token, files)
    return filePaths.map((p, i) => {
      const name = `${i + 1}${path.extname(p).toLowerCase()}`
      files.set(name, p)
      return `/review/${token}/${name}`
    })
  }

  /** Stop serving everything. */
  close() {
    this.grants.clear()
  }

  revoke(url: string) {
    const token = /^\/review\/([0-9a-f]+)\//.exec(url)?.[1]
    if (token) this.grants.delete(token)
  }

  /** Handles /review/… requests; returns false for anything else. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith('/review/')) return false
    const match = /^\/review\/([0-9a-f]+)\/([^/]+)$/.exec(url.pathname)
    const files = match ? this.grants.get(match[1]) : undefined
    if (!match || !files) {
      res.writeHead(403).end()
      return true
    }
    let name: string
    try {
      name = decodeURIComponent(match[2])
    } catch {
      res.writeHead(400).end()
      return true
    }
    const filePath = files.get(name)
    if (!filePath) {
      res.writeHead(404).end()
      return true
    }
    serveFile(req, res, filePath)
    return true
  }
}

/** Send a file, honouring a single `Range: bytes=…` request. */
export function serveFile(req: IncomingMessage, res: ServerResponse, filePath: string) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end()
    return
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404).end()
      return
    }
    const size = stat.size
    const headers: Record<string, string | number> = {
      'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    }
    const range = parseRange(req.headers.range, size)
    if (range === 'invalid') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end()
      return
    }
    const [start, end] = range ?? [0, size - 1]
    const length = size === 0 ? 0 : end - start + 1
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    headers['Content-Length'] = length
    res.writeHead(range ? 206 : 200, headers)
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    const stream = fs.createReadStream(filePath, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  })
}

/** [start, end] inclusive, null for no Range header, 'invalid' for one we cannot satisfy. */
export function parseRange(header: string | undefined, size: number): [number, number] | null | 'invalid' {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start: number
  let end: number
  if (m[1] === '') {
    // Suffix range: the last N bytes.
    const n = Number(m[2])
    if (n === 0) return 'invalid'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return [start, end]
}
