// Researcher dashboard. The invisible third seat.
//
// This machine hosts the session server (Electron main process). The dashboard:
//   - shows both participants live, with a Clean ⇄ Altered monitor toggle
//     (altered = exactly what the partner sees)
//   - drives the face/voice modification per participant, with named presets
//   - shows 1 Hz applied-state telemetry straight from each participant machine
//   - sends timed banners, can unmute the researcher mic (toggle or hold)
//   - records every stream (clean + altered per participant + researcher mic)
//     in 1-second chunks streamed to disk
//   - streams the live event log (the same rows landing in events.csv)

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { SignalClient, SignalStatus } from '../lib/signaling'
import { PeerLink } from '../lib/rtc'
import { PRESETS } from '../lib/presets'
import {
  APP_VERSION,
  DEFAULT_PORT,
  NEUTRAL_EFFECTS,
} from '../lib/protocol'
import type {
  EffectState,
  Identity,
  LogRow,
  Phase,
  RosterState,
  SignalData,
  StreamMap,
  Telemetry,
} from '../lib/protocol'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'

type PSlot = 'P1' | 'P2'
const PSLOTS: PSlot[] = ['P1', 'P2']
type Kind = 'altered' | 'clean'

interface ServerStatus {
  running: boolean
  port: number
  lanIps: string[]
  sessionDir: string | null
  phase: Phase
}

interface SlotStreams {
  altered: MediaStream | null
  clean: MediaStream | null
}

interface RecState {
  label: string
  bytes: number
  active: boolean
}

interface BannerSent {
  text: string
  durationSec: number
  at: string
}

const EMPTY_STREAMS: Record<PSlot, SlotStreams> = {
  P1: { altered: null, clean: null },
  P2: { altered: null, clean: null },
}

export default function AdminDashboard() {
  const router = useRouter()

  const [server, setServer] = useState<ServerStatus | null>(null)
  const [serverError, setServerError] = useState('')
  const [signalStatus, setSignalStatus] = useState<SignalStatus>('connecting')
  const [roster, setRoster] = useState<RosterState | null>(null)
  const [telemetry, setTelemetry] = useState<Partial<Record<PSlot, Telemetry>>>({})
  const [streams, setStreams] = useState<Record<PSlot, SlotStreams>>(EMPTY_STREAMS)
  const [effectsUi, setEffectsUi] = useState<Record<PSlot, EffectState>>({
    P1: { ...NEUTRAL_EFFECTS },
    P2: { ...NEUTRAL_EFFECTS },
  })
  const [logRows, setLogRows] = useState<LogRow[]>([])
  const [logFilter, setLogFilter] = useState('')
  const [eventCount, setEventCount] = useState(0)
  const [micToggled, setMicToggled] = useState(false)
  const [micHolding, setMicHolding] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [bannerText, setBannerText] = useState('')
  const [bannerDuration, setBannerDuration] = useState(8)
  const [bannersSent, setBannersSent] = useState<BannerSent[]>([])
  const [recState, setRecState] = useState<Record<string, RecState>>({})
  const [nowTick, setNowTick] = useState(Date.now())
  const [endConfirm, setEndConfirm] = useState(false)
  const [adminName, setAdminName] = useState('')

  const clientRef = useRef<SignalClient | null>(null)
  const linksRef = useRef<Map<PSlot, PeerLink>>(new Map())
  const bucketsRef = useRef<Record<PSlot, { byId: Map<string, MediaStream>; map: StreamMap | null }>>({
    P1: { byId: new Map(), map: null },
    P2: { byId: new Map(), map: null },
  })
  const micStreamRef = useRef<MediaStream | null>(null)
  const micTrackRef = useRef<MediaStreamTrack | null>(null)
  const recordersRef = useRef<Map<string, { rec: MediaRecorder; id: string; part: number }>>(new Map())
  const recPartsRef = useRef<Map<string, number>>(new Map())
  const bootedRef = useRef(false)
  const throttleRef = useRef<Map<string, number>>(new Map())
  const effectsTouchedRef = useRef<Map<PSlot, number>>(new Map())

  const phase: Phase = roster?.phase ?? 'waiting'
  const micLive = micToggled || micHolding

  // ---- Boot ----
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true

    const raw = typeof window !== 'undefined' ? sessionStorage.getItem('labcall') : null
    if (!raw) {
      void router.replace('/')
      return
    }
    const cfg = JSON.parse(raw) as { role: string; identity: Identity }
    if (cfg.role !== 'admin') {
      void router.replace('/')
      return
    }
    setAdminName(cfg.identity.name || 'Researcher')

    let client: SignalClient | null = null
    let levelRaf = 0

    void (async () => {
      void ipcInvoke('role:admin')

      // 1. Bring the session server up (Electron main). In browser dev the
      //    standalone server (`npm run server:dev`) plays this role.
      let status: ServerStatus | null = null
      if (hasIpc()) {
        try {
          status = await ipcInvoke<ServerStatus>('server:start', {})
        } catch (err) {
          setServerError(String(err))
        }
      }
      setServer(
        status ?? {
          running: true,
          port: DEFAULT_PORT,
          lanIps: [],
          sessionDir: null,
          phase: 'waiting',
        },
      )
      const port = status?.port ?? DEFAULT_PORT

      // 2. Researcher mic — captured now, sent to participants but disabled
      //    (muted) until the researcher deliberately goes live.
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        micStreamRef.current = mic
        const track = mic.getAudioTracks()[0]
        track.enabled = false
        micTrackRef.current = track
        // Local level meter so the researcher can see the mic works while muted.
        const ac = new AudioContext()
        const an = ac.createAnalyser()
        an.fftSize = 512
        ac.createMediaStreamSource(mic).connect(an)
        const buf = new Uint8Array(an.frequencyBinCount)
        const meter = () => {
          an.getByteTimeDomainData(buf)
          let peak = 0
          for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
          setMicLevel(peak)
          levelRaf = requestAnimationFrame(meter)
        }
        levelRaf = requestAnimationFrame(meter)
      } catch (err) {
        console.warn('Researcher mic unavailable', err)
      }

      // 3. Join the room as the (invisible) ADMIN seat.
      client = new SignalClient({
        url: `ws://localhost:${port}`,
        hello: {
          type: 'hello',
          role: 'admin',
          identity: cfg.identity,
          appVersion: APP_VERSION,
        },
        onStatus: setSignalStatus,
        onMessage: (msg) => {
          switch (msg.type) {
            case 'welcome':
            case 'roster': {
              const r = msg.type === 'welcome' ? msg.roster : msg.roster
              setRoster(r)
              for (const slot of PSLOTS) {
                const info = r.slots[slot]
                // Sync sliders to the server state, but never mid-drag — the
                // roster echo of a throttled command must not snap the thumb back.
                const touched = effectsTouchedRef.current.get(slot) ?? 0
                if (info && performance.now() - touched > 1500) {
                  setEffectsUi((prev) =>
                    prev[slot].alpha === info.effects.alpha &&
                    prev[slot].voiceSemitones === info.effects.voiceSemitones
                      ? prev
                      : { ...prev, [slot]: info.effects },
                  )
                }
                ensureLink(slot, !!r.slots[slot])
              }
              return
            }
            case 'signal': {
              if (msg.from === 'P1' || msg.from === 'P2') {
                let link = linksRef.current.get(msg.from)
                if (
                  link &&
                  msg.data.description?.type === 'offer' &&
                  ['failed', 'closed'].includes(link.pc.connectionState)
                ) {
                  dropLink(msg.from)
                  link = undefined
                }
                if (!link) link = makeLink(msg.from)
                void link.handleSignal(msg.data)
              }
              return
            }
            case 'telemetry':
              if (msg.slot === 'P1' || msg.slot === 'P2') {
                setTelemetry((prev) => ({ ...prev, [msg.slot]: msg.data }))
              }
              return
            case 'stream-map':
              if (msg.slot === 'P1' || msg.slot === 'P2') {
                bucketsRef.current[msg.slot].map = msg.map
                reclassify(msg.slot)
              }
              return
            case 'log-row':
              setEventCount((c) => c + 1)
              setLogRows((rows) => {
                const next = [msg.row, ...rows]
                return next.length > 800 ? next.slice(0, 800) : next
              })
              return
            case 'phase':
              setRoster((r) =>
                r ? { ...r, phase: msg.phase, sessionStartedAt: msg.sessionStartedAt } : r,
              )
              return
            case 'peer-left':
              if (msg.slot === 'P1' || msg.slot === 'P2') dropLink(msg.slot)
              return
            default:
              return
          }
        },
      })
      clientRef.current = client
      client.connect()
    })()

    function reclassify(slot: PSlot) {
      const bucket = bucketsRef.current[slot]
      const out: SlotStreams = { altered: null, clean: null }
      if (bucket.map) {
        out.altered = bucket.byId.get(bucket.map.altered) ?? null
        out.clean = bucket.byId.get(bucket.map.clean) ?? null
      }
      if (!out.altered && !bucket.map && bucket.byId.size === 1) {
        out.altered = [...bucket.byId.values()][0]
      }
      setStreams((prev) => ({ ...prev, [slot]: out }))
    }

    function makeLink(slot: PSlot): PeerLink {
      const link = new PeerLink({
        polite: true, // the admin always yields; participants drive negotiation
        sendSignal: (data: SignalData) =>
          clientRef.current?.send({ type: 'signal', to: slot, data }),
        onTrack: (_track, trackStreams) => {
          const stream = trackStreams[0]
          if (!stream) return
          bucketsRef.current[slot].byId.set(stream.id, stream)
          reclassify(slot)
        },
        onConnectionState: (state) => {
          clientRef.current?.send({
            type: 'client-event',
            event: 'rtc_state',
            target: slot,
            value: state,
          })
          if (state === 'failed') dropLink(slot)
        },
      })
      const micStream = micStreamRef.current
      const micTrack = micTrackRef.current
      if (micStream && micTrack) link.addTrack(micTrack, micStream)
      linksRef.current.set(slot, link)
      return link
    }

    function dropLink(slot: PSlot) {
      linksRef.current.get(slot)?.close()
      linksRef.current.delete(slot)
      bucketsRef.current[slot].byId.clear()
      bucketsRef.current[slot].map = null
      setStreams((prev) => ({ ...prev, [slot]: { altered: null, clean: null } }))
      // Finalize this seat's recorders so a reconnect starts fresh _part files
      // instead of appending dead-stream silence to the old ones.
      for (const kind of ['altered', 'clean'] as Kind[]) {
        const entry = recordersRef.current.get(`${slot}:${kind}`)
        if (entry && entry.rec.state !== 'inactive') entry.rec.stop()
      }
    }

    function ensureLink(slot: PSlot, present: boolean) {
      const existing = linksRef.current.get(slot)
      if (!present && existing) dropLink(slot)
      // Links are created lazily when the participant's offer arrives.
    }

    const tick = setInterval(() => setNowTick(Date.now()), 1000)

    return () => {
      clearInterval(tick)
      cancelAnimationFrame(levelRaf)
      for (const slot of PSLOTS) {
        linksRef.current.get(slot)?.close()
      }
      linksRef.current.clear()
      client?.close()
      micStreamRef.current?.getTracks().forEach((t) => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Mic enable/disable follows toggle + hold ----
  useEffect(() => {
    if (micTrackRef.current) micTrackRef.current.enabled = micLive
  }, [micLive])

  // ---- Recording: every stream, auto-armed while the session is live ----
  const appendChunk = useCallback(async (key: string, recId: string, data: Blob) => {
    const buf = await data.arrayBuffer()
    const bytes = await ipcInvoke<number>('rec:append', recId, buf)
    if (typeof bytes === 'number') {
      setRecState((prev) => {
        const cur = prev[key]
        return cur ? { ...prev, [key]: { ...cur, bytes } } : prev
      })
    }
  }, [])

  const startRecorder = useCallback(
    async (key: string, label: string, stream: MediaStream) => {
      if (!hasIpc() || recordersRef.current.has(key)) return
      const part = (recPartsRef.current.get(key) ?? 0) + 1
      recPartsRef.current.set(key, part)
      const fullLabel = part > 1 ? `${label}_part${part}` : label
      const opened = await ipcInvoke<{ id: string; path: string }>('rec:open', fullLabel)
      if (!opened) return
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : 'video/webm'
      const rec = new MediaRecorder(
        stream,
        stream.getVideoTracks().length > 0 ? { mimeType: mime } : { mimeType: 'audio/webm' },
      )
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) void appendChunk(key, opened.id, e.data)
      }
      rec.onstop = () => {
        void ipcInvoke('rec:close', opened.id)
        recordersRef.current.delete(key)
        setRecState((prev) => {
          const cur = prev[key]
          return cur ? { ...prev, [key]: { ...cur, active: false } } : prev
        })
      }
      rec.start(1000)
      recordersRef.current.set(key, { rec, id: opened.id, part })
      setRecState((prev) => ({ ...prev, [key]: { label: fullLabel, bytes: 0, active: true } }))
    },
    [appendChunk],
  )

  useEffect(() => {
    if (phase === 'live') {
      for (const slot of PSLOTS) {
        const pid = roster?.slots[slot]?.identity.participantId || slot
        for (const kind of ['altered', 'clean'] as Kind[]) {
          const stream = streams[slot][kind]
          if (stream) void startRecorder(`${slot}:${kind}`, `${slot}_${pid}_${kind}`, stream)
        }
      }
      if (micStreamRef.current) {
        void startRecorder('mic', 'researcher_mic', micStreamRef.current)
      }
    }
    if (phase === 'ended') {
      for (const { rec } of recordersRef.current.values()) {
        if (rec.state !== 'inactive') rec.stop()
      }
    }
  }, [phase, streams, roster, startRecorder])

  // ---- Commands ----
  function sendEffect(slot: PSlot, param: keyof EffectState, value: number, force = false) {
    effectsTouchedRef.current.set(slot, performance.now())
    setEffectsUi((prev) => ({ ...prev, [slot]: { ...prev[slot], [param]: value } }))
    const key = `${slot}:${param}`
    const now = performance.now()
    const last = throttleRef.current.get(key) ?? 0
    if (!force && now - last < 90) return
    throttleRef.current.set(key, now)
    clientRef.current?.send({ type: 'set-effect', slot, param, value })
  }

  function applyPreset(slot: PSlot, presetId: string) {
    const p = PRESETS.find((x) => x.id === presetId)
    if (!p) return
    const effects: EffectState = { alpha: p.alpha, voiceSemitones: p.voiceSemitones }
    setEffectsUi((prev) => ({ ...prev, [slot]: effects }))
    clientRef.current?.send({ type: 'apply-preset', slot, presetId, effects })
  }

  function setIdentity(slot: PSlot, identity: Identity) {
    clientRef.current?.send({ type: 'set-identity', slot, identity })
  }

  function sendBanner(text?: string, durationSec?: number) {
    const t = (text ?? bannerText).trim()
    const d = durationSec ?? bannerDuration
    if (!t) return
    clientRef.current?.send({ type: 'banner', text: t, durationSec: d })
    setBannersSent((prev) => [
      { text: t, durationSec: d, at: new Date().toLocaleTimeString() },
      ...prev.slice(0, 19),
    ])
    if (text === undefined) setBannerText('')
  }

  function setMic(live: boolean, mode: 'toggle' | 'hold') {
    clientRef.current?.send({ type: 'admin-mic', live, mode })
  }

  function startSession() {
    clientRef.current?.send({ type: 'set-phase', phase: 'live' })
  }

  async function endSession() {
    setEndConfirm(false)
    clientRef.current?.send({ type: 'set-phase', phase: 'ended' })
    // Give recorders a beat to flush, then write the manifest.
    setTimeout(() => void writeManifest(), 1500)
  }

  async function writeManifest() {
    if (!hasIpc()) return
    await ipcInvoke('server:write-manifest', {
      schemaVersion: 2,
      app: 'Niedenthal Lab Video Call',
      appVersion: APP_VERSION,
      writtenAt: new Date().toISOString(),
      sessionStartedAt: roster?.sessionStartedAt ?? null,
      raName: adminName,
      participants: PSLOTS.map((slot) => ({
        slot,
        identity: roster?.slots[slot]?.identity ?? null,
      })),
      recordings: Object.values(recState).map((r) => ({ label: r.label, bytes: r.bytes })),
      eventCount,
    })
  }

  const sessionDir = server?.sessionDir ?? null
  const bothReady = PSLOTS.every((s) => roster?.slots[s]?.ready)
  const elapsedSec = roster?.sessionStartedAt
    ? Math.max(0, Math.floor((nowTick - Date.parse(roster.sessionStartedAt)) / 1000))
    : 0

  const filteredLog = logFilter
    ? logRows.filter((r) =>
        `${r.event} ${r.actorSlot} ${r.actorName} ${r.param} ${r.value}`
          .toLowerCase()
          .includes(logFilter.toLowerCase()),
      )
    : logRows

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* ===== Header ===== */}
      <header className="sticky top-0 z-30 border-b border-gray-800 bg-gray-950/95 backdrop-blur">
        <div className="flex items-center gap-4 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600/20 ring-1 ring-violet-500/40">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-violet-400" fill="currentColor">
                <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
              </svg>
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-tight">Researcher Dashboard</h1>
              <p className="text-[11px] leading-tight text-gray-500">
                {adminName} · Niedenthal Emotions Lab
              </p>
            </div>
          </div>

          <PhaseBadge phase={phase} />

          {phase === 'live' && (
            <div className="rounded-lg bg-gray-900 px-3 py-1.5 font-mono text-sm tabular-nums text-emerald-300 ring-1 ring-gray-800">
              {fmtClock(elapsedSec)}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {server && (
              <div className="hidden items-center gap-2 rounded-lg bg-gray-900 px-3 py-1.5 text-[11px] text-gray-400 ring-1 ring-gray-800 md:flex">
                <span className="text-gray-500">Participants connect to</span>
                <span className="font-mono text-gray-200">
                  {server.lanIps[0] ?? 'localhost'}:{server.port}
                </span>
                {server.lanIps.length > 1 && (
                  <span className="text-gray-600" title={server.lanIps.join(', ')}>
                    +{server.lanIps.length - 1}
                  </span>
                )}
              </div>
            )}
            {sessionDir && (
              <button
                type="button"
                onClick={() => void ipcInvoke('shell:open-path', sessionDir)}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-[11px] font-medium text-gray-300 ring-1 ring-gray-800 transition hover:bg-gray-800"
                title={sessionDir}
              >
                📂 Data folder
              </button>
            )}
            {phase === 'waiting' && (
              <button
                type="button"
                onClick={startSession}
                disabled={!bothReady}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold transition enabled:hover:bg-emerald-500 disabled:opacity-40"
                title={bothReady ? 'Both participants are ready' : 'Waiting for both participants to be ready'}
              >
                ▶ Start conversation
              </button>
            )}
            {phase === 'live' && (
              <button
                type="button"
                onClick={() => setEndConfirm(true)}
                className="rounded-lg bg-red-600/90 px-4 py-1.5 text-sm font-semibold transition hover:bg-red-500"
              >
                ■ End session
              </button>
            )}
            {phase === 'ended' && (
              <span className="rounded-lg bg-gray-900 px-3 py-1.5 text-[11px] text-gray-400 ring-1 ring-gray-800">
                Session complete — data saved
              </span>
            )}
          </div>
        </div>
        {serverError && (
          <div className="border-t border-red-900/50 bg-red-950/40 px-5 py-2 text-xs text-red-300">
            Session server failed to start: {serverError}
          </div>
        )}
        {signalStatus !== 'connected' && !serverError && (
          <div className="border-t border-amber-900/50 bg-amber-950/30 px-5 py-2 text-xs text-amber-300">
            Connecting to session server…
          </div>
        )}
      </header>

      {/* ===== Body ===== */}
      <main className="grid grid-cols-12 gap-4 p-4">
        {/* --- Participant panels --- */}
        <div className="col-span-12 grid grid-cols-1 gap-4 xl:col-span-8 xl:grid-cols-2">
          {PSLOTS.map((slot) => (
            <ParticipantPanel
              key={slot}
              slot={slot}
              info={roster?.slots[slot] ?? null}
              telemetry={telemetry[slot]}
              streams={streams[slot]}
              effects={effectsUi[slot]}
              onEffect={(param, value, force) => sendEffect(slot, param, value, force)}
              onPreset={(id) => applyPreset(slot, id)}
              onIdentity={(identity) => setIdentity(slot, identity)}
            />
          ))}
        </div>

        {/* --- Right rail --- */}
        <div className="col-span-12 flex flex-col gap-4 xl:col-span-4">
          {/* Researcher voice */}
          <Card title="Researcher voice" subtitle="Participants hear you only while live">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  const next = !micToggled
                  setMicToggled(next)
                  setMic(next || micHolding, 'toggle')
                }}
                className={
                  'rounded-lg px-4 py-2 text-sm font-semibold transition ' +
                  (micToggled
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
                }
              >
                {micToggled ? '🔴 Mic LIVE — click to mute' : '🎙 Unmute mic'}
              </button>
              <button
                type="button"
                onPointerDown={() => {
                  setMicHolding(true)
                  setMic(true, 'hold')
                }}
                onPointerUp={() => {
                  setMicHolding(false)
                  setMic(micToggled, 'hold')
                }}
                onPointerLeave={() => {
                  if (micHolding) {
                    setMicHolding(false)
                    setMic(micToggled, 'hold')
                  }
                }}
                className={
                  'rounded-lg px-4 py-2 text-sm font-medium transition ' +
                  (micHolding
                    ? 'bg-amber-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
                }
              >
                Hold to talk
              </button>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-800">
                <div
                  className={`h-full transition-[width] duration-75 ${micLive ? 'bg-red-500' : 'bg-gray-600'}`}
                  style={{ width: `${Math.min(100, micLevel * 140)}%` }}
                />
              </div>
              <span className={`text-[10px] font-semibold ${micLive ? 'text-red-400' : 'text-gray-500'}`}>
                {micLive ? 'LIVE' : 'muted'}
              </span>
            </div>
          </Card>

          {/* Banner */}
          <Card title="Message banner" subtitle="Appears at the top of both participant screens">
            <div className="flex gap-2">
              <input
                value={bannerText}
                onChange={(e) => setBannerText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendBanner()}
                placeholder="e.g. Five minutes remaining"
                className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-sky-500"
              />
              <input
                type="number"
                min={1}
                max={120}
                value={bannerDuration}
                onChange={(e) => setBannerDuration(Number(e.target.value) || 8)}
                className="w-16 rounded-lg border border-gray-700 bg-gray-800 px-2 py-2 text-center text-sm outline-none focus:border-sky-500"
                title="Seconds shown"
              />
              <button
                type="button"
                onClick={() => sendBanner()}
                className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold transition hover:bg-sky-500"
              >
                Send
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                'Five minutes remaining.',
                'Please begin wrapping up your conversation.',
                'One moment please — brief technical pause.',
              ].map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => sendBanner(q)}
                  className="rounded-full bg-gray-800 px-2.5 py-1 text-[11px] text-gray-300 transition hover:bg-gray-700"
                >
                  {q}
                </button>
              ))}
            </div>
            {bannersSent.length > 0 && (
              <ul className="mt-3 max-h-20 space-y-1 overflow-y-auto text-[11px] text-gray-500">
                {bannersSent.map((b, i) => (
                  <li key={i}>
                    <span className="text-gray-600">{b.at}</span> · {b.text}{' '}
                    <span className="text-gray-600">({b.durationSec}s)</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Recordings */}
          <Card
            title="Recordings"
            subtitle={
              hasIpc()
                ? 'All streams record automatically while the session is live'
                : 'Recording requires the desktop app'
            }
          >
            {Object.keys(recState).length === 0 ? (
              <p className="text-xs text-gray-600">
                Armed — starts when you start the conversation.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {Object.entries(recState).map(([key, r]) => (
                  <li key={key} className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-2 font-mono text-gray-300">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${r.active ? 'animate-pulse bg-red-500' : 'bg-gray-600'}`}
                      />
                      {r.label}.webm
                    </span>
                    <span className="tabular-nums text-gray-500">{fmtBytes(r.bytes)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Event log */}
          <Card
            title="Event log"
            subtitle={`${eventCount} events → events.csv`}
            className="flex min-h-0 flex-1 flex-col"
          >
            <input
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              placeholder="Filter events…"
              className="mb-2 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs outline-none focus:border-sky-500"
            />
            <div className="h-64 overflow-y-auto rounded-lg bg-gray-950/60 p-2 font-mono text-[10.5px] leading-relaxed xl:h-[340px]">
              {filteredLog.length === 0 && (
                <p className="p-2 text-gray-600">Events will stream here as they are logged.</p>
              )}
              {filteredLog.map((r) => (
                <div key={r.seq} className="flex gap-2 whitespace-nowrap">
                  <span className="text-gray-600">{r.tsIso.slice(11, 19)}</span>
                  <span className={eventColor(r.event)}>{r.event}</span>
                  {r.actorSlot && <span className="text-gray-500">{r.actorSlot}</span>}
                  {r.target && <span className="text-gray-500">→{r.target}</span>}
                  {r.param && (
                    <span className="text-gray-400">
                      {r.param}={r.value}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </main>

      {/* ===== End-session confirm ===== */}
      {endConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[420px] rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
            <h2 className="text-base font-semibold">End the session?</h2>
            <p className="mt-2 text-sm text-gray-400">
              Participants will see an &ldquo;ended&rdquo; screen, all recordings stop and
              finalize, and the manifest is written. This cannot be restarted.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEndConfirm(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void endSession()}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold hover:bg-red-500"
              >
                End session
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== Participant panel =====

interface PanelProps {
  slot: PSlot
  info: RosterState['slots'][PSlot] | null
  telemetry: Telemetry | undefined
  streams: SlotStreams
  effects: EffectState
  onEffect: (param: keyof EffectState, value: number, force?: boolean) => void
  onPreset: (id: string) => void
  onIdentity: (identity: Identity) => void
}

function ParticipantPanel({
  slot,
  info,
  telemetry,
  streams,
  effects,
  onEffect,
  onPreset,
  onIdentity,
}: PanelProps) {
  const [view, setView] = useState<Kind>('altered')
  const [volume, setVolume] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Identity>({
    name: '',
    participantId: '',
    dyadId: '',
    studyId: '',
  })
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const stream = streams[view] ?? streams.altered
  useEffect(() => {
    if (videoRef.current && videoRef.current.srcObject !== stream) {
      videoRef.current.srcObject = stream
    }
  }, [stream])
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume
      videoRef.current.muted = volume === 0
    }
  }, [volume, stream])

  const applied =
    telemetry &&
    Math.abs(telemetry.alpha - effects.alpha) < 0.011 &&
    Math.abs(telemetry.voiceSemitones - effects.voiceSemitones) < 0.51

  const modified =
    Math.abs(effects.alpha - 1) >= 0.02 || Math.abs(effects.voiceSemitones) >= 0.5

  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/60">
      {/* Title row */}
      <div className="flex items-center gap-2 border-b border-gray-800 px-4 py-2.5">
        <span
          className={`h-2 w-2 rounded-full ${
            info ? (info.ready ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-gray-600'
          }`}
        />
        <h2 className="text-sm font-semibold">
          {slot} · {info?.identity.name || 'Empty seat'}
        </h2>
        {info?.identity.participantId && (
          <span className="text-[11px] text-gray-500">#{info.identity.participantId}</span>
        )}
        {modified && (
          <span className="rounded-full bg-violet-600/25 px-2 py-0.5 text-[10px] font-semibold text-violet-300 ring-1 ring-violet-500/40">
            MODIFIED
          </span>
        )}
        <button
          type="button"
          onClick={() => {
            setEditing((e) => !e)
            setDraft(
              info?.identity ?? { name: '', participantId: '', dyadId: '', studyId: '' },
            )
          }}
          className="ml-auto text-[11px] text-gray-500 transition hover:text-gray-300"
        >
          {editing ? 'close' : 'edit info'}
        </button>
      </div>

      {/* Identity editor */}
      {editing && (
        <div className="grid grid-cols-2 gap-2 border-b border-gray-800 bg-gray-950/40 p-3">
          {(
            [
              ['name', 'Full name'],
              ['participantId', 'Participant ID'],
              ['dyadId', 'Dyad ID'],
              ['studyId', 'Study ID'],
            ] as Array<[keyof Identity, string]>
          ).map(([k, label]) => (
            <input
              key={k}
              value={draft[k]}
              onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
              placeholder={label}
              className="rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-xs outline-none focus:border-sky-500"
            />
          ))}
          <button
            type="button"
            onClick={() => {
              onIdentity(draft)
              setEditing(false)
            }}
            className="col-span-2 rounded-lg bg-sky-600 py-1.5 text-xs font-semibold transition hover:bg-sky-500"
          >
            Apply to {slot}
          </button>
        </div>
      )}

      {/* Video monitor */}
      <div className="relative aspect-video bg-black">
        <video ref={videoRef} autoPlay playsInline className="h-full w-full object-contain" />
        {!stream && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">
            {info ? 'Waiting for video…' : 'No participant connected'}
          </div>
        )}
        {/* View toggle */}
        <div className="absolute left-2 top-2 flex overflow-hidden rounded-lg bg-black/60 text-[10px] font-semibold backdrop-blur">
          {(['altered', 'clean'] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setView(k)}
              className={
                'px-2.5 py-1 uppercase tracking-wide transition ' +
                (view === k
                  ? k === 'altered'
                    ? 'bg-violet-600 text-white'
                    : 'bg-emerald-600 text-white'
                  : 'text-gray-400 hover:text-white')
              }
            >
              {k === 'altered' ? 'Altered (partner sees)' : 'Clean'}
            </button>
          ))}
        </div>
        {/* Telemetry chips */}
        {telemetry && (
          <div className="absolute bottom-2 left-2 flex flex-wrap gap-1.5 text-[10px]">
            <Chip ok={telemetry.faceFound} label={telemetry.faceFound ? 'face tracked' : 'no face'} />
            <Chip ok={telemetry.fps >= 20} label={`${Math.round(telemetry.fps)} fps`} />
            <Chip ok={!!applied} label={applied ? 'applied ✓' : 'pending…'} />
          </div>
        )}
        {/* Monitor volume */}
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-lg bg-black/60 px-2 py-1 backdrop-blur">
          <span className="text-[10px] text-gray-400" title="Monitor volume — use headphones to avoid audio leaking into the lab room">
            🎧
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="h-1 w-16 accent-sky-500"
          />
        </div>
      </div>

      {/* Effect controls */}
      <div className="space-y-3 p-4">
        <EffectSlider
          label="Smile"
          hint={effects.alpha > 1.02 ? 'lifted' : effects.alpha < 0.98 ? 'dampened' : 'neutral'}
          min={-1}
          max={3}
          step={0.05}
          value={effects.alpha}
          neutral={1}
          format={(v) => `α ${v.toFixed(2)}`}
          onChange={(v) => onEffect('alpha', v)}
          onCommit={(v) => onEffect('alpha', v, true)}
        />
        <EffectSlider
          label="Voice pitch"
          hint={
            effects.voiceSemitones > 0.5
              ? 'higher'
              : effects.voiceSemitones < -0.5
                ? 'lower'
                : 'neutral'
          }
          min={-12}
          max={12}
          step={1}
          value={effects.voiceSemitones}
          neutral={0}
          format={(v) => `${v > 0 ? '+' : ''}${v} st`}
          onChange={(v) => onEffect('voiceSemitones', v)}
          onCommit={(v) => onEffect('voiceSemitones', v, true)}
        />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.description}
              onClick={() => onPreset(p.id)}
              className={
                'rounded-full px-2.5 py-1 text-[11px] transition ' +
                (Math.abs(effects.alpha - p.alpha) < 0.011 &&
                effects.voiceSemitones === p.voiceSemitones
                  ? 'bg-violet-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700')
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

// ===== Small bits =====

function EffectSlider({
  label,
  hint,
  min,
  max,
  step,
  value,
  neutral,
  format,
  onChange,
  onCommit,
}: {
  label: string
  hint: string
  min: number
  max: number
  step: number
  value: number
  neutral: number
  format: (v: number) => string
  onChange: (v: number) => void
  onCommit: (v: number) => void
}) {
  const isNeutral = Math.abs(value - neutral) < step / 2
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-gray-300">
          {label} <span className="text-gray-600">· {hint}</span>
        </span>
        <span className="flex items-center gap-2 font-mono tabular-nums text-gray-400">
          {format(value)}
          {!isNeutral && (
            <button
              type="button"
              onClick={() => onCommit(neutral)}
              className="rounded bg-gray-800 px-1.5 text-[10px] text-gray-400 transition hover:text-white"
            >
              reset
            </button>
          )}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit(Number((e.target as HTMLInputElement).value))}
        className={`w-full ${isNeutral ? 'accent-gray-500' : 'accent-violet-500'}`}
      />
    </div>
  )
}

function Card({
  title,
  subtitle,
  children,
  className = '',
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-2xl border border-gray-800 bg-gray-900/60 p-4 ${className}`}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {subtitle && <p className="mb-3 mt-0.5 text-[11px] text-gray-500">{subtitle}</p>}
      {children}
    </section>
  )
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={
        'rounded-full px-2 py-0.5 font-medium backdrop-blur ' +
        (ok ? 'bg-emerald-600/30 text-emerald-300' : 'bg-amber-600/30 text-amber-300')
      }
    >
      {label}
    </span>
  )
}

function PhaseBadge({ phase }: { phase: Phase }) {
  const styles: Record<Phase, string> = {
    waiting: 'bg-amber-600/20 text-amber-300 ring-amber-500/40',
    live: 'bg-emerald-600/20 text-emerald-300 ring-emerald-500/40',
    ended: 'bg-gray-700/40 text-gray-300 ring-gray-600/50',
  }
  const labels: Record<Phase, string> = {
    waiting: '● Waiting room',
    live: '● LIVE',
    ended: '● Ended',
  }
  return (
    <span className={`rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ${styles[phase]}`}>
      {labels[phase]}
    </span>
  )
}

function fmtClock(totalSec: number): string {
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function eventColor(event: string): string {
  if (event.startsWith('effect') || event === 'preset_applied') return 'text-violet-300'
  if (event.startsWith('session')) return 'text-emerald-300'
  if (event.includes('disconnect') || event.includes('error') || event.includes('timeout'))
    return 'text-red-300'
  if (event.startsWith('admin_mic') || event === 'banner_sent') return 'text-sky-300'
  if (event.startsWith('escape') || event.startsWith('window')) return 'text-amber-300'
  return 'text-gray-300'
}
