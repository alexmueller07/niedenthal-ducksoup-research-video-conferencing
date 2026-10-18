// Standalone session server for browser-based development and testing.
//
//   npm run server:dev
//
// Lets you exercise the full three-client flow (two participant tabs + the
// dashboard tab on http://localhost:8888) without Electron. CSVs land in
// ./scratchpad/dev-sessions/. Production never uses this entry — the server
// runs inside the researcher's Electron main process.
//
// Browser tabs cannot record, so the post-call review has nothing to play.
// Point REVIEW_FIXTURE at a JSON list of stand-in video files to review them
// instead: [{ "slot": "P1", "kind": "altered", "path": "/abs/file.mp4",
// "offsetMs": 0, "durationMs": 300000 }, …]

import fs from 'fs'
import path from 'path'
import { SessionServer, lanIps, type ReviewFixtureFile } from './server'
import { SessionLogger } from './logger'
import { DEFAULT_PORT } from './protocol'

const outputRoot = path.join(process.cwd(), 'scratchpad', 'dev-sessions')

async function main() {
  const logger = await SessionLogger.create(outputRoot)
  const server = new SessionServer(DEFAULT_PORT, logger)
  if (process.env.REVIEW_FIXTURE) {
    const files = JSON.parse(fs.readFileSync(process.env.REVIEW_FIXTURE, 'utf-8')) as ReviewFixtureFile[]
    server.setReviewFixture(files)
    console.log(`Review will play ${files.length} fixture file(s) from ${process.env.REVIEW_FIXTURE}`)
  }
  await server.start()
  console.log(`Session server listening on ws://localhost:${DEFAULT_PORT}`)
  console.log(`LAN addresses: ${lanIps().join(', ') || '(none)'}`)
  console.log(`Logging to ${logger.dir}`)
  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main()
