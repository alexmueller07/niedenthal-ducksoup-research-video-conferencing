import { useCallback, useEffect, useRef, useState } from 'react'
import { POST_CONVERSATION_ITEMS, RATING_INSTRUCTIONS } from '../../../main/ratingTask'
import type { RatingSample, VideoVersion } from '../../lib/protocol'
import type { ReviewScreenProps } from './ReviewScreen'
import { ReviewStage } from './ReviewStage'
import PostConversation from '../rating/PostConversation'
import Instructions from '../rating/Instructions'
import TransitionScreen from '../rating/TransitionScreen'
import RatingOverlay from '../rating/RatingOverlay'
import Slider from '../rating/Slider'
import { useAdvance } from '../rating/useAdvance'

const stats = { msAltered: 0, msClean: 0, toggles: 0, edits: 0, versionNow: 'altered' as const, firstTypedAtMs: null }

export function ContinuousRating(props: ReviewScreenProps) {
  return <RatingBlock key={`${props.state.runId}:${props.state.current}`} {...props} />
}

function RatingBlock({ state, media, mySlot, names, baseUrl, serverNow, send, ratingAck }: ReviewScreenProps) {
  const segment = state.segments[state.current]
  const turn = segment?.index ?? 0
  const key = `rating:${state.runId}:${mySlot}:${turn}`
  const [answers, setAnswers] = useState<Record<string, number | null>>({})
  const [instruction, setInstruction] = useState(state.current === 0 ? 0 : RATING_INSTRUCTIONS.length)
  const [announced, setAnnounced] = useState(state.status === 'writing')
  const [text, setText] = useState('')
  const [elicitation, setElicitation] = useState<number | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const samples = useRef<RatingSample[]>([])
  const nextSequence = useRef(0)
  const lastTime = useRef(-1)
  const rating = useRef({ value: 50, touched: false })
  const resetCall = useRef(true)
  const preparedSeq = useRef(-1)
  const self = segment?.targetSeat === mySlot
  const policy = state.config.mediaPolicy ?? 'altered'
  useEffect(() => { if (state.status === 'writing') setAnnounced(true) }, [state.status])
  const versionsBySeat = {
    P1: (policy === 'clean' || policy === 'audio' || (policy === 'self-clean-partner-altered' && mySlot === 'P1') ? 'clean' : 'altered') as VideoVersion,
    P2: (policy === 'clean' || policy === 'audio' || (policy === 'self-clean-partner-altered' && mySlot === 'P2') ? 'clean' : 'altered') as VideoVersion,
  }

  const persist = useCallback(() => {
    try { sessionStorage.setItem(key + ':samples', JSON.stringify(samples.current)) }
    catch { setNotice('Local recovery storage is unavailable. Please notify the researcher.') }
    setPendingCount(samples.current.length)
  }, [key])

  useEffect(() => {
    preparedSeq.current = -1
    try {
      samples.current = JSON.parse(sessionStorage.getItem(key + ':samples') || '[]')
      const latest = samples.current.at(-1)
      nextSequence.current = latest ? latest.sequence + 1 : Number(sessionStorage.getItem(key + ':sequence') || 0)
      lastTime.current = Math.max(latest?.videoMs ?? -1, Number(sessionStorage.getItem(key + ':lastTime') || -1))
      const draft = JSON.parse(sessionStorage.getItem(key + ':draft') || '{}')
      setText(draft.text || '')
      setElicitation(draft.elicitation ?? null)
      setAnswers(draft.answers || {})
    } catch { setNotice('Could not restore the local draft. Please notify the researcher.') }
    const timer = setInterval(() => {
      if (samples.current.length) send({ type: 'rating-samples', turn, samples: samples.current.slice(0, 100) })
    }, 500)
    return () => clearInterval(timer)
  }, [key, send, turn])

  useEffect(() => {
    if (!ratingAck || ratingAck.turn !== turn || ratingAck.sequence < 0) return
    samples.current = samples.current.filter(s => s.sequence > ratingAck.sequence)
    nextSequence.current = Math.max(nextSequence.current, ratingAck.sequence + 1)
    persist()
  }, [ratingAck, turn, persist])

  useEffect(() => {
    try { sessionStorage.setItem(key + ':draft', JSON.stringify({ text, elicitation, answers })) } catch { /* Samples report storage failures separately. */ }
  }, [key, text, elicitation, answers])

  useEffect(() => {
    const hide = () => {
      if (document.hidden && state.status === 'playing') send({ type: 'review-buffering', loadSeq: state.loadSeq })
      if (!document.hidden && state.status === 'loading' && preparedSeq.current === state.loadSeq && samples.current.length < 200)
        send({ type: 'review-ready', loadSeq: state.loadSeq })
    }
    document.addEventListener('visibilitychange', hide)
    return () => document.removeEventListener('visibilitychange', hide)
  }, [send, state.status, state.loadSeq])

  useEffect(() => {
    if (state.status === 'loading' && preparedSeq.current === state.loadSeq && !document.hidden && pendingCount < 200)
      send({ type: 'review-ready', loadSeq: state.loadSeq })
  }, [pendingCount, state.status, state.loadSeq, send])

  const sample = useCallback((videoMs: number) => {
    if (document.hidden || !segment || videoMs < segment.startMs || videoMs >= segment.endMs || videoMs <= lastTime.current + 50) return
    if (samples.current.length >= 200) {
      send({ type: 'review-buffering', loadSeq: state.loadSeq })
      setNotice('Waiting for ratings to save. Please notify the researcher if this persists.')
      return
    }
    lastTime.current = videoMs
    samples.current.push({ sequence: nextSequence.current++, videoMs: Math.round(videoMs), ...rating.current })
    try {
      sessionStorage.setItem(key + ':sequence', String(nextSequence.current))
      sessionStorage.setItem(key + ':lastTime', String(lastTime.current))
    } catch { /* persist reports failures. */ }
    persist()
  }, [segment, state.loadSeq, key, persist, send])

  const ready = useCallback((loadSeq: number) => {
    preparedSeq.current = loadSeq
    if (!document.hidden && samples.current.length < 200) send({ type: 'review-ready', loadSeq })
  }, [send])
  const buffering = useCallback((loadSeq: number) => send({ type: 'review-buffering', loadSeq }), [send])
  function advanceInstructions() {
    setInstruction(i => Math.min(i + 1, RATING_INSTRUCTIONS.length))
  }
  useAdvance(advanceInstructions, state.status !== 'questionnaire' && !announced && instruction < RATING_INSTRUCTIONS.length)

  // Same rule as the lab suite: a rating alone lets the participant through; with no
  // rating the dialog lists what is missing, and "Continue anyway" saves it blank.
  const [attempted, setAttempted] = useState(false)
  function doSubmit() {
    if (pendingCount) return
    setSubmitting(true)
    send({ type: 'review-submit', turn, text, stats, elicitation })
  }
  function handleSubmit() {
    if (elicitation === null) setAttempted(true)
    else doSubmit()
  }
  useEffect(() => {
    if (state.status !== 'writing') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      e.preventDefault()
      handleSubmit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    if (!submitting || state.done[mySlot] || state.status !== 'writing') return
    const id = setInterval(() => send({ type: 'review-submit', turn, text, stats, elicitation }), 1500)
    return () => clearInterval(id)
  }, [submitting, state.done, state.status, mySlot, send, turn, text, elicitation])

  const wrap = (node: React.ReactNode) => <div id="rating-root">{node}</div>
  if (state.status === 'done') return wrap(<div className="h-screen w-screen flex flex-col items-center justify-center bg-black text-center px-8"><h1 className="text-white text-3xl mb-4">You have finished. Thank you.</h1><p className="text-gray-400 text-xl">Please let your researcher know.</p></div>)
  if (state.status === 'questionnaire') {
    if (state.done[mySlot]) return wrap(<div className="h-screen w-screen flex items-center justify-center bg-black px-8"><p className="text-white text-3xl">Your answers are saved. Waiting for your partner.</p></div>)
    return wrap(<PostConversation responses={answers as Record<string, number>} onChange={(k, v) => setAnswers(a => ({ ...a, [k]: v }))}
      onContinue={() => send({ type: 'rating-questionnaire', responses: Object.fromEntries(POST_CONVERSATION_ITEMS.map(([id]) => [id, answers[id] ?? null])) })} />)
  }
  if (!announced) return wrap(instruction < RATING_INSTRUCTIONS.length
    ? <div className="h-screen w-screen"><Instructions instructionIndex={instruction} onBack={() => setInstruction(i => Math.max(0, i - 1))} onContinue={advanceInstructions} groupSize={RATING_INSTRUCTIONS.length} instructions={RATING_INSTRUCTIONS} /></div>
    : <div className="relative h-screen w-screen"><TransitionScreen ratingTarget={self ? 'self' : 'partner'} onContinue={() => setAnnounced(true)} /></div>)
  if (state.status === 'writing') return wrap(<div className="h-screen w-screen">
    <RatingOverlay currentRatingTarget={self ? 'self' : 'partner'} textInput={text} setTextInput={setText} numberScale={elicitation ?? undefined} setNumberScale={v => setElicitation(v ?? null)}
      attemptedSubmit={attempted} isFinal={turn === state.segments.length} onSubmit={handleSubmit} onConfirmIncomplete={() => { setAttempted(false); doSubmit() }} onDismissIncomplete={() => setAttempted(false)} />
    {(pendingCount > 0 || submitting || state.done[mySlot]) && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-gray-800 border border-white px-5 py-2 text-white">{state.done[mySlot] ? 'Saved. Waiting for your partner' : pendingCount ? 'Saving ratings…' : 'Saving response…'}</div>}
    {notice && <p role="alert" className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 text-red-300">{notice}</p>}
  </div>)
  return wrap(<div className={`h-screen w-screen overflow-hidden bg-black relative flex flex-col ${state.status === 'playing' ? 'cursor-none' : 'cursor-auto'}`}>
    <div className="absolute top-6 right-8 z-20 border-2 border-white bg-black px-5 py-2.5 text-center">
      <span className="block text-gray-400 text-xs uppercase tracking-widest">You are rating</span>
      <span className="block text-white text-xl font-bold">{self ? 'YOUR OWN FEELINGS' : "YOUR PARTNER'S FEELINGS"}</span>
    </div>
    <p className="text-center text-white mt-20 mb-7 text-2xl">How positive or negative did <span className="font-bold underline">{self ? 'YOU' : 'YOUR PARTNER'}</span> feel during this moment in the conversation?</p>
    <div className="relative flex-1 min-h-0 w-full px-10 pb-40"><ReviewStage state={state} media={media} viewer={mySlot} names={names} baseUrl={baseUrl} serverNow={serverNow} mode={state.config.viewMode} versions={['altered']} versionsBySeat={versionsBySeat} version="altered" audioOnly={policy === 'audio'} onReady={ready} onBuffering={buffering} onPlaybackTime={sample} /></div>
    <div className="absolute bottom-0 left-0 w-full cursor-none border-t border-white bg-black px-10 pt-6 pb-8">
      <Slider resetTrigger={0} onSample={v => {
        if (resetCall.current) { resetCall.current = false; rating.current = { value: v, touched: false }; return }
        rating.current = { value: v, touched: true }
      }} />
    </div>
    {state.status !== 'playing' && <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/85"><p role="status" className="max-w-xl border border-white bg-black p-8 text-center text-white text-2xl">{state.status === 'paused' ? 'Paused by the researcher' : 'Preparing the conversation. Please wait.'}</p></div>}
    {notice && <p role="alert" className="absolute bottom-28 left-1/2 -translate-x-1/2 z-40 text-red-300">{notice}</p>}
  </div>)
}
