// Participant view. Looks like a minimal, calm video call:
//   - waiting screen until the researcher starts the conversation
//   - partner full-screen (their ALTERED stream), self in a small PiP
//     (always the RAW camera — a participant never sees their own modification)
//   - researcher banners slide in at the top; researcher audio plays when they
//     unmute. The researcher is otherwise invisible.
//
// Nothing on screen is clickable and the cursor is hidden. The window is a
// kiosk (main process). The only exit is Ctrl+Shift+Q → type "Confirm".

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { LiveEffects } from '../lib/effects'
import { SignalClient, SignalStatus, normalizeServerUrl } from '../lib/signaling'
import { PeerLink } from '../lib/rtc'
import { APP_VERSION, DEFAULT_PORT } from '../lib/protocol'
import type {
  ClientMessage,
  Identity,
  Phase,
  RosterState,
  ServerMessage,
  SignalData,
  SlotId,
} from '../lib/protocol'
import { hasIpc, ipcInvoke, ipcOn } from '../lib/ipcUtil'

interface BootConfig {
  role: 'participant' | 'admin'
  serverAddr: string
  identity: Identity
}

interface BannerState {
  text: string
  key: number
}

export default function ParticipantSession() {
  const router = useRouter()

  const [phase, setPhase] = useState<Phase>('waiting')
  const [signalStatus, setSignalStatus] = useState<SignalStatus>('connecting')
  const [cameraReady, setCameraReady] = useState(false)
  const [partnerStream, setPartnerStream] = useState<MediaStream | null>(null)
  const [adminStream, setAdminStream] = useState<MediaStream | null>(null)
  const [selfStream, setSelfStream] = useState<MediaStream | null>(null)
  const [partnerName, setPartnerName] = useState('')
  const [partnerConn, setPartnerConn] = useState<RTCPeerConnectionState | 'none'>('none')
  const [banner, setBanner] = useState<BannerState | null>(null)
  const [escapeOpen, setEscapeOpen] = useState(false)
  const [escapeText, setEscapeText] = useState('')

  const effectsRef = useRef<LiveEffects | null>(null)
  const clientRef = useRef<SignalClient | null>(null)
  const linksRef = useRef<Map<SlotId, PeerLink>>(new Map())
  const mySlotRef = useRef<SlotId | null>(null)
  const rosterRef = useRef<RosterState | null>(null)
  const effectsReadyRef = useRef(false)
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bootedRef = useRef(false)

  const partnerVideoRef = useRef<HTMLVideoElement | null>(null)
  const selfVideoRef = useRef<HTMLVideoElement | null>(null)
  const adminAudioRef = useRef<HTMLAudioElement | null>(null)
  const escapeInputRef = useRef<HTMLInputElement | null>(null)

  const sendEvent = useCallback(
    (event: string, extra?: Partial<Extract<ClientMessage, { type: 'client-event' }>>) => {
      clientRef.current?.send({ type: 'client-event', event, ...extra })
    },
    [],
  )

  // ---- Boot: lockdown, media pipeline, signaling ----
  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true

    const raw = typeof window !== 'undefined' ? sessionStorage.getItem('labcall') : null
    if (!raw) {
      void router.replace('/')
      return
    }
    const cfg = JSON.parse(raw) as BootConfig
    if (cfg.role !== 'participant') {
      void router.replace('/')
      return
    }

    void ipcInvoke('role:participant')

    const mySlot = () => mySlotRef.current
    const partnerSlot = (): SlotId | null =>
      mySlot() === 'P1' ? 'P2' : mySlot() === 'P2' ? 'P1' : null

    const client = new SignalClient({
      url: normalizeServerUrl(cfg.serverAddr, DEFAULT_PORT),
      hello: {
        type: 'hello',
        role: 'participant',
        identity: cfg.identity,
        appVersion: APP_VERSION,
      },
      onStatus: setSignalStatus,
      onMessage: (msg) => handleMessage(msg),
    })
    clientRef.current = client

    function dropLink(slot: SlotId) {
      const link = linksRef.current.get(slot)
      if (link) {
        link.close()
        linksRef.current.delete(slot)
      }
      if (slot === partnerSlot()) {
        setPartnerStream(null)
        setPartnerConn('none')
      }
      if (slot === 'ADMIN') setAdminStream(null)
    }

    function makeLink(slot: SlotId): PeerLink {
      // Politeness: P2 yields to P1; participants never yield to the admin
      // (the admin side is polite).
      const polite = slot === 'P1'
      const link = new PeerLink({
        polite,
        sendSignal: (data: SignalData) => client.send({ type: 'signal', to: slot, data }),
        onTrack: (_track, streams) => {
          const stream = streams[0]
          if (!stream) return
          if (slot === 'ADMIN') setAdminStream(stream)
          else setPartnerStream(stream)
        },
        onConnectionState: (state) => {
          sendEvent('rtc_state', { target: slot, value: state })
          if (slot === partnerSlot()) setPartnerConn(state)
          if (state === 'failed') dropLink(slot)
        },
      })
      linksRef.current.set(slot, link)

      const fx = effectsRef.current
      if (fx?.alteredStream) {
        link.addStreamTracks(fx.alteredStream)
        if (slot === 'ADMIN' && fx.cleanStream) {
          link.addStreamTracks(fx.cleanStream)
          client.send({
            type: 'stream-map',
            map: { altered: fx.alteredStream.id, clean: fx.cleanStream.id },
          })
        }
      }
      return link
    }

    function ensureLinks() {
      if (!effectsReadyRef.current) return
      const roster = rosterRef.current
      if (!roster || !mySlot()) return
      const ps = partnerSlot()
      for (const slot of ['P1', 'P2', 'ADMIN'] as SlotId[]) {
        if (slot === mySlot()) continue
        if (slot !== 'ADMIN' && slot !== ps) continue
        const present = !!roster.slots[slot]
        const existing = linksRef.current.get(slot)
        if (present && !existing) makeLink(slot)
        if (!present && existing) dropLink(slot)
      }
    }

    function handleRoster(roster: RosterState) {
      rosterRef.current = roster
      const ps = partnerSlot()
      const partner = ps ? roster.slots[ps] : undefined
      setPartnerName(partner?.identity.name ?? '')
      ensureLinks()
    }

    function handleMessage(msg: ServerMessage) {
      switch (msg.type) {
        case 'welcome':
          mySlotRef.current = msg.slot
          setPhase(msg.phase)
          handleRoster(msg.roster)
          return
        case 'roster':
          handleRoster(msg.roster)
          return
        case 'signal': {
          let link = linksRef.current.get(msg.from)
          // A peer that restarted sends a fresh offer; rebuild a dead link.
          if (
            link &&
            msg.data.description?.type === 'offer' &&
            ['failed', 'closed'].includes(link.pc.connectionState)
          ) {
            dropLink(msg.from)
            link = undefined
          }
          if (!link && effectsReadyRef.current) link = makeLink(msg.from)
          void link?.handleSignal(msg.data)
          return
        }
        case 'effect-command': {
          const fx = effectsRef.current
          if (fx) {
            fx.setAlpha(msg.effects.alpha)
            fx.setSemitones(msg.effects.voiceSemitones)
            sendEvent('effect_applied', { detail: msg.effects })
          }
          return
        }
        case 'identity-assigned':
          cfg.identity = msg.identity
          return
        case 'banner': {
          if (bannerTimer.current) clearTimeout(bannerTimer.current)
          setBanner({ text: msg.text, key: Date.now() })
          sendEvent('banner_shown', { detail: { text: msg.text } })
          bannerTimer.current = setTimeout(
            () => setBanner(null),
            Math.max(1, msg.durationSec) * 1000,
          )
          return
        }
        case 'phase':
          setPhase(msg.phase)
          return
        case 'peer-left':
          dropLink(msg.slot)
          return
        case 'rejected':
          return
        default:
          return
      }
    }

    client.connect()

    // Pre-warm the entire media pipeline during the waiting screen so the
    // first morph command is instant.
    const effects = new LiveEffects()
    effectsRef.current = effects
    void effects
      .start((m, level) => console[level === 'warn' ? 'warn' : 'log'](`[effects] ${m}`))
      .then(() => {
        effectsReadyRef.current = true
        setCameraReady(true)
        setSelfStream(effects.cleanStream)
        client.send({
          type: 'ready',
          camera: effects.status.camera,
          faceModel: effects.status.faceModel,
          voice: effects.status.voice,
        })
        ensureLinks()
      })
      .catch((err) => {
        console.error('media pipeline failed', err)
        sendEvent('media_pipeline_error', { detail: String(err) })
      })

    const telemetry = setInterval(() => {
      const fx = effectsRef.current
      if (fx && effectsReadyRef.current && client.isOpen) {
        client.send({ type: 'telemetry', data: fx.telemetry() })
      }
    }, 1000)

    // Real-face expression stream for the researcher dashboard and the
    // automation rules. Checked at 5 Hz but only sent when the state actually
    // changes, so a neutral face costs almost no traffic.
    let lastExprSent = ''
    const expression = setInterval(() => {
      const fx = effectsRef.current
      if (!fx || !effectsReadyRef.current || !client.isOpen) return
      const e = fx.currentExpression()
      if (!e) return
      const key = `${e.label}|${e.smileType ?? ''}|${Math.round(e.smile * 20)}|${Math.round(e.frown * 20)}`
      if (key !== lastExprSent) {
        lastExprSent = key
        client.send({ type: 'expression', data: e })
      }
    }, 200)

    const onBlur = () => sendEvent('window_blur')
    const onFocus = () => sendEvent('window_focus')
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)

    const offEscape = ipcOn('escape:open', () => {
      setEscapeOpen(true)
      setEscapeText('')
      sendEvent('escape_dialog_opened')
    })

    return () => {
      clearInterval(telemetry)
      clearInterval(expression)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      offEscape()
      if (bannerTimer.current) clearTimeout(bannerTimer.current)
      for (const link of linksRef.current.values()) link.close()
      linksRef.current.clear()
      client.close()
      effects.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- Attach streams to elements ----
  useEffect(() => {
    if (partnerVideoRef.current && partnerVideoRef.current.srcObject !== partnerStream) {
      partnerVideoRef.current.srcObject = partnerStream
    }
  }, [partnerStream, phase])
  useEffect(() => {
    if (selfVideoRef.current && selfVideoRef.current.srcObject !== selfStream) {
      selfVideoRef.current.srcObject = selfStream
    }
  }, [selfStream, phase])
  useEffect(() => {
    if (adminAudioRef.current && adminAudioRef.current.srcObject !== adminStream) {
      adminAudioRef.current.srcObject = adminStream
    }
  }, [adminStream])

  useEffect(() => {
    if (escapeOpen) escapeInputRef.current?.focus()
  }, [escapeOpen])

  function confirmEscape() {
    if (escapeText !== 'Confirm') return
    sendEvent('escape_confirmed')
    setTimeout(() => {
      if (hasIpc()) void ipcInvoke('app:request-quit')
      else window.close()
    }, 150)
  }

  function cancelEscape() {
    sendEvent('escape_dialog_cancelled')
    setEscapeOpen(false)
  }

  const reconnecting = signalStatus === 'reconnecting'
  // 'disconnected' is usually a transient ICE blip that self-recovers within a
  // second or two — media keeps flowing, so don't alarm the participant. Only
  // a dead link (failed/closed drops the stream) shows the connecting overlay.
  const partnerLive =
    partnerStream !== null && partnerConn !== 'failed' && partnerConn !== 'closed'

  return (
    <div className="relative h-screen w-screen cursor-none select-none overflow-hidden bg-gray-950">
      {/* Researcher audio — invisible, plays only if they unmute. */}
      <audio ref={adminAudioRef} autoPlay />

      {/* ---- Live call ---- */}
      {phase === 'live' && (
        <div className="absolute inset-0">
          <video
            ref={partnerVideoRef}
            autoPlay
            playsInline
            className="h-full w-full object-cover"
          />
          {!partnerLive && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gray-950/90">
              <Spinner />
              <p className="text-sm text-gray-400">Connecting to your partner…</p>
            </div>
          )}
          {partnerName && partnerLive && (
            <div className="absolute bottom-6 left-6 rounded-lg bg-black/50 px-3 py-1.5 text-sm font-medium text-white backdrop-blur-sm">
              {partnerName}
            </div>
          )}
        </div>
      )}

      {/* ---- Waiting room ---- */}
      {phase === 'waiting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-600/20 ring-1 ring-sky-500/40">
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-sky-400" fill="currentColor">
              <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </div>
          <h1 className="text-xl font-medium text-white">
            Please wait for the researcher to start
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            Your conversation will begin automatically — no action needed.
          </p>
          <div className="mt-8 flex items-center gap-5 text-xs text-gray-500">
            <StatusDot ok={cameraReady} label="Camera" />
            <StatusDot ok={signalStatus === 'connected'} label="Session" />
          </div>
          <WaitingDots />
        </div>
      )}

      {/* ---- Ended ---- */}
      {phase === 'ended' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600/20 ring-1 ring-emerald-500/40">
            <svg viewBox="0 0 24 24" className="h-8 w-8 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h1 className="text-xl font-medium text-white">The conversation has ended</h1>
          <p className="mt-2 text-sm text-gray-500">
            Please remain seated — the researcher will be with you shortly.
          </p>
        </div>
      )}

      {/* ---- Self-view PiP (always the raw, unaltered camera) ---- */}
      {phase !== 'ended' && selfStream && (
        <div className="absolute bottom-6 right-6 h-[124px] w-[220px] overflow-hidden rounded-xl border border-white/15 bg-black shadow-2xl">
          <video
            ref={selfVideoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full -scale-x-100 object-cover"
          />
          <div className="absolute bottom-1.5 left-2 text-[10px] font-medium text-white/80">You</div>
        </div>
      )}

      {/* ---- Researcher banner ---- */}
      {banner && (
        <div
          key={banner.key}
          className="absolute left-1/2 top-6 z-40 max-w-[70vw] -translate-x-1/2 animate-[bannerIn_.35s_ease-out] rounded-xl border border-white/15 bg-gray-900/90 px-6 py-3 text-center shadow-2xl backdrop-blur"
        >
          <p className="text-sm font-medium leading-snug text-white">{banner.text}</p>
        </div>
      )}

      {/* ---- Reconnecting overlay ---- */}
      {reconnecting && phase !== 'ended' && (
        <div className="absolute left-1/2 top-6 z-30 -translate-x-1/2 rounded-full bg-amber-500/15 px-4 py-1.5 text-xs font-medium text-amber-300 ring-1 ring-amber-500/40">
          Reconnecting…
        </div>
      )}

      {/* ---- Escape hatch (Ctrl+Shift+Q) ---- */}
      {escapeOpen && (
        <div className="absolute inset-0 z-50 flex cursor-default items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="w-[420px] rounded-2xl border border-gray-700 bg-gray-900 p-6 shadow-2xl">
            <h2 className="text-base font-semibold text-white">Close this station?</h2>
            <p className="mt-2 text-sm leading-relaxed text-gray-400">
              This ends the participant&apos;s view on this machine. Type{' '}
              <span className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-200">
                Confirm
              </span>{' '}
              to close.
            </p>
            <input
              ref={escapeInputRef}
              value={escapeText}
              onChange={(e) => setEscapeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmEscape()
                if (e.key === 'Escape') cancelEscape()
              }}
              className="mt-4 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2.5 font-mono text-sm text-white outline-none focus:border-red-500 focus:ring-2 focus:ring-red-500/30"
              placeholder="Type Confirm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={cancelEscape}
                className="rounded-lg px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmEscape}
                disabled={escapeText !== 'Confirm'}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition enabled:hover:bg-red-500 disabled:opacity-40"
              >
                Close station
              </button>
            </div>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes bannerIn {
          from {
            transform: translate(-50%, -16px);
            opacity: 0;
          }
          to {
            transform: translate(-50%, 0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  )
}

function Spinner() {
  return (
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-sky-400" />
  )
}

function StatusDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-400' : 'animate-pulse bg-gray-600'}`}
      />
      {label}
    </span>
  )
}

function WaitingDots() {
  return (
    <div className="mt-10 flex gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-500/70"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  )
}
