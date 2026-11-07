// Three real WebSocket clients walk the whole study flow against a real SessionServer.
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'
import { SessionServer } from '../main/server'
import { SessionLogger } from '../main/logger'
import { EMPTY_IDENTITY } from '../main/protocol'
import { POST_CONVERSATION_ITEMS } from '../main/ratingTask'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function client(url: string, role: 'admin' | 'participant', id: string) {
  const ws = new WebSocket(url)
  const messages: any[] = []
  ws.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const send = (msg: unknown) => ws.send(JSON.stringify(msg))
  /** Next message of this type matching the filter (older ones are discarded). */
  const take = async (type: string, filter = (_m: any) => true) => {
    for (let i = 0; i < 700; i++) {
      const index = messages.findIndex((m) => m.type === type && filter(m))
      if (index >= 0) return messages.splice(0, index + 1).pop()
      await sleep(20)
    }
    throw new Error(`${id}: timed out waiting for ${type}; got ${messages.map((m) => m.type)}`)
  }
  send({
    type: 'hello',
    role,
    identity: { ...EMPTY_IDENTITY, name: id, participantId: `${id}-pid`, dyadId: 'D7' },
    appVersion: 'test',
  })
  const welcome = await take('welcome')
  return { ws, send, take, messages, slot: welcome.slot as string }
}


const logger = await SessionLogger.create(await mkdtemp(path.join(os.tmpdir(), 'flow-session-')))
const server = new SessionServer(0, logger)
await server.start()
const url = `ws://127.0.0.1:${(server as any).http.address().port}`
const clients: Awaited<ReturnType<typeof client>>[] = []
const answers = Object.fromEntries(POST_CONVERSATION_ITEMS.map(([id], i) => [id, id === 'relative_talking' ? 0 : i]))

try {
  const admin = await client(url, 'admin', 'RA')
  const p1 = await client(url, 'participant', 'Ana')
  const p2 = await client(url, 'participant', 'Ben')
  clients.push(admin, p1, p2)

  admin.send({ type: 'study-flow-arm', assignment: { firstValence: 'negative', manipulatedBlock: 1, presetId: 'smile-subtle' }, blockSec: 60 })
  await admin.take('study-flow-state', m => m.state.status === 'armed')
  admin.send({ type: 'study-flow-start' })
  assert.equal((await p1.take('study-flow-state', m => m.state.status === 'running')).state.steps[0].kind, 'survey')
  assert.equal(server.currentPhase, 'waiting')

  admin.send({ type: 'study-flow-next' }) // intro 1
  admin.send({ type: 'study-flow-next' }) // block 1
  const fx = await p1.take('effect-command', m => m.cause === 'study_flow')
  assert.equal(fx.effects.alpha, 0.35, 'block 1 is the face-change block')
  const s = await p1.take('study-flow-state', m => m.state.step === 2)
  assert.equal(s.state.steps[2].valence, 'negative')
  assert.equal(s.state.assignment, null, 'participants never see the assignment')
  assert.equal(server.currentPhase, 'live')

  admin.send({ type: 'study-flow-next' }) // rating 1
  assert.equal((await p1.take('effect-command', m => m.cause === 'study_flow' && m.effects.alpha === 0)).effects.alpha, 0)
  await p1.take('phase', m => m.phase === 'ended')
  p1.send({ type: 'study-flow-rating', step: 3, responses: { ...answers, flow: 99 } })
  assert.match((await p1.take('study-flow-error')).reason, /not valid/)
  p1.send({ type: 'study-flow-rating', step: 3, responses: answers })
  admin.send({ type: 'study-flow-next' })
  assert.match((await admin.take('study-flow-error')).reason, /both participants/)
  p2.send({ type: 'study-flow-rating', step: 3, responses: answers })
  await admin.take('study-flow-state', m => m.state.submitted.P1 && m.state.submitted.P2)
  admin.send({ type: 'study-flow-next' }) // intro 2
  admin.send({ type: 'study-flow-next' }) // block 2: no face change
  await admin.take('study-flow-state', m => m.state.step === 5)
  assert.equal(server.currentPhase, 'live')
  assert.equal((server as any).bySlot('P2').effects.alpha, 0, 'block 2 has no face change')
  assert.equal((server as any).bySlot('P1').effects.alpha, 0, 'block 2 has no face change')
  admin.send({ type: 'study-flow-next' }) // rating 2
  await p1.take('study-flow-state', m => m.state.step === 6)
  p1.send({ type: 'study-flow-rating', step: 6, responses: answers })
  admin.send({ type: 'study-flow-next', force: true }) // forced past P2
  admin.send({ type: 'study-flow-next' }) // after tiktok
  await admin.take('study-flow-state', m => m.state.status === 'complete')

  // Manual mode keeps the researcher's sliders and presets open.
  admin.send({ type: 'study-flow-arm', assignment: { firstValence: 'positive', manipulatedBlock: 1, presetId: 'manual' } })
  await admin.take('study-flow-state', m => m.state.status === 'armed' && m.state.assignment.presetId === 'manual')
  admin.send({ type: 'apply-preset', slot: 'P1', presetId: 'smile-strong', effects: { alpha: 0.5, voiceSemitones: 0, voiceSmile: 0 } })
  await sleep(150)
  assert.equal((server as any).bySlot('P1').effects.alpha, 0.5)
  assert.ok(!admin.messages.some(m => m.type === 'study-flow-error'), 'no lock in manual mode')
  admin.send({ type: 'study-flow-disarm' })

  const rows = (await readFile(path.join(logger.dir, 'study', 'partner_ratings.csv'), 'utf-8')).trim().split('\n')
  const n = POST_CONVERSATION_ITEMS.length
  assert.equal(rows.length, 1 + 3 * n, 'P1 and P2 for block 1, P1 only for block 2')
  assert.match(rows[0], /^task_version,dyad_id,participant_id,seat,partner_id,block,topic,face_changed,item/)
  assert.ok(rows[1].includes(',P1,Ben-pid,1,negative,true,'), rows[1])
  assert.ok(rows[1 + 2 * n].includes(',P1,Ben-pid,2,positive,false,'), rows[1 + 2 * n])
  const events = await readFile(logger.eventsPath, 'utf-8')
  for (const e of ['study_flow_armed', 'study_flow_started', 'study_block_started', 'study_block_ended', 'study_step_changed', 'study_ratings_submitted']) assert.ok(events.includes(e), e)
} finally {
  for (const c of clients) c.ws.close()
  await server.stop().catch(() => {})
}
console.log('study flow server checks passed')
