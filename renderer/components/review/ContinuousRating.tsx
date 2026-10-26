import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Headphones, ClipboardList } from 'lucide-react'
import { POST_CONVERSATION_ITEMS, RATING_INSTRUCTIONS } from '../../../main/ratingTask'
import type { RatingSample, VideoVersion } from '../../lib/protocol'
import type { ReviewScreenProps } from './ReviewScreen'
import { ReviewStage } from './ReviewStage'

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
  const [dwell, setDwell] = useState(false)
  const [value, setValue] = useState(50)
  const [text, setText] = useState('')
  const [elicitation, setElicitation] = useState<number | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const samples = useRef<RatingSample[]>([])
  const nextSequence = useRef(0)
  const lastTime = useRef(-1)
  const rating = useRef({ value: 50, touched: false })
  const preparedSeq = useRef(-1)
  const self = segment?.targetSeat === mySlot
  const target = self ? 'YOUR OWN FEELINGS' : "YOUR PARTNER'S FEELINGS"
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
    const id = setTimeout(() => setDwell(true), 3000)
    return () => clearTimeout(id)
  }, [instruction])

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
  const next = () => {
    if (!dwell) return
    if (instruction < RATING_INSTRUCTIONS.length) { setInstruction(i => i + 1); setDwell(false) }
    else setAnnounced(true)
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (state.status === 'questionnaire' || announced || e.repeat || !['Enter', ' '].includes(e.key)) return
      e.preventDefault()
      next()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.status, announced, instruction, dwell])

  function submit() {
    if (pendingCount) return
    if ((!text.trim() || elicitation === null) && !window.confirm('Continue with an unanswered item? It will be saved as missing.')) return
    setSubmitting(true)
    send({ type: 'review-submit', turn, text, stats, elicitation })
  }
  useEffect(() => {
    if (!submitting || state.done[mySlot] || state.status !== 'writing') return
    const id = setInterval(() => send({ type: 'review-submit', turn, text, stats, elicitation }), 1500)
    return () => clearInterval(id)
  }, [submitting, state.done, state.status, mySlot, send, turn, text, elicitation])

  if (state.status === 'done') return <TaskFrame><Check size={32} /><h1>You have finished. Thank you.</h1><p>Please let your researcher know.</p></TaskFrame>
  if (state.status === 'questionnaire') return <TaskFrame wide>
    <ClipboardList size={26} /><h1>Your conversation</h1>
    {state.done[mySlot] ? <p>Your answers are saved. Waiting for your partner.</p> : <>
      {POST_CONVERSATION_ITEMS.map(([id, label], index) => {
        const talking = id === 'relative_talking'
        return <fieldset className="rating-question" key={id}><legend><span>{index + 1}.</span> {label}</legend>
          <div className="rating-scale-labels"><span>{talking ? 'My partner talked much more' : 'Not at all'}</span><span>{talking ? 'I talked much more' : 'Very much'}</span></div>
          <div className="rating-numbers" role="radiogroup" aria-label={label}>{Array.from({ length: 11 }, (_, i) => i + (talking ? -5 : 0)).map(n => <button key={n} role="radio" aria-checked={answers[id] === n} className={answers[id] === n ? 'selected' : ''} onClick={() => setAnswers(a => ({ ...a, [id]: n }))}>{n}</button>)}</div>
        </fieldset>
      })}
      <button className="rating-primary" onClick={() => {
        const missing = POST_CONVERSATION_ITEMS.filter(([id]) => answers[id] === undefined)
        if (missing.length && !window.confirm(`${missing.length} unanswered items. Continue and save these as missing?`)) return
        send({ type: 'rating-questionnaire', responses: Object.fromEntries(POST_CONVERSATION_ITEMS.map(([id]) => [id, answers[id] ?? null])) })
      }}>Continue <ArrowRight size={17} /></button>
    </>}
  </TaskFrame>
  if (!announced) return <TaskFrame>
    <Headphones size={28} />
    <span className="rating-eyebrow">{instruction < RATING_INSTRUCTIONS.length ? 'Before you begin' : `Part ${turn} of ${state.segments.length}`}</span>
    <h1>{instruction < RATING_INSTRUCTIONS.length ? RATING_INSTRUCTIONS[instruction] : `Focus on ${target.toLowerCase()}`}</h1>
    <button className="rating-primary" disabled={!dwell} onClick={next}>Continue <ArrowRight size={17} /></button>
  </TaskFrame>
  if (state.status === 'writing') return <TaskFrame>
    <span className="rating-eyebrow">Part {turn} of {state.segments.length}</span>
    <h1>Please use the box below to write about how {self ? 'YOU were' : 'YOUR PARTNER was'} feeling during the part of the conversation you just watched.</h1>
    <textarea aria-label="Description of feelings" value={text} disabled={state.done[mySlot] || submitting} maxLength={20000} onChange={e => setText(e.target.value)} />
    <p>To what extent do you feel that {self ? 'YOUR PARTNER' : 'YOU'} elicited these feelings in {self ? 'YOU' : 'YOUR PARTNER'}?</p>
    <div className="rating-scale-labels"><span>Not at all</span><span>Very</span></div>
    <div className="rating-numbers">{Array.from({ length: 9 }, (_, i) => i + 1).map(n => <button key={n} disabled={state.done[mySlot] || submitting} aria-pressed={elicitation === n} className={elicitation === n ? 'selected' : ''} onClick={() => setElicitation(n)}>{n}</button>)}</div>
    <button className="rating-primary" disabled={!!pendingCount || submitting || state.done[mySlot]} onClick={submit}>{state.done[mySlot] ? 'Saved. Waiting for your partner' : pendingCount ? 'Saving ratings...' : submitting ? 'Saving response...' : 'Continue'} <ArrowRight size={17} /></button>
    {notice && <p role="alert">{notice}</p>}
  </TaskFrame>
  return <div className="rating-player">
    <header><span>Part {turn} of {state.segments.length}</span><strong>{target}</strong></header>
    <div className="rating-video"><ReviewStage state={state} media={media} viewer={mySlot} names={names} baseUrl={baseUrl} serverNow={serverNow} mode={state.config.viewMode} versions={['altered']} versionsBySeat={versionsBySeat} version="altered" audioOnly={policy === 'audio'} onReady={ready} onBuffering={buffering} onPlaybackTime={sample} /></div>
    {state.status !== 'playing' && <p className="rating-hold" role="status">{state.status === 'paused' ? 'Paused by the researcher' : 'Preparing the conversation. Please wait.'}</p>}
    <footer><h2>How positive or negative did {self ? 'YOU' : 'YOUR PARTNER'} feel during this moment in the conversation?</h2>
      <input type="range" min={0} max={100} step={1} value={value} disabled={state.status !== 'playing'} aria-label="Feelings from very negative to very positive" onChange={e => { const n = Number(e.target.value); setValue(n); rating.current = { value: n, touched: true } }} />
      <div className="rating-scale-labels"><span>Very negative</span><span>Neutral</span><span>Very positive</span></div>
      {notice && <p role="alert">{notice}</p>}
    </footer>
  </div>
}

function TaskFrame({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  return <div className="rating-task"><main className={wide ? 'rating-form wide' : 'rating-form'}>{children}</main></div>
}
