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
import http from 'http'
import os from 'os'
import type {
  CalibrationPhase,
  CalibrationProfile,
  ClientMessage,
  EffectState,
  ExpressionState,
  Identity,
  Phase,
  PSlot,
  ReviewAvailability,
  ReviewMedia,
  ReviewMediaPart,
  VideoVersion,
  RosterState,
  ServerMessage,
  SlotId,
  SlotInfo,
  Telemetry,
} from './protocol'
import {
  EMPTY_IDENTITY,
  NEUTRAL_EFFECTS,
  normalizeExpressionState,
  normalizeTelemetry,
  parseClientMessage,
} from './protocol'
import { SessionLogger, LoggedEvent, EventInput } from './logger'
import { RuleEngine, describeRule, validRules } from './rules'
import { VoiceSession } from './voiceSession'
import { ReviewMediaRoute } from './mediaRoute'
import { ReviewController, buildSegments, cleanText, parseReviewConfig, parseViewingStats } from './review'
import { POST_CONVERSATION_ITEMS, RATING_TASK_VERSION } from './ratingTask'
import { StudyTimeline, STUDY_BLOCK_MS, STUDY_FACE_PRESETS } from './studyTimeline'
import { DEFAULT_VOICE_CONDITION, finite, parseVoiceCondition, validVoiceReport } from './voiceProtocol'
import type { VoiceReport } from './voiceProtocol'

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
  voice?: VoiceReport
  voiceReceivedAt?: number
}

/** A finished recording file, as reported by the main process. */
export interface RecordingInfo {
  /** 'P1' | 'P2' (blank for the researcher mic) */
  slot: string
  /** 'altered' | 'clean' | 'mic' */
  kind: string
  path: string
  /** Wall-clock time the recorder started. */
  startedAtMs: number
  durationMs: number
}

/** A file standing in for a recording in browser-only development. */
export interface ReviewFixtureFile {
  slot: PSlot
  kind: VideoVersion
  path: string
  /** Where it starts on the conversation timeline. */
  offsetMs: number
  durationMs: number
}

export interface ServerStatus {
  running: boolean
  port: number
  lanIps: string[]
  sessionDir: string | null
  phase: Phase
}

let nextClientNum = 1

/** Plain-English event names for the events.csv `event` column. */
const SESSION_PHASE_EVENT_NAMES: Record<Phase, string> = {
  waiting: 'moved_to_waiting_room',
  live: 'conversation_started',
  ended: 'conversation_ended',
  review: 'moved_to_review',
}
const RULE_EVENT_NAMES: Record<'fired' | 'released' | 'reverted', string> = {
  fired: 'rule_turned_on',
  released: 'rule_turned_off',
  reverted: 'rule_undone',
}

export class SessionServer {
  private voiceSession = new VoiceSession()
  private wss: WebSocketServer | null = null
  /** Plain HTTP on the same port: the WebSocket upgrades from it, and the review streams recordings from it. */
  private http: http.Server | null = null
  private readonly media = new ReviewMediaRoute()
  private readonly review: ReviewController
  /** What participants may stream, and the researcher's full set (adds the originals). */
  private reviewMedia: ReviewMedia | null = null
  private reviewMediaBySeat: Record<PSlot, ReviewMedia> | null = null
  private reviewMediaAdmin: ReviewMedia | null = null
  private reviewTimer: ReturnType<typeof setInterval> | null = null
  /** Dev only (npm run server:dev): review these files instead of real recordings. */
  private reviewFixture: ReviewFixtureFile[] | null = null
  private clients = new Map<WebSocket, ClientCtx>()
  /** Identities remembered per slot so a reconnecting participant keeps their seat. */
  private slotIdentities = new Map<SlotId, Identity>()
  /**
   * Accepted calibration per seat. Keyed by seat but stamped with the
   * participant ID, and only handed back to a reconnecting client whose ID
   * matches — otherwise a second participant taking a freed seat would inherit
   * the first one's face measurements.
   */
  private calibrationBySlot = new Map<PSlot, CalibrationProfile>()
  /** Peak-frame screenshots for each seat, held until the profile is accepted. */
  private calibrationShots = new Map<PSlot, Record<string, string>>()
  private phase: Phase = 'waiting'
  private sessionStartedAt: string | null = null
  /** Recorders still writing; a review cannot start until they have all closed. */
  private openRecordings = new Set<string>()
  private finishedRecordings: RecordingInfo[] = []
  private continuousRatingStartedFor: string | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private ruleTimer: ReturnType<typeof setInterval> | null = null
  private readonly ruleEngine: RuleEngine
  private readonly studyTimeline: StudyTimeline
  readonly port: number
  readonly logger: SessionLogger

  constructor(port: number, logger: SessionLogger) {
    this.port = port
    this.logger = logger
    this.studyTimeline = new StudyTimeline({
      skipped: (fromBlock, toBlock) => this.log({ event: 'study_blocks_skipped', actorRole: 'server',
        detail: { fromBlock, toBlock, reason: 'timer_resumed_after_block_boundary' } }),
      apply: (block, target, alpha) => {
        for (const slot of ['P1', 'P2'] as const) {
          const participant = this.bySlot(slot)
          const effects = { ...NEUTRAL_EFFECTS, alpha: target === slot ? alpha : 0 }
          if (participant) {
            participant.effects = effects
            this.send(participant.ws, { type: 'effect-command', effects, cause: 'study_schedule' })
          }
        }
        const plannedAtMs = this.studyTimeline.state.startedAtMs === null ? null :
          this.studyTimeline.state.startedAtMs + block * STUDY_BLOCK_MS
        this.log({ event: 'study_block_applied', actorRole: 'server', target: target ?? 'both',
          param: 'block', value: block + 1,
          detail: { presetId: this.studyTimeline.state.presetId, alpha, plannedAtMs,
            appliedAtMs: Date.now(), connected: { P1: !!this.bySlot('P1'), P2: !!this.bySlot('P2') } } })
        this.broadcastRoster()
      },
      publish: (state) => {
        this.broadcast({ type: 'study-schedule-state', state })
        try {
          this.logger.studyProtocol({ version: 1, blockMs: STUDY_BLOCK_MS, blocks: [null, state.firstSeat, null,
            state.firstSeat === 'P1' ? 'P2' : 'P1'], state,
            participantIds: { P1: this.identityOf('P1').participantId, P2: this.identityOf('P2').participantId } })
        } catch (error) {
          this.log({ event: 'study_protocol_write_failed', detail: { error: String(error) } })
        }
      },
    })
    this.ruleEngine = new RuleEngine({
      phase: () => this.phase,
      liveStartMs: () =>
        this.sessionStartedAt !== null ? Date.parse(this.sessionStartedAt) : null,
      effectsOf: (slot: PSlot) => this.bySlot(slot)?.effects ?? { ...NEUTRAL_EFFECTS },
      voiceConditionOf: () => this.voiceSession.condition,
      canApplyVoice: (condition) => this.phase !== 'ended' && this.voiceSession.canApply(condition) === null,
      applyVoice: (condition, rule, why) => {
        this.applyVoiceCondition(condition)
        this.log({event: RULE_EVENT_NAMES[why], actorRole:'server', actorSlot:'ADMIN',
          target:rule.action.slot, param:'voice_rule', value:rule.id,
          detail:{rule:describeRule(rule),condition}})
      },
      applyEffects: (slot, effects, rule, why) => {
        if ((this.voiceSession.condition.mode!=='bypass'||this.voiceSession.condition.audibility) && (effects.voiceSemitones!==0||effects.voiceSmile!==0)) {
          this.log({event:'voice_rule_blocked',target:slot,detail:{rule:rule.id,reason:'Voice condition active'}})
          return
        }
        const target = this.bySlot(slot)
        if (target) {
          target.effects = effects
          this.send(target.ws, { type: 'effect-command', effects, cause: `rule_${why}` })
        }
        this.log({
          event: RULE_EVENT_NAMES[why],
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
    this.review = new ReviewController({
      now: () => Date.now(),
      publish: (state) => this.broadcast({ type: 'review-state', state }),
      log: (input) => this.log(input),
      writeResponse: (record) => this.logger.reviewAnswer(record),
      writeSamples: (slot, segment, samples) => {
        const identity = this.identityOf(slot)
        this.logger.ratingRows('samples', samples.map(sample => ({
          task_version: RATING_TASK_VERSION, dyad_id: identity.dyadId, participant_id: identity.participantId,
          seat: slot, target_id: this.identityOf(segment.targetSeat).participantId, block: segment.index,
          perspective: slot === segment.targetSeat ? 'self' : 'partner', ...sample,
        })))
      },
      writeQuestionnaire: (slot, responses) => {
        const identity = this.identityOf(slot)
        this.logger.ratingRows('questionnaire', POST_CONVERSATION_ITEMS.map(([id, question], order) => ({
          task_version: RATING_TASK_VERSION, dyad_id: identity.dyadId, participant_id: identity.participantId,
          item: id, order: order + 1, question, response: responses[id], submitted_at_ms: Date.now(),
        })))
      },
      identity: (slot) => this.identityOf(slot),
    })
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const httpServer = http.createServer((req, res) => {
        if (!this.media.handle(req, res)) res.writeHead(404).end()
      })
      const wss = new WebSocketServer({ server: httpServer })
      this.http = httpServer
      this.wss = wss
      httpServer.on('error', (err) => reject(err))
      httpServer.listen(this.port, '0.0.0.0', () => {
        this.log({ event: 'app_started', detail: { port: this.port, lanIps: lanIps() } })
        resolve()
      })
      wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? ''))
      this.pingTimer = setInterval(() => this.heartbeat(), 5000)
      this.ruleTimer = setInterval(() => { this.ruleEngine.tick(Date.now()); this.studyTimeline.tick(Date.now()) }, 250)
      this.reviewTimer = setInterval(() => this.review.tick(), 250)
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

  // ---- Recordings (reported by the main process) ----

  recordingOpened(id: string) {
    this.openRecordings.add(id)
    this.sendReviewAvailability()
  }

  recordingClosed(id: string, info: RecordingInfo) {
    this.openRecordings.delete(id)
    if (info.durationMs > 0) this.finishedRecordings.push(info)
    this.sendReviewAvailability()
  }

  /**
   * Participant recordings from the most recent live run. A restarted
   * conversation gets a new clock, so files from an earlier run are left out.
   */
  private reviewRecordings(): RecordingInfo[] {
    const liveStart = this.sessionStartedAt ? Date.parse(this.sessionStartedAt) : null
    if (liveStart === null) return []
    if (this.reviewFixture) {
      return this.reviewFixture.map((f) => ({
        slot: f.slot,
        kind: f.kind,
        path: f.path,
        startedAtMs: liveStart + f.offsetMs,
        durationMs: f.durationMs,
      }))
    }
    return this.finishedRecordings.filter(
      (r) =>
        (r.slot === 'P1' || r.slot === 'P2') &&
        (r.kind === 'altered' || r.kind === 'clean') &&
        r.startedAtMs >= liveStart - 5000,
    )
  }

  /** Length of the recorded conversation: from its start to the end of the last file. */
  private conversationMs(recs: RecordingInfo[]): number {
    const liveStart = this.sessionStartedAt ? Date.parse(this.sessionStartedAt) : 0
    let end = 0
    for (const r of recs) end = Math.max(end, r.startedAtMs - liveStart + r.durationMs)
    return end
  }

  reviewAvailability(): ReviewAvailability {
    const recs = this.reviewRecordings()
    const conversationMs = this.conversationMs(recs)
    const missing: string[] = []
    for (const slot of ['P1', 'P2'] as const) {
      for (const kind of ['altered', 'clean'] as const) {
        if (!recs.some((r) => r.slot === slot && r.kind === kind)) {
          missing.push(`${this.identityOf(slot).name || slot}'s ${kind === 'altered' ? 'changed' : 'original'} video`)
        }
      }
    }
    const warning = recs.length > 0 && missing.length > 0 ? `Not recorded: ${missing.join(', ')}.` : ''
    const base = { conversationMs, recordingsOpen: this.openRecordings.size, warning }
    if (this.phase === 'review') return { ...base, canStart: false, reason: 'The review is running.' }
    if (this.phase !== 'ended') return { ...base, canStart: false, reason: 'End the conversation first.' }
    if (this.openRecordings.size > 0) return { ...base, canStart: false, reason: 'Saving the recordings…' }
    if (recs.length === 0) {
      return { ...base, canStart: false, reason: 'No recordings were made of this conversation.' }
    }
    if (conversationMs < 1000) return { ...base, canStart: false, reason: 'The recording is too short to review.' }
    return { ...base, canStart: true, reason: '' }
  }

  setReviewFixture(files: ReviewFixtureFile[]) {
    this.reviewFixture = files
  }

  /**
   * Start the post-call review: open the recordings for streaming, move
   * everyone to the review phase, and begin turn 1. Returns an error message
   * instead if it cannot start.
   */
  private startReview(rawConfig: unknown, adminName: string): string | null {
    const availability = this.reviewAvailability()
    if (!availability.canStart) return availability.reason
    const config = parseReviewConfig(rawConfig)
    if (config.task === 'continuous' && this.continuousRatingStartedFor === this.sessionStartedAt)
      return 'Ratings have already started for this conversation. Start a new conversation to run the task again.'
    const recs = this.reviewRecordings().sort((a, b) => a.startedAtMs - b.startedAtMs)
    const liveStart = Date.parse(this.sessionStartedAt as string)
    if (config.task === 'continuous') {
      for (const slot of ['P1', 'P2'] as const) for (const kind of ['clean', 'altered'] as const) {
        const spans = recs.filter(r => r.slot === slot && r.kind === kind)
          .map(r => [r.startedAtMs - liveStart, r.startedAtMs - liveStart + r.durationMs] as const)
          .sort((a, b) => a[0] - b[0])
        let coveredTo = 0
        for (const [from, to] of spans) {
          if (from > coveredTo + 2000) break
          coveredTo = Math.max(coveredTo, to)
        }
        if (coveredTo < availability.conversationMs - 2000 || !spans.length)
          return `Rating task cannot start: ${slot} ${kind} recording has a gap or is missing. Check Session Data.`
      }
    }
    // The researcher's preview gets everything. Participants get the original
    // recordings only when the settings allow it: the files are not even
    // reachable for them otherwise, not merely hidden on screen.
    this.reviewMediaAdmin = this.openReviewMedia(recs, liveStart)
    if (config.task === 'continuous') {
      this.reviewMedia = null
      this.reviewMediaBySeat = {
        P1: this.openReviewMedia(recs.filter(r => r.kind === (r.slot === 'P1' ? 'clean' : 'altered')), liveStart),
        P2: this.openReviewMedia(recs.filter(r => r.kind === (r.slot === 'P2' ? 'clean' : 'altered')), liveStart),
      }
    } else {
      const forParticipants = config.showOriginal ? recs : recs.filter(r => r.kind === 'altered')
      this.reviewMedia = this.openReviewMedia(forParticipants, liveStart)
      this.reviewMediaBySeat = null
    }
    this.setPhase('review', adminName)
    for (const c of this.clients.values()) this.sendReviewMedia(c, config)
    const connected = { P1: !!this.bySlot('P1'), P2: !!this.bySlot('P2') }
    const segments = buildSegments(availability.conversationMs, config)
    if (segments.length === 0) {
      this.setPhase('ended', adminName)
      return 'The recording is too short to review.'
    }
    // Its folder and settings note exist before the first answer comes in.
    const first = this.identityOf(config.firstSeat).name
    this.logger.startReview({
      config,
      conversationMs: availability.conversationMs,
      turns: segments.length,
      firstPerson: first ? `${first} (${config.firstSeat})` : config.firstSeat,
    })
    const error = this.review.start(config, availability.conversationMs, connected)
    if (!error && config.task === 'continuous') this.continuousRatingStartedFor = this.sessionStartedAt
    return error
  }

  /** Serve these recordings under a fresh token and place them on the conversation timeline. */
  private openReviewMedia(recs: RecordingInfo[], liveStart: number): ReviewMedia {
    const urls = this.media.open(recs.map((r) => r.path))
    const media: ReviewMedia = {
      P1: { altered: [], clean: [] },
      P2: { altered: [], clean: [] },
    }
    recs.forEach((r, i) => {
      const part: ReviewMediaPart = {
        url: urls[i],
        offsetMs: r.startedAtMs - liveStart,
        durationMs: r.durationMs,
      }
      media[r.slot as PSlot][r.kind as VideoVersion].push(part)
    })
    return media
  }

  private sendReviewMedia(ctx: ClientCtx, config = this.review.state.config) {
    let media = ctx.role === 'admin' ? this.reviewMediaAdmin : this.reviewMedia
    if (config.task === 'continuous' && ctx.role !== 'admin' && ctx.slot !== 'ADMIN')
      media = this.reviewMediaBySeat?.[ctx.slot] ?? null
    this.send(ctx.ws, { type: 'review-media', media })
  }

  /** Send a (re)joining client everything it needs to show the review. */
  private sendReviewTo(ctx: ClientCtx) {
    if (!this.review.active) return
    this.sendReviewMedia(ctx)
    this.send(ctx.ws, { type: 'review-state', state: this.review.state })
    if (ctx.slot === 'P1' || ctx.slot === 'P2') {
      const draft = this.review.draftFor(ctx.slot)
      if (draft && (draft.text || draft.submitted)) this.send(ctx.ws, { type: 'review-draft', ...draft })
    }
  }

  private identityOf(slot: SlotId): Identity {
    return this.bySlot(slot)?.identity ?? this.slotIdentities.get(slot) ?? EMPTY_IDENTITY
  }

  private sendReviewAvailability() {
    const admin = this.bySlot('ADMIN')
    if (admin) this.send(admin.ws, { type: 'review-availability', availability: this.reviewAvailability() })
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.ruleTimer) clearInterval(this.ruleTimer)
    this.ruleTimer = null
    if (this.reviewTimer) clearInterval(this.reviewTimer)
    this.reviewTimer = null
    // A review still running keeps what was written so far.
    this.review.stop()
    this.log({ event: 'app_stopped' })
    for (const ctx of this.clients.values()) ctx.ws.close()
    this.clients.clear()
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()))
    this.wss = null
    this.media.close()
    const httpServer = this.http
    this.http = null
    if (httpServer) {
      httpServer.closeAllConnections()
      await new Promise<void>((r) => httpServer.close(() => r()))
    }
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
        event: 'join_blocked',
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
      event: 'person_joined',
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
      this.send(ws, { type: 'study-schedule-state', state: this.studyTimeline.state })
      this.send(ws, { type: 'voice-state', state: this.voiceSession.snapshot() })
      this.send(ws, { type: 'review-availability', availability: this.reviewAvailability() })
    }
    if (slot === 'P1' || slot === 'P2') this.restoreCalibration(slot, identity)
    this.sendReviewTo(ctx)
    if (slot === 'P1' || slot === 'P2') this.review.connection(slot, true)
    this.broadcastRoster()
  }

  /**
   * Hand a reconnecting participant their own calibration back — and only
   * their own. If a different person is now in this seat, the stored profile
   * is dropped rather than applied, because calibration describes one specific
   * face and using it on another would silently mis-scale their morph.
   */
  private restoreCalibration(slot: PSlot, identity: Identity) {
    const stored = this.calibrationBySlot.get(slot)
    if (!stored) return
    const pid = identity.participantId.trim()
    if (pid && stored.participantId && pid !== stored.participantId) {
      this.calibrationBySlot.delete(slot)
      this.calibrationShots.delete(slot)
      const admin = this.bySlot('ADMIN')
      if (admin) this.send(admin.ws, { type: 'calibration-profile', profile: null })
      this.log({
        event: 'calibration_cleared',
        actorSlot: slot,
        actorName: identity.name,
        target: slot,
        param: 'reason',
        value: 'different_participant',
        detail: { was: stored.participantId, now: pid },
      })
      return
    }
    const target = this.bySlot(slot)
    if (target) this.send(target.ws, { type: 'calibration-profile', profile: stored })
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
    if (ctx.slot === 'P1' || ctx.slot === 'P2') {
      if (this.studyTimeline.state.status === 'running') this.studyTimeline.interrupt()
      this.voiceSession.disconnect(ctx.slot)
      this.ruleEngine.onExpression(ctx.slot,null)
      this.review.connection(ctx.slot, false)
      const other=this.bySlot(otherSlot(ctx.slot))
      if (other) this.send(other.ws,{type:'voice-partner-turn',turn:null})
    }
    this.log({
      event: 'person_left',
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
        this.log({ event: 'connection_lost', actorRole: ctx.role, actorSlot: ctx.slot })
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
      case 'voice-clock': {
        if (finite(msg.sentAt)) this.send(ctx.ws,{type:'voice-clock',sentAt:msg.sentAt,serverAt:Date.now()})
        return
      }
      case 'voice-report': {
        if ((ctx.slot !== 'P1' && ctx.slot !== 'P2') || !validVoiceReport(msg.data)) return
        const now=Date.now()
        if (now-(ctx.voiceReceivedAt??0)<150 || msg.data.sequence<=(ctx.voice?.sequence??-1)) return
        const previous=ctx.voice
        ctx.voice=msg.data;ctx.voiceReceivedAt=now
        const turns=this.voiceSession.update(ctx.slot,msg.data)
        const pair=this.voiceSession.snapshot()
        this.logger.voice.write({slot:ctx.slot,participantId:ctx.identity.participantId,dyadId:ctx.identity.dyadId,
          partnerId:this.bySlot(otherSlot(ctx.slot))?.identity.participantId,phase:this.phase,liveStartedAtMs:this.sessionStartedAt?Date.parse(this.sessionStartedAt):null},msg.data,pair,turns)
        const admin=this.bySlot('ADMIN')
        if (admin) this.send(admin.ws,{type:'voice-state',state:pair})
        const partner=this.bySlot(otherSlot(ctx.slot))
        if (partner && turns.some(t=>t.valid)) this.send(partner.ws,{type:'voice-partner-turn',turn:this.voiceSession.lastTurn(ctx.slot)})
        if (previous?.calibration.state!==msg.data.calibration.state)
          this.log({event:'voice_calibration_state',actorSlot:ctx.slot,value:msg.data.calibration.state,detail:msg.data.calibration})
        if (previous?.health.state!==msg.data.health.state)
          this.log({event:'voice_processor_state',actorSlot:ctx.slot,value:msg.data.health.state,detail:msg.data.health})
        if (previous?.applied.fallbackReason!==msg.data.applied.fallbackReason)
          this.log({event:'voice_fallback_changed',actorSlot:ctx.slot,detail:{reason:msg.data.applied.fallbackReason}})
        return
      }
      case 'voice-condition': {
        if (!this.requireAdmin(ctx,msg.type)) return
        if (this.scheduleLocked()) { this.send(ctx.ws,{type:'study-schedule-error',reason:'The timed study schedule owns face and voice settings. End the session to change them.'});return }
        const condition=parseVoiceCondition(msg.condition)
        const reason=!condition?'Invalid voice condition':this.phase==='ended'&&condition.mode!=='bypass'?'Session has ended':this.voiceSession.canApply(condition)
        if (reason || !condition) {this.send(ctx.ws,{type:'voice-error',reason:reason!});return}
        this.applyVoiceCondition(condition)
        this.log({event:'voice_condition_changed',actorRole:'admin',actorName:ctx.identity.name,target:condition.targetSlot??'both',detail:condition})
        this.send(ctx.ws,{type:'voice-state',state:this.voiceSession.snapshot()})
        return
      }
      case 'voice-reset': {
        if (!this.requireAdmin(ctx,msg.type) || !['P1','P2'].includes(msg.slot)) return
        if (this.scheduleLocked()) { this.send(ctx.ws,{type:'study-schedule-error',reason:'The timed study schedule is armed or active.'});return }
        this.voiceSession.condition={...DEFAULT_VOICE_CONDITION}
        this.logger.voice.condition(this.voiceSession.condition)
        this.broadcast({type:'voice-condition',condition:this.voiceSession.condition})
        const target=this.bySlot(msg.slot)
        if (target) { this.send(target.ws,{type:'voice-reset'});target.voice=undefined }
        this.voiceSession.disconnect(msg.slot)
        const partner=this.bySlot(otherSlot(msg.slot))
        if (partner) this.send(partner.ws,{type:'voice-partner-turn',turn:null})
        this.send(ctx.ws,{type:'voice-state',state:this.voiceSession.snapshot()})
        this.log({event:'voice_calibration_reset',actorRole:'admin',target:msg.slot})
        return
      }
      case 'hello':
        return // already greeted
      case 'signal': {
        const target = this.bySlot(msg.to)
        if (target) this.send(target.ws, { type: 'signal', from: ctx.slot, data: msg.data })
        return
      }
      case 'ready': {
        this.send(ctx.ws,{type:'voice-condition',condition:this.voiceSession.condition})
        ctx.ready = msg.camera && msg.voice
        this.log({
          event: 'camera_mic_ready',
          actorRole: ctx.role,
          actorSlot: ctx.slot,
          actorName: ctx.identity.name,
          detail: { camera: msg.camera, faceModel: msg.faceModel, voice: msg.voice },
        })
        this.broadcastRoster()
        return
      }
      case 'telemetry': {
        const telemetry = normalizeTelemetry(msg.data)
        ctx.telemetry = telemetry
        const partner = ctx.slot === 'P1' || ctx.slot === 'P2' ? this.bySlot(otherSlot(ctx.slot)) : undefined
        this.logger.effectState({
          voice: ctx.voice,
          slot: ctx.slot,
          participantId: ctx.identity.participantId,
          dyadId: ctx.identity.dyadId,
          partnerId: partner?.identity.participantId,
          phase: this.phase,
          liveStartedAtMs: this.sessionStartedAt ? Date.parse(this.sessionStartedAt) : null,
          selfAlpha: telemetry.alpha,
          selfVoiceSemitones: telemetry.voiceSemitones,
          selfVoiceSmile: telemetry.voiceSmile,
          partnerAlpha: partner?.telemetry?.alpha,
          partnerVoiceSemitones: partner?.telemetry?.voiceSemitones,
          partnerVoiceSmile: partner?.telemetry?.voiceSmile,
          faceFound: telemetry.faceFound,
          fps: telemetry.fps,
          cameraOn: telemetry.cameraOn,
          expressionLabel: telemetry.expression?.label ?? '',
          smileType: telemetry.expression?.smileType ?? '',
          labelConfidence: telemetry.expression?.labelConfidence,
          smileTypeConfidence: telemetry.expression?.smileTypeConfidence,
          smileTypeTrusted: telemetry.expression?.smileTypeTrusted,
          normalizedSmile: telemetry.expression?.normalizedSmile,
          normalizedFrown: telemetry.expression?.normalizedFrown,
          normalizedOpenness: telemetry.expression?.normalizedOpenness,
          smileMargin: telemetry.expression?.smileMargin,
          frownMargin: telemetry.expression?.frownMargin,
          normalizationApplied: telemetry.expression?.normalizationApplied,
          normalizationVersion: telemetry.expression?.normalizationVersion,
          classifierMode: telemetry.expression?.classifierMode,
          classifierVersion: telemetry.expression?.classifierVersion,
          calibrated: telemetry.calibration?.calibrated,
          commandedAlpha: telemetry.alpha,
          appliedAlpha: telemetry.calibration?.appliedAlpha,
          liveLevel: telemetry.calibration?.liveLevel,
          headroom: telemetry.calibration?.headroom,
          talking: telemetry.calibration?.talking,
          rawMouthSmileLeft: telemetry.expression?.rawMouthSmileLeft,
          rawMouthSmileRight: telemetry.expression?.rawMouthSmileRight,
          rawMouthFrownLeft: telemetry.expression?.rawMouthFrownLeft,
          rawMouthFrownRight: telemetry.expression?.rawMouthFrownRight,
          rawLipPressLeft: telemetry.expression?.rawLipPressLeft,
          rawLipPressRight: telemetry.expression?.rawLipPressRight,
          rawUpperLipRaiseLeft: telemetry.expression?.rawUpperLipRaiseLeft,
          rawUpperLipRaiseRight: telemetry.expression?.rawUpperLipRaiseRight,
          rawJawOpen: telemetry.expression?.rawJawOpen,
          rawLowerLipDropLeft: telemetry.expression?.rawLowerLipDropLeft,
          rawLowerLipDropRight: telemetry.expression?.rawLowerLipDropRight,
          rawEyeSquintLeft: telemetry.expression?.rawEyeSquintLeft,
          rawEyeSquintRight: telemetry.expression?.rawEyeSquintRight,
          rawCheekSquintLeft: telemetry.expression?.rawCheekSquintLeft,
          rawCheekSquintRight: telemetry.expression?.rawCheekSquintRight,
        })
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'telemetry', slot: ctx.slot, data: telemetry })
        return
      }
      case 'expression': {
        if (ctx.slot !== 'P1' && ctx.slot !== 'P2') return
        const expression = normalizeExpressionState(msg.data)
        if (!expression) return
        ctx.expression = expression
        this.ruleEngine.onExpression(ctx.slot, expression)
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'expression', slot: ctx.slot, data: expression })
        // Log state changes only — the 5 Hz stream itself would drown events.csv.
        const key = `${expression.label}${expression.smileType ? `:${expression.smileType}` : ''}`
        if (ctx.lastExprKey !== key) {
          ctx.lastExprKey = key
          this.log({
            event: 'expression_changed',
            actorRole: ctx.role,
            actorSlot: ctx.slot,
            actorName: ctx.identity.name,
            param: 'expression',
            value: key,
            detail: expression,
          })
        }
        return
      }
      case 'stream-map': {
        const admin = this.bySlot('ADMIN')
        if (admin) this.send(admin.ws, { type: 'stream-map', slot: ctx.slot, map: msg.map })
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
      case 'calibration-phase': {
        if (ctx.slot !== 'P1' && ctx.slot !== 'P2') return
        const admin = this.bySlot('ADMIN')
        if (admin) {
          this.send(admin.ws, { type: 'calibration-phase', slot: ctx.slot, message: msg.message })
        }
        // The screenshot is a data URL of a real participant's face — it goes
        // to the researcher's screen and to disk, never into the event log.
        if (msg.message.screenshotDataUrl) {
          const shots = this.calibrationShots.get(ctx.slot) ?? {}
          shots[msg.message.summary.phase] = msg.message.screenshotDataUrl
          this.calibrationShots.set(ctx.slot, shots)
        }
        const { screenshotDataUrl: _omitted, ...loggable } = msg.message
        this.log({
          event:
            msg.message.summary.status === 'needs-redo'
              ? 'calibration_retake_recommended'
              : 'calibration_step_completed',
          actorRole: ctx.role,
          actorSlot: ctx.slot,
          actorName: ctx.identity.name,
          param: 'phase',
          value: msg.message.summary.phase,
          detail: loggable,
        })
        return
      }
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
          event: 'name_or_id_entered',
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
        if (this.scheduleLocked()) { this.send(ctx.ws,{type:'study-schedule-error',reason:'The timed study schedule is armed or active.'});return }
        if ((msg.param==='voiceSemitones'||msg.param==='voiceSmile') && (this.voiceSession.condition.mode!=='bypass'||this.voiceSession.condition.audibility)) {
          this.send(ctx.ws,{type:'voice-error',reason:'Bypass voice synchrony before using legacy pitch controls'})
          return
        }
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
          event: 'setting_changed',
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
        if (this.scheduleLocked()) { this.send(ctx.ws,{type:'study-schedule-error',reason:'The timed study schedule is armed or active.'});return }
        if ((this.voiceSession.condition.mode!=='bypass'||this.voiceSession.condition.audibility) && (msg.effects.voiceSemitones!==0||msg.effects.voiceSmile!==0)) {
          this.send(ctx.ws,{type:'voice-error',reason:'Bypass voice synchrony before using a legacy voice preset'})
          return
        }
        const target = this.bySlot(msg.slot)
        if (target) {
          target.effects = msg.effects
          this.send(target.ws, { type: 'effect-command', effects: msg.effects, cause: 'preset' })
        }
        this.log({
          event: 'preset_used',
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
          event: 'message_sent',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          param: 'durationSec',
          value: msg.durationSec,
          detail: { text: msg.text },
        })
        return
      }
      case 'calibration-start': {
        if (!this.requireAdmin(ctx, msg.type)) return
        const phases = normalizeCalibrationPhases(msg.phases)
        const slots = msg.target === 'both' ? (['P1', 'P2'] as const) : ([msg.target] as const)

        if (this.phase !== 'waiting') {
          this.log({
            event: 'calibration_rejected',
            actorRole: 'admin',
            actorSlot: 'ADMIN',
            actorName: ctx.identity.name,
            target: msg.target,
            param: 'phase',
            value: this.phase,
            detail: { reason: 'Calibration can only run in the waiting room.', phases },
          })
          return
        }

        for (const slot of slots) {
          const target = this.bySlot(slot)
          const requestId = `cal_${Date.now()}_${slot}_${Math.random().toString(36).slice(2, 8)}`
          if (target) {
            this.send(target.ws, { type: 'calibration-start', requestId, phases })
          }
          this.log({
            event: 'calibration_started',
            actorRole: 'admin',
            actorSlot: 'ADMIN',
            actorName: ctx.identity.name,
            target: slot,
            param: 'phases',
            value: phases.join('|'),
            detail: { requestId, phases, targetConnected: !!target },
          })
        }
        return
      }
      case 'calibration-apply': {
        if (!this.requireAdmin(ctx, msg.type)) return
        const target = this.bySlot(msg.target)
        // Remembered against the participant ID, not the seat, so a reconnect
        // can only get its own calibration back (see restoreCalibration).
        this.calibrationBySlot.set(msg.target, msg.profile)
        if (target) {
          this.send(target.ws, { type: 'calibration-profile', profile: msg.profile })
        }
        void this.logger?.writeCalibration(msg.target, msg.profile, this.calibrationShots.get(msg.target) ?? {})
        this.log({
          event: 'calibration_applied',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          target: msg.target,
          param: 'participant_id',
          value: msg.profile.participantId,
          detail: { ...msg.profile, targetConnected: !!target },
        })
        return
      }
      case 'calibration-clear': {
        if (!this.requireAdmin(ctx, msg.type)) return
        this.calibrationBySlot.delete(msg.target)
        this.calibrationShots.delete(msg.target)
        const target = this.bySlot(msg.target)
        if (target) this.send(target.ws, { type: 'calibration-profile', profile: null })
        this.log({
          event: 'calibration_cleared',
          actorRole: 'admin',
          actorSlot: 'ADMIN',
          actorName: ctx.identity.name,
          target: msg.target,
        })
        return
      }
      case 'set-phase': {
        if (!this.requireAdmin(ctx, msg.type)) return
        if (msg.phase === 'live' && this.studyTimeline.state.status === 'armed' &&
          (!this.bySlot('P1') || !this.bySlot('P2'))) {
          this.send(ctx.ws, { type: 'study-schedule-error', reason: 'Both participants must be connected before starting the timed schedule.' })
          return
        }
        // The review starts only through review-start (it needs the recordings),
        // and is left only by ending it.
        if (msg.phase === 'review') return
        if (this.phase === 'review' && msg.phase !== 'ended') return
        this.setPhase(msg.phase, ctx.identity.name)
        return
      }
      case 'review-start': {
        if (!this.requireAdmin(ctx, msg.type)) return
        const err = this.startReview(msg.config, ctx.identity.name)
        if (err) this.send(ctx.ws, { type: 'review-error', reason: err })
        return
      }
      case 'review-control': {
        const by = ctx.role === 'admin' ? 'researcher' : ctx.slot === 'ADMIN' ? null : ctx.slot
        if (!by) return
        const err = this.review.control(msg.action, by)
        if (err) this.send(ctx.ws, { type: 'review-error', reason: err })
        return
      }
      case 'review-ready': {
        if (ctx.slot === 'P1' || ctx.slot === 'P2') this.review.ready(ctx.slot, msg.loadSeq)
        return
      }
      case 'rating-questionnaire': {
        if (ctx.slot === 'ADMIN') return
        try { this.review.questionnaire(ctx.slot, msg.responses) }
        catch { this.send(ctx.ws, { type: 'review-error', reason: 'Could not save answers. Please retry; the task has not advanced.' }) }
        return
      }
      case 'rating-samples': {
        if (ctx.slot === 'ADMIN') return
        try {
          const sequence = this.review.samples(ctx.slot, msg.turn, msg.samples)
          this.send(ctx.ws, { type: 'rating-ack', turn: msg.turn, sequence })
        } catch { this.send(ctx.ws, { type: 'review-error', reason: 'Could not save ratings. Keep this screen open and notify the researcher.' }) }
        return
      }
      case 'review-buffering': {
        if (ctx.slot === 'P1' || ctx.slot === 'P2') this.review.buffering(ctx.slot, msg.loadSeq)
        return
      }
      case 'review-draft':
      case 'review-submit': {
        if (ctx.slot !== 'P1' && ctx.slot !== 'P2') return
        const text = cleanText(msg.text)
        const stats = parseViewingStats(msg.stats)
        if (msg.type === 'review-draft') this.review.draft(ctx.slot, msg.turn, text, stats)
        else {
          try { this.review.submit(ctx.slot, msg.turn, text, stats, msg.elicitation) }
          catch { this.send(ctx.ws, { type: 'review-error', reason: 'Could not save the reflection. Please retry.' }) }
        }
        return
      }
      case 'set-rules': {
        if (!this.requireAdmin(ctx, msg.type)) return
        if (this.scheduleLocked() && msg.rules.some(rule => rule.enabled)) {
          this.send(ctx.ws,{type:'study-schedule-error',reason:'Disable automation rules before using the timed study schedule.'})
          return
        }
        if (!validRules(msg.rules)) {
          this.send(ctx.ws,{type:'voice-error',reason:'Invalid automation rule'})
          return
        }
        this.ruleEngine.setRules(msg.rules)
        this.log({
          event: 'rules_changed',
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
      case 'study-schedule-arm': {
        if (!this.requireAdmin(ctx, msg.type)) return
        if (this.phase !== 'waiting' || !this.bySlot('P1') || !this.bySlot('P2') ||
          this.ruleEngine.currentRules.some(rule => rule.enabled) ||
          this.voiceSession.condition.mode !== 'bypass' || this.voiceSession.condition.audibility) {
          this.send(ctx.ws, { type: 'study-schedule-error', reason: 'Connect both participants, return to the waiting room, and disable other face/voice automation before arming.' })
          return
        }
        if (!STUDY_FACE_PRESETS.some(p => p.id === msg.presetId) || !['P1', 'P2'].includes(msg.firstSeat)) {
          this.send(ctx.ws, { type: 'study-schedule-error', reason: 'Choose a face-only preset and a valid participant order.' })
          return
        }
        try {
          this.logger.studyProtocol({ version: 1, blockMs: STUDY_BLOCK_MS,
            blocks: [null, msg.firstSeat, null, msg.firstSeat === 'P1' ? 'P2' : 'P1'],
            state: { status: 'armed', presetId: msg.presetId, firstSeat: msg.firstSeat },
            participantIds: { P1: this.identityOf('P1').participantId, P2: this.identityOf('P2').participantId } })
        } catch {
          this.send(ctx.ws, { type: 'study-schedule-error', reason: 'Could not save the study schedule. Check session storage before starting.' })
          return
        }
        if (!this.studyTimeline.arm(msg.presetId, msg.firstSeat)) {
          this.send(ctx.ws, { type: 'study-schedule-error', reason: 'Choose a face-only preset and a valid participant order.' })
          return
        }
        this.log({ event: 'study_schedule_armed', actorRole: 'admin', actorName: ctx.identity.name,
          detail: { presetId: msg.presetId, firstSeat: msg.firstSeat, blockMs: STUDY_BLOCK_MS } })
        return
      }
      case 'study-schedule-disarm': {
        if (!this.requireAdmin(ctx, msg.type)) return
        if (!this.studyTimeline.disarm()) this.send(ctx.ws, { type: 'study-schedule-error', reason: 'A running schedule can only be stopped by ending the session.' })
        else this.log({ event: 'study_schedule_disarmed', actorRole: 'admin', actorName: ctx.identity.name })
        return
      }
      case 'admin-mic': {
        if (!this.requireAdmin(ctx, msg.type)) return
        this.log({
          event: msg.live ? 'researcher_mic_on' : 'researcher_mic_off',
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

  private applyVoiceCondition(condition: typeof DEFAULT_VOICE_CONDITION) {
    this.voiceSession.condition={...condition}
    if (condition.mode!=='bypass'||condition.audibility) {
      for (const participant of this.clients.values()) {
        if (participant.role!=='participant') continue
        participant.effects={...participant.effects,voiceSemitones:0,voiceSmile:0}
        this.send(participant.ws,{type:'effect-command',effects:participant.effects,cause:'voice_condition'})
      }
      this.broadcastRoster()
    }
    this.logger.voice.condition(condition)
    this.broadcast({type:'voice-condition',condition})
    const admin=this.bySlot('ADMIN')
    if (admin) this.send(admin.ws,{type:'voice-state',state:this.voiceSession.snapshot()})
  }

  private setPhase(phase: Phase, adminName: string) {
    if (phase === this.phase) return
    const from = this.phase
    this.phase = phase
    if (from === 'review') {
      this.review.stop()
      this.media.close()
      this.reviewMedia = null
      this.reviewMediaBySeat = null
      this.reviewMediaAdmin = null
      this.broadcast({ type: 'review-media', media: null })
    }
    if (phase==='ended') {
      this.voiceSession.condition={...DEFAULT_VOICE_CONDITION}
      this.broadcast({type:'voice-condition',condition:this.voiceSession.condition})
      this.logger.voice.condition(this.voiceSession.condition)
    }
    // Sessions are restartable (RA request): ended → live starts a fresh clock,
    // and going back to the waiting room clears it entirely. Recordings from
    // the earlier run are safe — restarted recorders write _partN files.
    if (phase === 'live' && (from === 'ended' || !this.sessionStartedAt)) {
      this.sessionStartedAt = new Date().toISOString()
    }
    if (phase === 'waiting') {
      this.sessionStartedAt = null
    }
    if (phase === 'live' && this.studyTimeline.state.status === 'armed' && this.sessionStartedAt)
      this.studyTimeline.start(Date.parse(this.sessionStartedAt))
    else if (phase === 'ended' || phase === 'waiting') this.studyTimeline.interrupt()
    // Rules: going live re-arms the timers; ending or returning to the
    // waiting room releases anything a rule left applied.
    this.ruleEngine.onPhaseChange(phase)
    this.log({
      // Leaving the review is not the end of the conversation; keep that row unique.
      event: from === 'review' ? 'review_closed' : SESSION_PHASE_EVENT_NAMES[phase],
      actorRole: 'admin',
      actorSlot: 'ADMIN',
      actorName: adminName,
      detail: { sessionStartedAt: this.sessionStartedAt, from },
    })
    this.broadcast({ type: 'phase', phase, sessionStartedAt: this.sessionStartedAt })
    this.broadcastRoster()
    this.sendReviewAvailability()
  }

  private requireAdmin(ctx: ClientCtx, what: string): boolean {
    if (ctx.role === 'admin') return true
    this.log({
      event: 'blocked_action',
      actorRole: ctx.role,
      actorSlot: ctx.slot,
      param: 'command',
      value: what,
    })
    return false
  }

  private scheduleLocked(): boolean {
    const status = this.studyTimeline.state.status
    return status === 'armed' || status === 'running' || (status === 'complete' && this.phase === 'live')
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

/** The other participant seat in a P1/P2 pair. */
function otherSlot(slot: PSlot): PSlot {
  return slot === 'P1' ? 'P2' : 'P1'
}

function stripEmpty(identity: Identity): Partial<Identity> {
  const out: Partial<Identity> = {}
  for (const k of ['name', 'participantId', 'dyadId', 'studyId'] as const) {
    const v = identity?.[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}

function normalizeCalibrationPhases(input: unknown): CalibrationPhase[] {
  const allowed: CalibrationPhase[] = ['neutral', 'smileClosed', 'smileOpen', 'frown']
  const steps = Array.isArray(input)
    ? input.filter((phase): phase is CalibrationPhase => allowed.includes(phase))
    : []
  return steps.length > 0 ? steps : allowed
}
