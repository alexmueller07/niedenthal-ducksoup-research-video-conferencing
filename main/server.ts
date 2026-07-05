// SessionServer: the room coordinator that runs inside the researcher's app.
//
// One WebSocket per client (the two participant machines over the LAN, plus the
// researcher's own renderer over localhost). The server:
//   - assigns seats (P1, P2, ADMIN) and rebroadcasts the roster
//   - relays WebRTC signaling between any two seats
//   - routes researcher effect commands to the targeted participant
//   - owns the session phase (waiting → live → ended)
//   - logs every event through SessionLogger and streams each row back to the
//     researcher dashboard as it is written
//
// Media never touches this server — audio/video flows peer-to-peer over the
// LAN. Only control + signaling + telemetry pass through here.

import { WebSocketServer, WebSocket } from 'ws'
import os from 'os'
import type {
  ClientMessage,
  EffectState,
  ExpressionState,
  Identity,
  Phase,
  PSlot,
  RosterState,
  ServerMessage,
  SlotId,
  SlotInfo,
  Telemetry,
} from './protocol'
import { EMPTY_IDENTITY, NEUTRAL_EFFECTS, parseClientMessage } from './protocol'
import { SessionLogger, LoggedEvent, EventInput } from './logger'
import { RuleEngine, describeRule } from './rules'

interface ClientCtx {
  ws: WebSocket
  clientId: string
  slot: SlotId
  role: 'participant' | 'admin'
  identity: Identity
  ready: boolean
  effects: EffectState
  telemetry?: Telemetry
  expression?: ExpressionState
  /** Last logged expression key, so events.csv records changes, not 5 Hz spam. */
  lastExprKey?: string
  alive: boolean
}

export interface ServerStatus {
  running: boolean
  port: number
  lanIps: string[]
  sessionDir: string | null
  phase: Phase
}

let nextClientNum = 1

export class SessionServer {
  private wss: WebSocketServer | null = null
  private clients = new Map<WebSocket, ClientCtx>()
  /** Identities remembered per slot so a reconnecting participant keeps their seat. */
  private slotIdentities = new Map<SlotId, Identity>()
  private phase: Phase = 'waiting'
  private sessionStartedAt: string | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private ruleTimer: ReturnType<typeof setInterval> | null = null
  private readonly ruleEngine: RuleEngine
  readonly port: number
  readonly logger: SessionLogger

  constructor(port: number, logger: SessionLogger) {
    this.port = port
    this.logger = logger
    this.ruleEngine = new RuleEngine({
      isLive: () => this.phase === 'live',
      liveStartMs: () =>
        this.sessionStartedAt !== null ? Date.parse(this.sessionStartedAt) : null,
      effectsOf: (slot: PSlot) => this.bySlot(slot)?.effects ?? { ...NEUTRAL_EFFECTS },
      applyEffects: (slot, effects, rule, why) => {
        const target = this.bySlot(slot)
        if (target) {
          target.effects = effects
          this.send(target.ws, { type: 'effect-command', effects, cause: `rule_${why}` })
        }
        this.log({
          event: `rule_${why}`,
          actorRole: 'server',
          actorSlot: 'ADMIN',
          target: slot,
          param: 'rule',
          value: rule.id,
          detail: { rule: describeRule(rule), effects, targetConnected: !!target },
        })
        this.broadcastRoster()
      },
      onActiveChange: (active) => {
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'rule-status', active })
      },
    })
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '0.0.0.0', port: this.port })
      this.wss = wss
      wss.on('error', (err) => reject(err))
      wss.on('listening', () => {
        this.log({ event: 'server_started', detail: { port: this.port, lanIps: lanIps() } })
        resolve()
      })
      wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? ''))
      this.pingTimer = setInterval(() => this.heartbeat(), 5000)
      this.ruleTimer = setInterval(() => this.ruleEngine.tick(Date.now()), 250)
    })
  }

  status(): ServerStatus {
    return {
      running: this.wss !== null,
      port: this.port,
      lanIps: lanIps(),
      sessionDir: this.logger.dir,
      phase: this.phase,
    }
  }

  get currentPhase(): Phase {
    return this.phase
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.ruleTimer) clearInterval(this.ruleTimer)
    this.ruleTimer = null
    this.log({ event: 'server_stopped' })
    for (const ctx of this.clients.values()) ctx.ws.close()
    this.clients.clear()
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()))
    this.wss = null
    await this.logger.close()
  }

  // ---- Connection lifecycle ----

  private onConnection(ws: WebSocket, remoteAddress: string) {
    ws.on('pong', () => {
      const ctx = this.clients.get(ws)
      if (ctx) ctx.alive = true
    })
    ws.on('message', (raw) => {
      const msg = parseClientMessage(String(raw))
      if (!msg) return
      const ctx = this.clients.get(ws)
      if (!ctx) {
        if (msg.type === 'hello') this.onHello(ws, msg, remoteAddress)
        return
      }
      this.onMessage(ctx, msg)
    })
    ws.on('close', () => this.onClose(ws))
    ws.on('error', () => ws.close())
  }

  private onHello(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: 'hello' }>,
    remoteAddress: string,
  ) {
    const slot = this.assignSlot(msg)
    if (!slot) {
      this.send(ws, { type: 'rejected', reason: 'The call is full.' })
      this.log({
        event: 'client_rejected',
        actorRole: msg.role,
        actorName: msg.identity?.name ?? '',
        detail: { remoteAddress, reason: 'full' },
      })
      ws.close()
      return
    }
    // A reconnecting participant keeps the identity the researcher may have set.
    const remembered = this.slotIdentities.get(slot)
    const identity: Identity = {
      ...EMPTY_IDENTITY,
      ...(remembered ?? {}),
      ...stripEmpty(msg.identity ?? EMPTY_IDENTITY),
    }
    const ctx: ClientCtx = {
      ws,
      clientId: `c${nextClientNum++}`,
      slot,
      role: msg.role,
      identity,
      ready: false,
      effects: this.rememberedEffects(slot),
      alive: true,
    }
    this.clients.set(ws, ctx)
    this.slotIdentities.set(slot, identity)
    this.log({
      event: 'client_connected',
      actorRole: ctx.role,
      actorSlot: slot,
      actorName: identity.name,
      detail: { remoteAddress, appVersion: msg.appVersion, identity },
    })
    this.send(ws, {
      type: 'welcome',
      clientId: ctx.clientId,
      slot,
      phase: this.phase,
      roster: this.roster(),
      serverTime: new Date().toISOString(),
    })
    // A (re)connecting dashboard gets the current rule list back so mid-call
    // edits survive an admin reconnect.
    if (ctx.role === 'admin') {
      this.send(ws, { type: 'rules', rules: this.ruleEngine.currentRules })
    }
    this.broadcastRoster()
  }

  private assignSlot(msg: Extract<ClientMessage, { type: 'hello' }>): SlotId | null {
    const taken = new Set([...this.clients.values()].map((c) => c.slot))
    if (msg.role === 'admin') return taken.has('ADMIN') ? null : 'ADMIN'
    // Prefer the seat this participantId held before (reconnect case).
    const pid = msg.identity?.participantId
    if (pid) {
      for (const [slot, id] of this.slotIdentities) {
        if (slot !== 'ADMIN' && id.participantId === pid && !taken.has(slot)) return slot
      }
    }
    if (!taken.has('P1')) return 'P1'
    if (!taken.has('P2')) return 'P2'
    return null
  }

  /** Effects survive a participant reconnect so the manipulation is not silently reset. */
  private rememberedEffects(slot: SlotId): EffectState {
    for (const c of this.clients.values()) if (c.slot === slot) return c.effects
    return { ...NEUTRAL_EFFECTS }
  }

  private onClose(ws: WebSocket) {
    const ctx = this.clients.get(ws)
    if (!ctx) return
    this.clients.delete(ws)
    this.log({
      event: 'client_disconnected',
      actorRole: ctx.role,
      actorSlot: ctx.slot,
      actorName: ctx.identity.name,
    })
    this.broadcast({ type: 'peer-left', slot: ctx.slot })
    this.broadcastRoster()
  }

  private heartbeat() {
    for (const ctx of this.clients.values()) {
      if (!ctx.alive) {
        this.log({ event: 'client_timeout', actorRole: ctx.role, actorSlot: ctx.slot })
        ctx.ws.terminate()
        continue
      }
      ctx.alive = false
      ctx.ws.ping()
    }
  }

  // ---- Message handling ----

  private onMessage(ctx: ClientCtx, msg: ClientMessage) {
    switch (msg.type) {
      case 'hello':
        return // already greeted
      case 'signal': {
        const target = this.bySlot(msg.to)
        if (target) this.send(target.ws, { type: 'signal', from: ctx.slot, data: msg.data })
        return
      }
      case 'ready': {
        ctx.ready = msg.camera && msg.voice
        this.log({
          event: 'client_ready',
          actorRole: ctx.role,
          actorSlot: ctx.slot,
          actorName: ctx.identity.name,
          detail: { camera: msg.camera, faceModel: msg.faceModel, voice: msg.voice },
        })
        this.broadcastRoster()
        return
      }
      case 'telemetry': {
        ctx.telemetry = msg.data
        this.logger.effectState({
          slot: ctx.slot,
          participantId: ctx.identity.participantId,
          phase: this.phase,
          alpha: msg.data.alpha,
          voiceSemitones: msg.data.voiceSemitones,
          faceFound: msg.data.faceFound,
          fps: msg.data.fps,
          cameraOn: msg.data.cameraOn,
          expressionLabel: msg.data.expression?.label ?? '',
          smileType: msg.data.expression?.smileType ?? '',
        })
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'telemetry', slot: ctx.slot, data: msg.data })
        return
      }
      case 'expression': {
        if (ctx.slot !== 'P1' && ctx.slot !== 'P2') return
        ctx.expression = msg.data
        this.ruleEngine.onExpression(ctx.slot, msg.data)
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'expression', slot: ctx.slot, data: msg.data })
        // Log state changes only — the 5 Hz stream itself would drown events.csv.
        const key = `${msg.data.label}${msg.data.smileType ? `:${msg.data.smileType}` : ''}`
        if (ctx.lastExprKey !== key) {
          ctx.lastExprKey = key
          this.log({
            event: 'expression_changed',
            actorRole: ctx.role,
            actorSlot: ctx.slot,
            actorName: ctx.identity.name,
            param: 'expression',
            value: key,
            detail: msg.data,
          })
        }
        return
      }
      case 'stream-map': {
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'stream-map', slot: ctx.slot, map: msg.map })
        this.log({
          event: 'stream_map',
          actorRole: ctx.role,
          actorSlot: ctx.slot,
          detail: msg.map,
        })
        return
      }
      case 'client-event': {
        this.log({
          event: msg.event,
          actorRole: ctx.role,
          actorSlot: ctx.slot,
          actorName: ctx.identity.name,
          target: msg.target,
          param: msg.param,
          value: msg.value,
          detail: msg.detail,
        })
        return
      }
      // ---- Admin-only commands ----
      case 'set-identity': {
        if (!this.requireAdmin(ctx, msg.type)) return
        const target = this.bySlot(msg.slot)
        const identity = { ...EMPTY_IDENTITY, ...stripEmpty(msg.identity) }
        this.slotIdentities.set(msg.slot, identity)
        if (target) {
          target.identity = identity
          this.send(target.ws, { type: 'identity-assigned', identity })
        }
        this.log({
          event: 'identity_set_by_admin',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          target: msg.slot,
          detail: identity,
        })
        this.broadcastRoster()
        return
      }
      case 'set-effect': {
        if (!this.requireAdmin(ctx, msg.type)) return
        const target = this.bySlot(msg.slot)
        const effects: EffectState = {
          ...(target?.effects ?? NEUTRAL_EFFECTS),
          [msg.param]: msg.value,
        }
        if (target) {
          target.effects = effects
          this.send(target.ws, { type: 'effect-command', effects, cause: msg.param })
        }
        this.log({
          event: 'effect_command',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          target: msg.slot,
          param: msg.param,
          value: msg.value,
          detail: { effects, targetConnected: !!target },
        })
        this.broadcastRoster()
        return
      }
      case 'apply-preset': {
        if (!this.requireAdmin(ctx, msg.type)) return
        const target = this.bySlot(msg.slot)
        if (target) {
          target.effects = msg.effects
          this.send(target.ws, { type: 'effect-command', effects: msg.effects, cause: 'preset' })
        }
        this.log({
          event: 'preset_applied',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          target: msg.slot,
          param: 'preset',
          value: msg.presetId,
          detail: { effects: msg.effects, targetConnected: !!target },
        })
        this.broadcastRoster()
        return
      }
      case 'banner': {
        if (!this.requireAdmin(ctx, msg.type)) return
        for (const c of this.clients.values()) {
          if (c.role === 'participant') {
            this.send(c.ws, { type: 'banner', text: msg.text, durationSec: msg.durationSec })
          }
        }
        this.log({
          event: 'banner_sent',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          param: 'durationSec',
          value: msg.durationSec,
          detail: { text: msg.text },
        })
        return
      }
      case 'set-phase': {
        if (!this.requireAdmin(ctx, msg.type)) return
        this.setPhase(msg.phase, ctx.identity.name)
        return
      }
      case 'set-rules': {
        if (!this.requireAdmin(ctx, msg.type)) return
        this.ruleEngine.setRules(msg.rules)
        this.log({
          event: 'rules_updated',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          param: 'count',
          value: msg.rules.length,
          detail: msg.rules.map((r) => ({ id: r.id, enabled: r.enabled, rule: describeRule(r) })),
        })
        this.send(ctx.ws, { type: 'rules', rules: msg.rules })
        return
      }
      case 'admin-mic': {
        if (!this.requireAdmin(ctx, msg.type)) return
        this.log({
          event: msg.live ? 'admin_mic_live' : 'admin_mic_muted',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          param: 'mode',
          value: msg.mode,
        })
        return
      }
    }
  }

  private setPhase(phase: Phase, adminName: string) {
    if (phase === this.phase) return
    const from = this.phase
    this.phase = phase
    // Sessions are restartable (RA request): ended → live starts a fresh clock,
    // and going back to the waiting room clears it entirely. Recordings from
    // the earlier run are safe — restarted recorders write _partN files.
    if (phase === 'live' && (from === 'ended' || !this.sessionStartedAt)) {
      this.sessionStartedAt = new Date().toISOString()
    }
    if (phase === 'waiting') {
      this.sessionStartedAt = null
    }
    // Automation rules start from a clean slate on every phase change.
    this.ruleEngine.reset()
    this.log({
      event: `session_${phase}`,
      actorRole: 'admin',
      actorSlot: 'ADMIN',
      actorName: adminName,
      detail: { sessionStartedAt: this.sessionStartedAt, from },
    })
    this.broadcast({ type: 'phase', phase, sessionStartedAt: this.sessionStartedAt })
    this.broadcastRoster()
  }

  private requireAdmin(ctx: ClientCtx, what: string): boolean {
    if (ctx.role === 'admin') return true
    this.log({
      event: 'unauthorized_command',
      actorRole: ctx.role,
      actorSlot: ctx.slot,
      param: 'command',
      value: what,
    })
    return false
  }

  // ---- Helpers ----

  private bySlot(slot: SlotId): ClientCtx | undefined {
    for (const c of this.clients.values()) if (c.slot === slot) return c
    return undefined
  }

  private roster(): RosterState {
    const slots: Partial<Record<SlotId, SlotInfo>> = {}
    for (const c of this.clients.values()) {
      slots[c.slot] = {
        slot: c.slot,
        clientId: c.clientId,
        role: c.role,
        identity: c.identity,
        ready: c.ready,
        connected: true,
        telemetry: c.telemetry,
        effects: c.effects,
      }
    }
    return { phase: this.phase, sessionStartedAt: this.sessionStartedAt, slots }
  }

  private broadcastRoster() {
    this.broadcast({ type: 'roster', roster: this.roster() })
  }

  private broadcast(msg: ServerMessage) {
    for (const c of this.clients.values()) this.send(c.ws, msg)
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** Log to CSV and stream the row to the researcher dashboard. */
  private log(input: EventInput): LoggedEvent {
    const row = this.logger.event(input)
    const admin = this.bySlot('ADMIN')
    if (admin) {
      this.send(admin.ws, {
        type: 'log-row',
        row: {
          tsIso: row.tsIso,
          tRelMs: row.tRelMs,
          seq: row.seq,
          actorRole: row.actorRole,
          actorSlot: row.actorSlot,
          actorName: row.actorName,
          event: row.event,
          target: row.target,
          param: row.param,
          value: row.value,
          detail: row.detail,
        },
      })
    }
    return row
  }
}

/** Non-loopback IPv4 addresses, for displaying "connect participants to…". */
export function lanIps(): string[] {
  const out: string[] = []
  const ifaces = os.networkInterfaces()
  for (const list of Object.values(ifaces)) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address)
    }
  }
  return out
}

function stripEmpty(identity: Identity): Partial<Identity> {
  const out: Partial<Identity> = {}
  for (const k of ['name', 'participantId', 'dyadId', 'studyId'] as const) {
    const v = identity?.[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}
