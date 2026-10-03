import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { WebSocket } from 'ws'
import { SessionServer } from '../main/server'
import { SessionLogger } from '../main/logger'
import { EMPTY_IDENTITY } from '../main/protocol'
import { report } from './voice_fixtures'

async function connect(url: string, role: 'admin' | 'participant', name: string) {
  const ws = new WebSocket(url)
  const messages: any[] = []
  ws.on('message', raw => messages.push(JSON.parse(String(raw))))
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ type: 'hello', role, identity: { ...EMPTY_IDENTITY, name,
    participantId: name, dyadId: 'voice-rule-qa' }, appVersion: '3.0.0' }))
  const take = async (type: string, matches: (message: any) => boolean = () => true) => {
    for (let i = 0; i < 100; i++) {
      const index = messages.findIndex(m => m.type === type && matches(m))
      if (index >= 0) return messages.splice(index, 1)[0]
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error(`Timed out waiting for ${type}`)
  }
  await take('welcome')
  return { ws, take, send: (message: unknown) => ws.send(JSON.stringify(message)) }
}

test('voice timer rule reaches participants and is logged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'voice-rule-'))
  const logger = await SessionLogger.create(root)
  const server = new SessionServer(0, logger)
  await server.start()
  const port = (server as any).wss.address().port
  const clients: Awaited<ReturnType<typeof connect>>[] = []
  try {
    const url = `ws://127.0.0.1:${port}`
    const admin = await connect(url, 'admin', 'Researcher'); clients.push(admin)
    const p1 = await connect(url, 'participant', 'P1'); clients.push(p1)
    const p2 = await connect(url, 'participant', 'P2'); clients.push(p2)
    p1.send({ type: 'voice-report', data: report() })
    p2.send({ type: 'voice-report', data: report() })
    await admin.take('voice-state', m => m.state.available.P1 && m.state.available.P2)
    admin.send({ type: 'set-rules', rules: [{ id: 'voice-timer', enabled: true,
      trigger: { kind: 'timer', atSec: 0 }, action: { kind: 'voice', slot: 'P2', mode: 'detone' },
      release: 'previous', revertAfterSec: 1 }] })
    await admin.take('rules')
    admin.send({ type: 'set-phase', phase: 'live' })
    const applied = await p2.take('voice-condition', m => m.condition.mode === 'detone')
    assert.equal(applied.condition.targetSlot, 'P2')
    await p1.take('voice-condition', m => m.condition.mode === 'detone')
    await p2.take('voice-condition', m => m.condition.mode === 'bypass')
    const events = await readFile(path.join(logger.dir, 'events.csv'), 'utf8')
    assert.match(events, /rule_turned_on/)
    assert.match(events, /rule_undone/)
    assert.match(events, /voice_rule/)
  } finally {
    clients.forEach(client => client.ws.close())
    await server.stop()
  }
})
