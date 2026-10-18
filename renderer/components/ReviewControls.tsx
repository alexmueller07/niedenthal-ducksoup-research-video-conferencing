// The researcher's panel for the post-call review.
//
// Once the conversation has ended: the review settings (view mode, turn
// length, …) and the Start button, which stays disabled until every
// recording has finished saving. While the review runs: which turn is on,
// where each participant is (watching, writing, done, disconnected), the
// controls, and a small synced preview of the video the turn is about.

import { useCallback, useEffect, useState } from 'react'
import { buildSegments, reviewPositionMs } from '../../main/review'
import { fmtTimeline } from '../lib/reviewSync'
import { ReviewStage, VERSION_LABEL } from './review/ReviewStage'
import { DEFAULT_REVIEW_CONFIG } from '../lib/protocol'
import type {
  Phase,
  PSlot,
  ReviewAvailability,
  ReviewConfig,
  ReviewControlAction,
  ReviewMedia,
  ReviewState,
  ReviewViewMode,
  VideoVersion,
} from '../lib/protocol'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'

const SEATS: PSlot[] = ['P1', 'P2']
const PREF_KEY = 'reviewConfig'

const MODES: { id: ReviewViewMode; label: string; hint: string }[] = [
  { id: 'active', label: 'Active speaker', hint: 'Only the person whose turn it is' },
  { id: 'single', label: 'Single', hint: "Each person sees their partner's video" },
  { id: 'gallery', label: 'Gallery', hint: 'Everyone at once' },
]

export interface ReviewControlsProps {
  phase: Phase
  availability: ReviewAvailability | null
  state: ReviewState | null
  media: ReviewMedia | null
  error: string
  names: Record<PSlot, string>
  baseUrl: string
  onStart: (config: ReviewConfig) => void
  onControl: (action: ReviewControlAction) => void
  onEnd: () => void
}

export function ReviewControls(props: ReviewControlsProps) {
  const running = props.phase === 'review' && props.state && props.state.status !== 'idle'
  // Kept here rather than in the setup form, so the settings survive a review being run and ended.
  const [config, setConfig] = useState<ReviewConfig>(DEFAULT_REVIEW_CONFIG)

  // The last settings used on this machine come back as the default.
  useEffect(() => {
    if (!hasIpc()) return
    void ipcInvoke<Partial<ReviewConfig> | null>('prefs:get', PREF_KEY).then((saved) => {
      if (saved) setConfig((c) => ({ ...c, ...saved }))
    })
  }, [])

  return (
    <section className="rounded-2xl border border-sky-900/60 bg-sky-950/20 p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Post-call review</h2>
          <p className="mt-0.5 text-[11px] text-gray-500">
            Both participants rewatch the call together in alternating turns and write about each one.
          </p>
        </div>
        {props.error && <p className="text-xs font-medium text-red-300">{props.error}</p>}
      </div>
      {running && props.media ? (
        <ReviewProgress {...props} state={props.state as ReviewState} media={props.media} />
      ) : (
        <ReviewSetup {...props} config={config} setConfig={setConfig} />
      )}
    </section>
  )
}

function ReviewSetup({
  availability,
  phase,
  onStart,
  config,
  setConfig,
}: ReviewControlsProps & { config: ReviewConfig; setConfig: (f: (c: ReviewConfig) => ReviewConfig) => void }) {
  const update = (patch: Partial<ReviewConfig>) => setConfig((c) => ({ ...c, ...patch }))
  const turns = availability ? buildSegments(availability.conversationMs, config).length : 0

  function start() {
    if (hasIpc()) void ipcInvoke('prefs:set', PREF_KEY, config)
    onStart(config)
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
      <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="View mode">
          <div className="flex flex-wrap gap-1.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                title={m.hint}
                onClick={() => update({ viewMode: m.id })}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                  config.viewMode === m.id ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Turn length">
          <div className="space-y-1.5 text-xs text-gray-400">
            <div className="flex items-center gap-2">
              <NumberInput value={config.segmentSec} min={10} max={1800} onChange={(v) => update({ segmentSec: v })} />
              seconds
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-500">
              A last part shorter than
              <NumberInput value={config.minTailSec} min={0} max={600} onChange={(v) => update({ minTailSec: v })} />
              s is added to the turn before it
            </div>
          </div>
        </Field>
        <Field label="Goes first">
          <div className="flex gap-1.5">
            {SEATS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => update({ firstSeat: s })}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition ${
                  config.firstSeat === s ? 'bg-sky-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {s === 'P1' ? 'Participant 1' : 'Participant 2'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Next turn starts">
          <select
            value={config.advance}
            onChange={(e) => update({ advance: e.target.value === 'auto' ? 'auto' : 'both-done' })}
            className="rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs outline-none focus:border-sky-500"
          >
            <option value="both-done">When both press Done</option>
            <option value="auto">By itself, 10 s after the clip ends</option>
          </select>
        </Field>
        <Check
          checked={config.showOriginal}
          onChange={(v) => update({ showOriginal: v })}
          label="Show participants the original video too"
          hint="This lets them see the face/voice changes. Check your study protocol first."
        />
        <Check
          checked={config.allowPause}
          onChange={(v) => update({ allowPause: v })}
          label="Participants can pause"
          hint="A pause always stops the video for both of them."
        />
      </div>
      <div className="flex flex-col items-start justify-end gap-1.5 lg:items-end">
        <button
          type="button"
          onClick={start}
          disabled={!availability?.canStart}
          className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold transition enabled:hover:bg-sky-500 disabled:opacity-40"
        >
          ▶ Start review
        </button>
        <p className="text-[11px] text-gray-500">
          {phase !== 'ended'
            ? 'Available once the conversation has ended.'
            : !availability
              ? 'Checking the recordings…'
              : availability.canStart
                ? `${fmtTimeline(availability.conversationMs)} recorded · ${turns} turns`
                : availability.reason}
        </p>
      </div>
    </div>
  )
}

function ReviewProgress({
  state,
  media,
  names,
  baseUrl,
  onControl,
  onEnd,
}: ReviewControlsProps & { state: ReviewState; media: ReviewMedia }) {
  const [version, setVersion] = useState<VideoVersion>('altered')
  const [, setTick] = useState(0)
  const [confirmEnd, setConfirmEnd] = useState(false)
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(id)
  }, [])
  // The researcher's dashboard runs on the server machine, so its clock is the server's.
  const serverNow = useCallback(() => Date.now(), [])

  const seg = state.segments[state.current]
  const done = state.status === 'done'
  const pos = reviewPositionMs(state, Date.now())
  const statusText: Record<ReviewState['status'], string> = {
    idle: '',
    loading:
      state.holdReason === 'disconnect'
        ? 'Waiting for a participant to reconnect'
        : state.holdReason === 'buffering'
          ? 'A video is catching up'
          : 'Loading the video on both screens',
    playing: 'Playing',
    paused: state.holdReason === 'participant' ? 'Paused by a participant' : 'Paused',
    writing: 'Clip finished, participants writing',
    done: 'All turns finished',
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          {seg && !done && (
            <span className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-semibold ring-1 ring-gray-800">
              Turn {seg.index} of {state.segments.length} · {names[seg.targetSeat]}&apos;s video ·{' '}
              <span className="font-mono text-gray-400">
                {fmtTimeline(seg.startMs)}–{fmtTimeline(seg.endMs)}
              </span>
            </span>
          )}
          <span className="text-xs text-gray-400">{statusText[state.status]}</span>
          {seg && !done && (
            <span className="font-mono text-xs tabular-nums text-gray-500">
              {fmtTimeline(pos - seg.startMs)} / {fmtTimeline(seg.endMs - seg.startMs)}
            </span>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          {SEATS.map((slot) => {
            const label = !state.connected[slot]
              ? { text: 'Disconnected', cls: 'text-red-300' }
              : state.done[slot]
                ? { text: 'Done', cls: 'text-emerald-300' }
                : state.status === 'loading'
                  ? state.ready[slot]
                    ? { text: 'Ready', cls: 'text-emerald-300' }
                    : { text: 'Loading…', cls: 'text-amber-300' }
                  : state.status === 'writing'
                    ? { text: 'Still writing', cls: 'text-amber-300' }
                    : { text: 'Watching', cls: 'text-gray-300' }
            return (
              <div key={slot} className="rounded-lg bg-gray-900/70 px-3 py-2 ring-1 ring-gray-800">
                <p className="text-[11px] text-gray-500">
                  {names[slot]}
                  {seg && !done && (seg.targetSeat === slot ? ' · writing about themselves' : ' · writing about their partner')}
                </p>
                <p className={`text-sm font-medium ${done ? 'text-gray-300' : label.cls}`}>{done ? 'Finished' : label.text}</p>
              </div>
            )
          })}
        </div>

        <div className="flex flex-wrap gap-2">
          {state.status === 'loading' && (
            <Action onClick={() => onControl('play-now')} title="Start the clip without waiting for both screens">
              ▶ Start without waiting
            </Action>
          )}
          {state.status === 'playing' && <Action onClick={() => onControl('pause')}>❚❚ Pause</Action>}
          {state.status === 'paused' && <Action onClick={() => onControl('resume')}>▶ Resume</Action>}
          {!done && <Action onClick={() => onControl('restart-turn')}>↺ Replay this clip</Action>}
          {!done && (
            <Action
              onClick={() => onControl('force-next')}
              title="Save whatever each person has written so far and move to the next turn"
            >
              ⏭ Next turn now
            </Action>
          )}
          {confirmEnd ? (
            <span className="flex items-center gap-2 text-xs text-gray-300">
              {done ? 'End the review?' : 'End the review early? Unsaved answers for this turn are lost.'}
              <button
                type="button"
                onClick={onEnd}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold hover:bg-red-500"
              >
                End review
              </button>
              <button type="button" onClick={() => setConfirmEnd(false)} className="text-gray-400 hover:text-gray-200">
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmEnd(true)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                done ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600/80 hover:bg-red-500'
              }`}
            >
              ■ End review
            </button>
          )}
        </div>
        <p className="text-[11px] text-gray-500">
          View mode: {MODES.find((m) => m.id === state.config.viewMode)?.label} ·{' '}
          {state.config.showOriginal ? 'original video shown' : 'altered video only'} ·{' '}
          {state.config.advance === 'auto' ? 'turns move on by themselves' : 'turns wait for both to press Done'}
        </p>
      </div>

      {!done && (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[11px] text-gray-500">Preview (muted)</span>
            <div className="flex rounded-md bg-gray-900 p-0.5 ring-1 ring-gray-800">
              {(['altered', 'clean'] as VideoVersion[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setVersion(v)}
                  className={`rounded px-2 py-0.5 text-[10px] font-semibold ${
                    version === v ? 'bg-sky-600 text-white' : 'text-gray-400'
                  }`}
                >
                  {VERSION_LABEL[v]}
                </button>
              ))}
            </div>
          </div>
          <div className="relative aspect-video">
            <ReviewStage
              state={state}
              media={media}
              baseUrl={baseUrl}
              serverNow={serverNow}
              mode="active"
              versions={['altered', 'clean']}
              version={version}
              viewer={null}
              names={names}
              muted
            />
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">{label}</p>
      {children}
    </div>
  )
}

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-300">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-sky-500"
      />
      <span>
        {label}
        <span className="block text-[11px] text-gray-500">{hint}</span>
      </span>
    </label>
  )
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      value={value}
      onChange={(e) => {
        const n = Number(e.target.value)
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))))
      }}
      className="w-16 rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-center text-xs text-white outline-none focus:border-sky-500"
    />
  )
}

function Action({ onClick, title, children }: { onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-gray-200 transition hover:bg-gray-700"
    >
      {children}
    </button>
  )
}
