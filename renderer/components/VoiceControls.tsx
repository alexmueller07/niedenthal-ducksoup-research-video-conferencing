// The voice strip that sits under a participant's video, styled to match the
// face calibration strip next to it: the voice baseline, the voice changes
// for this seat, and a recalibrate button.
//
// The server holds ONE voice condition for the pair, so applying a change in
// one seat's strip replaces whatever was running on the other seat.

import { useEffect, useState } from 'react'
import { DEFAULT_VOICE_CONDITION, voiceUsable } from '../../main/voiceProtocol'
import type { VoiceCondition, VoiceMode, VoicePairState, VoiceSeat } from '../../main/voiceProtocol'

const MODES: Array<{ mode: VoiceMode; label: string; hint: string }> = [
  { mode: 'bypass', label: 'Natural', hint: 'Their real voice, no change' },
  { mode: 'audibility', label: 'Audibility', hint: 'Makes both people equally loud' },
  { mode: 'match', label: 'Match', hint: "Makes their voice a bit more like their partner's" },
  { mode: 'detone', label: 'Detone', hint: 'Makes their voice flatter and less lively' },
]

export function VoicePanel({
  slot,
  state,
  connected,
  participantConnected,
  phase,
  error,
  onApply,
  onReset,
  solo = false,
}: {
  /** 1-person test station: no partner, so no Match and no other seat. */
  solo?: boolean
  slot: VoiceSeat
  state: VoicePairState | null
  connected: boolean
  participantConnected: boolean
  phase: string
  error: string
  onApply: (c: VoiceCondition) => void
  onReset: () => void
}) {
  const [now, setNow] = useState(Date.now())
  const [strength, setStrength] = useState(1)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const fresh = (s: VoiceSeat) => {
    const r = state?.reports[s]
    return connected && !!state?.available[s] && !!r && Math.abs(now - r.capturedAt) < 4000 ? r : undefined
  }
  const r = participantConnected ? fresh(slot) : undefined
  const c = r?.calibration
  const healthy = r?.health.state === 'ready'
  const ready = (s: VoiceSeat) => {
    const x = fresh(s)
    return !!x && voiceUsable(x.calibration) && x.health.state === 'ready'
  }

  // Offline, the last condition the server sent is stale; show none.
  const active = connected ? state?.condition : undefined
  const activeHere = !!active && (active.mode === 'audibility' || active.targetSlot === slot)
  const activeMode: VoiceMode = activeHere ? active!.mode : 'bypass'
  const elsewhere =
    active && !activeHere && active.mode !== 'bypass' ? `${active.mode === 'match' ? 'Match' : 'Detone'} is on ${active.targetSlot}` : null

  const mic = !r
    ? 'unavailable'
    : !healthy
      ? 'needs attention'
      : r.clean.clippingRate > 0.001
        ? 'too loud'
        : r.clean.speechActive && r.clean.rmsDbfs - r.clean.noiseFloorDbfs < 12
          ? 'noisy'
          : r.clean.speechActive && r.clean.rmsDbfs < -40
            ? 'quiet'
            : 'good'

  const status = !connected || !participantConnected ? 'offline' : !r ? 'waiting' : !healthy ? 'needs attention' : c?.state === 'strong' ? 'strong' : voiceUsable(c!) ? 'ready' : 'collecting'
  const statusClass =
    status === 'ready' || status === 'strong'
      ? 'bg-emerald-600/25 text-emerald-200 ring-emerald-500/35'
      : status === 'collecting'
        ? 'bg-amber-600/25 text-amber-200 ring-amber-500/35'
        : status === 'needs attention'
          ? 'bg-red-600/25 text-red-200 ring-red-500/35'
          : 'bg-gray-800 text-gray-500 ring-gray-700'

  function apply(mode: VoiceMode) {
    onApply({
      ...DEFAULT_VOICE_CONDITION,
      mode,
      strength,
      targetSlot: mode === 'match' || mode === 'detone' ? slot : null,
      pitchRangeScale: mode === 'detone' ? 0.75 : 1,
      intensityRangeScale: mode === 'detone' ? 0.8 : 1,
    })
  }
  const canUse = (mode: VoiceMode) =>
    connected &&
    phase !== 'ended' &&
    (mode === 'bypass' || (!solo && (mode === 'match' || mode === 'audibility') ? ready('P1') && ready('P2') : ready(slot)))

  return (
    <div className="mt-3 rounded-xl border border-gray-800 bg-gray-950/45 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Voice baseline</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusClass}`}>{status}</span>
      </div>

      {!r ? (
        <p className="mt-2 rounded-lg bg-gray-900/70 px-3 py-4 text-center text-[11px] text-gray-500">
          {solo
            ? 'Play a recording to start'
            : !connected
              ? 'Waiting for session server'
              : !participantConnected
                ? 'No participant connected'
                : 'Waiting for audio'}
        </p>
      ) : (
        <>
          <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px]">
            <Figure label="Speech heard" value={`${Math.min(20, Math.round(c?.voicedSeconds ?? 0))} / 20 s`} hint="natural talking" />
            <Figure label="Turns" value={`${Math.min(3, c?.validTurns ?? 0)} / 3`} hint="separate times talking" />
            <Figure label="Microphone" value={mic} hint={healthy ? 'signal quality' : (r.health.reason ?? 'audio processor')} />
          </div>
          {activeHere && active?.mode !== 'bypass' && plainReason(r.applied.fallbackReason) && (
            <p className="mt-2 text-[10.5px] text-amber-300">
              Voice not being changed right now: {plainReason(r.applied.fallbackReason)}
            </p>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {MODES.filter((m) => !solo || m.mode !== 'match').map(({ mode, label, hint }) => (
          <span key={mode} className="group relative">
            <button
              type="button"
              disabled={!canUse(mode)}
              onClick={() => apply(mode)}
              className={
                'rounded-full px-2.5 py-1 text-[11px] transition disabled:pointer-events-none disabled:opacity-40 ' +
                (activeMode === mode ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-300 enabled:hover:bg-gray-700')
              }
            >
              {label}
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 whitespace-nowrap rounded-md bg-gray-800 px-2 py-1 text-[10.5px] text-gray-200 opacity-0 shadow-lg ring-1 ring-gray-700 transition-opacity duration-75 group-hover:opacity-100"
            >
              {hint}
              {!canUse(mode) && mode !== 'bypass' && (
                <span className="block text-amber-300">
                  {!solo && (mode === 'match' || mode === 'audibility') ? 'Needs both voice baselines first' : 'Needs voice baseline first'}
                </span>
              )}
            </span>
          </span>
        ))}
        <span className="group relative ml-auto">
          <select
            aria-label={`${slot} voice change strength`}
            value={strength}
            onChange={(e) => setStrength(Number(e.target.value))}
            className="rounded-lg bg-gray-800 px-2 py-1 text-[11px] text-gray-300"
          >
            <option value={0.5}>Subtle</option>
            <option value={1}>Standard</option>
          </select>
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full right-0 z-20 mb-1.5 whitespace-nowrap rounded-md bg-gray-800 px-2 py-1 text-[10.5px] text-gray-200 opacity-0 shadow-lg ring-1 ring-gray-700 transition-opacity duration-75 group-hover:opacity-100"
          >
            How strong Match and Detone are. Subtle is half.
          </span>
        </span>
      </div>
      {elsewhere && !solo && <p className="mt-2 text-[10.5px] text-gray-500">{elsewhere}. Picking one here replaces it.</p>}
      {error && <p role="alert" className="mt-2 text-[10.5px] text-red-300">{error}</p>}

      <div className="mt-3 flex">
        <button
          type="button"
          onClick={onReset}
          disabled={!r || !healthy || phase === 'ended'}
          title="Start this person's voice baseline again and turn voice changes off"
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-[11px] font-semibold text-white transition enabled:hover:bg-sky-500 disabled:opacity-40"
        >
          Recalibrate voice
        </button>
      </div>
    </div>
  )
}

// The processor's reasons, in words a researcher can act on. Being quiet is
// normal, so that one is not worth a warning.
function plainReason(reason: string | null): string | null {
  if (!reason || reason === 'Waiting for clear voiced speech') return null
  if (reason === 'Microphone clipping') return 'mic is too loud'
  if (reason === 'Low signal-to-noise ratio') return 'too much background noise'
  if (reason === 'Waiting for a recent partner turn') return 'waiting for the partner to talk'
  if (reason.startsWith('Collecting') || reason.startsWith('Waiting for a quiet')) return 'voice baseline not ready yet'
  return 'voice tool stopped working'
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg bg-gray-900/80 px-2 py-1.5">
      <p className="font-medium text-gray-400">{label}</p>
      <p className="font-mono text-gray-200">{value}</p>
      <p className="truncate text-[9.5px] text-gray-600">{hint}</p>
    </div>
  )
}
