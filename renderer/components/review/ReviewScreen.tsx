// The participant's screen during the post-call review: the videos on the
// left (in the researcher's chosen view mode), the writing panel on the right.
//
// Also keeps the numbers that go into review_responses.csv for each turn:
// how long each video version was on screen, how often they switched, how
// many edits they made, and when they first typed.

import { useCallback, useEffect, useRef, useState } from 'react'
import { reviewPositionMs } from '../../../main/review'
import { ReviewStage, VERSION_LABEL } from './ReviewStage'
import { ResponseBox } from './ResponseBox'
import type {
  ClientMessage,
  PSlot,
  ReviewMedia,
  ReviewState,
  ReviewViewingStats,
  VideoVersion,
} from '../../lib/protocol'

const DRAFT_SEND_MS = 2000
const STATS_TICK_MS = 250

export interface RestoredDraft {
  turn: number
  text: string
  submitted: boolean
}

export interface ReviewScreenProps {
  state: ReviewState
  media: ReviewMedia
  mySlot: PSlot
  names: Record<PSlot, string>
  baseUrl: string
  serverNow: () => number
  send: (msg: ClientMessage) => void
  restored: RestoredDraft | null
}

interface TurnStats {
  msAltered: number
  msClean: number
  toggles: number
  edits: number
  firstTypedAtMs: number | null
}

const freshStats = (): TurnStats => ({ msAltered: 0, msClean: 0, toggles: 0, edits: 0, firstTypedAtMs: null })

export function ReviewScreen({ state, media, mySlot, names, baseUrl, serverNow, send, restored }: ReviewScreenProps) {
  const segment = state.segments[state.current]
  const turn = segment?.index ?? 0
  const partner: PSlot = mySlot === 'P1' ? 'P2' : 'P1'
  const mode = state.config.viewMode
  const versions: VideoVersion[] = state.config.showOriginal ? ['altered', 'clean'] : ['altered']

  const [version, setVersion] = useState<VideoVersion>('altered')
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [, setTick] = useState(0)

  const statsRef = useRef<TurnStats>(freshStats())
  const textRef = useRef('')
  const dirtyRef = useRef(false)
  const versionRef = useRef<VideoVersion>('altered')
  const submittedRef = useRef(false)
  textRef.current = text
  versionRef.current = version
  submittedRef.current = submitted

  const statsNow = useCallback(
    (): ReviewViewingStats => ({ ...statsRef.current, versionNow: versionRef.current }),
    [],
  )

  const viewPayload = useCallback(
    (v: VideoVersion) => ({
      type: 'review-view' as const,
      turn,
      mode,
      person: mode === 'gallery' ? ('both' as const) : mode === 'single' ? partner : (segment?.targetSeat ?? partner),
      version: mode === 'gallery' ? (versions.length > 1 ? ('both' as const) : 'altered') : v,
      positionMs: reviewPositionMs(state, serverNow()),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turn, mode, partner, segment?.targetSeat, versions.length, state, serverNow],
  )

  // A new turn: clear the answer (or put back what the server kept for us).
  useEffect(() => {
    if (!turn) return
    statsRef.current = freshStats()
    dirtyRef.current = false
    setVersion('altered')
    versionRef.current = 'altered'
    setText('')
    setSubmitted(false)
    send(viewPayload('altered'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turn])

  useEffect(() => {
    if (!restored || restored.turn !== turn) return
    setText(restored.text)
    setSubmitted(restored.submitted)
  }, [restored, turn])

  // Time on screen per version, and a re-render for the clock.
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => t + 1)
      if (submittedRef.current || state.status === 'done') return
      const s = statsRef.current
      const onScreen: VideoVersion[] = mode === 'gallery' ? versions : [versionRef.current]
      if (onScreen.includes('altered')) s.msAltered += STATS_TICK_MS
      if (onScreen.includes('clean')) s.msClean += STATS_TICK_MS
    }, STATS_TICK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, versions.length, state.status])

  // Keep the server's copy of the answer fresh, so nothing is lost on a drop.
  useEffect(() => {
    const id = setInterval(() => {
      if (!dirtyRef.current || submittedRef.current || !turn) return
      dirtyRef.current = false
      send({ type: 'review-draft', turn, text: textRef.current, stats: statsNow() })
    }, DRAFT_SEND_MS)
    return () => clearInterval(id)
  }, [turn, send, statsNow])

  function onText(next: string) {
    const s = statsRef.current
    s.edits += 1
    if (s.firstTypedAtMs === null && next.trim()) s.firstTypedAtMs = Math.round(serverNow())
    dirtyRef.current = true
    setText(next)
  }

  function onDone() {
    setSubmitted(true)
    send({ type: 'review-submit', turn, text, stats: statsNow() })
  }

  function chooseVersion(v: VideoVersion) {
    if (v === version) return
    statsRef.current.toggles += 1
    setVersion(v)
    versionRef.current = v
    send(viewPayload(v))
  }

  const onReady = useCallback((loadSeq: number) => send({ type: 'review-ready', loadSeq }), [send])
  const onBuffering = useCallback((loadSeq: number) => send({ type: 'review-buffering', loadSeq }), [send])

  if (state.status === 'done') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-950 via-gray-900 to-gray-950">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-600/20 ring-1 ring-emerald-500/40">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-xl font-medium text-white">You have finished the review. Thank you!</h1>
        <p className="mt-2 text-sm text-gray-500">Please remain seated. The researcher will be with you shortly.</p>
      </div>
    )
  }
  if (!segment) return null

  const now = serverNow()
  const positionMs = reviewPositionMs(state, now)
  const aboutMe = segment.targetSeat === mySlot
  const autoAdvanceIn =
    state.autoAdvanceAtMs !== null ? Math.max(0, Math.ceil((state.autoAdvanceAtMs - now) / 1000)) : null
  const shownPerson = mode === 'single' ? partner : segment.targetSeat
  const hold = holdMessage(state, names[partner])

  return (
    <div className="absolute inset-0 flex bg-gray-950 text-white">
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-sm font-medium text-gray-300">Reviewing your conversation</h1>
          {mode !== 'gallery' && versions.length > 1 && (
            <div className="flex rounded-lg bg-gray-900 p-1 ring-1 ring-gray-800" role="group" aria-label="Video version">
              {versions.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => chooseVersion(v)}
                  aria-pressed={version === v}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                    version === v ? 'bg-sky-600 text-white' : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {VERSION_LABEL[v]} video
                </button>
              ))}
            </div>
          )}
          {mode !== 'gallery' && (
            <span className="text-xs text-gray-500">Showing {shownPerson === mySlot ? 'you' : names[shownPerson]}</span>
          )}
        </div>
        <div className="relative min-h-0 flex-1">
          <ReviewStage
            state={state}
            media={media}
            baseUrl={baseUrl}
            serverNow={serverNow}
            mode={mode}
            versions={versions}
            version={version}
            viewer={mySlot}
            names={{ ...names, [mySlot]: 'You' }}
            onReady={onReady}
            onBuffering={onBuffering}
          />
          {hold && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-gray-950/70 backdrop-blur-sm">
              {state.status === 'loading' && (
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-700 border-t-sky-400" />
              )}
              <p className="text-sm text-gray-300">{hold}</p>
            </div>
          )}
        </div>
      </div>
      <aside className="w-[380px] shrink-0 border-l border-gray-800 bg-gray-900/70 p-6">
        <ResponseBox
          segment={segment}
          totalTurns={state.segments.length}
          aboutMe={aboutMe}
          aboutName={names[segment.targetSeat]}
          partnerName={names[partner]}
          status={state.status}
          positionMs={positionMs}
          text={text}
          submitted={submitted}
          partnerDone={state.done[partner]}
          autoAdvanceIn={autoAdvanceIn}
          canPause={state.config.allowPause}
          onText={onText}
          onDone={onDone}
          onPauseToggle={() =>
            send({ type: 'review-control', action: state.status === 'paused' ? 'resume' : 'pause' })
          }
        />
      </aside>
    </div>
  )
}

function holdMessage(state: ReviewState, partnerName: string): string | null {
  if (state.status === 'paused') {
    return state.holdReason === 'participant' ? 'Paused' : 'Paused by the researcher'
  }
  if (state.status !== 'loading') return null
  if (state.holdReason === 'disconnect') return `Waiting for ${partnerName} to reconnect…`
  if (state.holdReason === 'buffering') return 'The video is catching up…'
  return 'Getting the video ready…'
}
