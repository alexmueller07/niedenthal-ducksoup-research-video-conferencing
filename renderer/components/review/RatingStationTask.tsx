import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ClipboardList, Download, Headphones, Loader2, Play } from 'lucide-react'
import { POST_CONVERSATION_ITEMS, RATING_INSTRUCTIONS, RATING_TASK_VERSION } from '../../../main/ratingTask'
import { ipcInvoke } from '../../lib/ipcUtil'
import { RATING_BLOCK_COUNT as BLOCKS, RATING_BLOCK_SECONDS as BLOCK_SECONDS } from '../../lib/ratingStation'
import { prepareRatingPlayback } from '../../lib/ratingPlayback'

export type RatingStationRun = {
  runId: string; dyad: string; candidateId: string; participantId: string; partnerId: string; seat: 'P1' | 'P2'
  round: number; group: 'A' | 'B' | 'C'; selfColor: string; partnerColor: string
  initials: string; researcher: string; date: string; time: string; native: boolean
  recordings: { seat: 'P1' | 'P2'; kind: 'clean' | 'altered'; url: string }[]
}
type Sample = { block: number; videoMs: number; value: number; touched: boolean }
type Reflection = { block: number; target: 'self' | 'partner'; text: string; elicitation: number | null }
type Stage = 'questionnaire' | 'instructions' | 'ready' | 'playing' | 'reflection' | 'done'

export function RatingStationTask({ run, onExit }: { run: RatingStationRun; onExit: () => void }) {
  const [stage, setStage] = useState<Stage>('questionnaire')
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const [instruction, setInstruction] = useState(0)
  const [block, setBlock] = useState(0)
  const [value, setValue] = useState(50)
  const [text, setText] = useState('')
  const [elicitation, setElicitation] = useState<number | null>(null)
  const [saveError, setSaveError] = useState('')
  const [hold, setHold] = useState('')
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
  const [skip, setSkip] = useState<'questionnaire' | 'reflection' | null>(null)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const pendingSaves = useRef(0)
  const transition = useRef(false)
  const startingRef = useRef(false)
  const holdRef = useRef('')
  const resumeAt = useRef(0)
  const samples = useRef<Sample[]>([])
  const reflections = useRef<Reflection[]>([])
  const interruptions = useRef<{ block: number; videoMs: number; reason: string }[]>([])
  const rating = useRef({ value: 50, touched: false })
  const lastSample = useRef(-1)
  const own = useRef<HTMLVideoElement>(null)
  const partner = useRef<HTMLVideoElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const skipDialog = useRef<HTMLDialogElement>(null)
  const stageRef = useRef(stage)
  const canLeave = useRef(false)
  stageRef.current = stage
  canLeave.current = stage === 'done' && saved && (run.native || downloaded)
  const ownVideo = run.recordings.find(r => r.seat === run.seat && r.kind === 'clean')
  const partnerVideo = run.recordings.find(r => r.seat !== run.seat && r.kind === 'altered')
  const target = block % 2 === 0 ? 'self' : 'partner'

  function moveTo(next: Stage) { stageRef.current = next; setStage(next) }
  function setPlaybackHold(reason: string) { holdRef.current = reason; setHold(reason) }
  function pauseFor(reason: string) {
    if (stageRef.current !== 'playing' || startingRef.current || holdRef.current) return
    resumeAt.current = Math.min((block + 1) * BLOCK_SECONDS, own.current?.currentTime ?? resumeAt.current)
    setPlaybackHold(reason)
    own.current?.pause(); partner.current?.pause()
    interruptions.current.push({ block: block + 1, videoMs: Math.round(resumeAt.current * 1000), reason })
  }

  function result() {
    return {
      taskVersion: RATING_TASK_VERSION, runId: run.runId,
      setup: { dyad: run.dyad, recording: run.candidateId, participantId: run.participantId, partnerId: run.partnerId, seat: run.seat, round: run.round, group: run.group, selfColor: run.selfColor, partnerColor: run.partnerColor, initials: run.initials, researcher: run.researcher, date: run.date, time: run.time },
      questionnaire: Object.fromEntries(POST_CONVERSATION_ITEMS.map(([id]) => [id, answers[id] ?? null])),
      samples: samples.current.map(sample => ({ ...sample })), reflections: reflections.current.map(item => ({ ...item })),
      interruptions: interruptions.current.map(item => ({ ...item })),
      status: stageRef.current, completedBlocks: reflections.current.length, updatedAt: new Date().toISOString(),
    }
  }

  async function saveNow() {
    const snapshot = result()
    ++pendingSaves.current
    setSaving(true); setSaved(false)
    const next = saveQueue.current.catch(() => {}).then(async () => {
      if (run.native) {
        const file = await ipcInvoke('rating:save', { dyad: run.dyad, sessionId: run.candidateId, participantId: run.participantId, runId: run.runId, content: snapshot })
        if (!file) throw new Error('The save service is unavailable.')
      } else sessionStorage.setItem(`rating-station:${run.runId}`, JSON.stringify(snapshot))
    })
    saveQueue.current = next
    try {
      await next
      setSaveError('')
      if (snapshot.status === 'done') setSaved(true)
      return true
    } catch {
      setSaveError('Responses could not be saved. Check the storage location, then try again. Your current responses are still here.')
      pauseFor('Playback paused while responses could not be saved.')
      return false
    } finally {
      --pendingSaves.current
      setSaving(pendingSaves.current > 0)
    }
  }

  const latest = useRef({ pauseFor, saveNow })
  latest.current = { pauseFor, saveNow }
  useEffect(() => {
    const hidden = () => { if (document.hidden) latest.current.pauseFor('Playback paused when this window was hidden.') }
    const guard = (event: BeforeUnloadEvent) => {
      if (!canLeave.current) { event.preventDefault(); event.returnValue = '' }
    }
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('beforeunload', guard)
    const videos = [own.current, partner.current]
    const navigation = [...document.querySelectorAll<HTMLElement>('.suite-sidebar, .suite-topbar')].map(element => ({ element, inert: element.inert }))
    navigation.forEach(({ element }) => { element.inert = true })
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', guard)
      videos.forEach(video => video?.pause())
      navigation.forEach(({ element, inert }) => { element.inert = inert })
    }
  }, [])

  useEffect(() => {
    container.current?.scrollTo({ top: 0 })
    container.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true })
  }, [stage, instruction, block])

  useEffect(() => { if (skip && !skipDialog.current?.open) skipDialog.current?.showModal() }, [skip])

  useEffect(() => {
    if (stage !== 'playing') return
    const timer = setInterval(() => {
      const video = own.current
      const other = partner.current
      if (!video || !other || holdRef.current || startingRef.current || document.hidden) return
      if (video.paused || other.paused || video.seeking || other.seeking || video.readyState < 3 || other.readyState < 3) {
        latest.current.pauseFor('The recording paused while loading.')
        return
      }
      if (Math.abs(video.currentTime - other.currentTime) > .25) {
        latest.current.pauseFor('The two videos need a moment to synchronize.')
        return
      }
      const videoMs = Math.round(video.currentTime * 1000)
      if (videoMs <= lastSample.current + 75 || videoMs >= (block + 1) * BLOCK_SECONDS * 1000) return
      samples.current.push({ block: block + 1, videoMs, ...rating.current })
      lastSample.current = videoMs
    }, 100)
    const save = setInterval(() => {
      if (!holdRef.current && !startingRef.current && !pendingSaves.current) void latest.current.saveNow()
    }, 2000)
    return () => { clearInterval(timer); clearInterval(save) }
  }, [stage, block])

  async function questionnaireNext(allowMissing = false) {
    if (transition.current) return
    if (!allowMissing && POST_CONVERSATION_ITEMS.some(([id]) => answers[id] === undefined)) { setSkip('questionnaire'); return }
    setSkip(null); transition.current = true
    if (await saveNow()) moveTo('instructions')
    transition.current = false
  }

  async function playFrom(seconds: number) {
    if (!own.current || !partner.current || startingRef.current) return
    startingRef.current = true; setStarting(true)
    resumeAt.current = seconds
    try {
      await Promise.all([prepareRatingPlayback(own.current, seconds), prepareRatingPlayback(partner.current, seconds)])
      if (document.hidden) throw new Error('Return to this window to continue playback.')
      await Promise.all([own.current.play(), partner.current.play()])
      if (document.hidden) throw new Error('Return to this window to continue playback.')
      setPlaybackHold('')
    } catch (e) {
      own.current.pause(); partner.current.pause()
      resumeAt.current = Math.max(seconds, own.current.currentTime)
      setPlaybackHold(e instanceof Error ? e.message : 'Playback could not start. Check audio permissions, then continue.')
    } finally { startingRef.current = false; setStarting(false) }
  }

  async function beginBlock() {
    if (stageRef.current !== 'ready' || startingRef.current) return
    rating.current = { value: 50, touched: false }; setValue(50)
    lastSample.current = block * BLOCK_SECONDS * 1000 - 100
    moveTo('playing')
    await playFrom(block * BLOCK_SECONDS)
  }

  async function resumePlayback() {
    if (transition.current || startingRef.current) return
    transition.current = true
    if (!saveError || await saveNow()) {
      if (resumeAt.current >= (block + 1) * BLOCK_SECONDS) await endBlock()
      else await playFrom(resumeAt.current)
    }
    transition.current = false
  }

  async function endBlock() {
    if (stageRef.current !== 'playing' || startingRef.current) return
    moveTo('reflection')
    own.current?.pause(); partner.current?.pause()
    setPlaybackHold('')
    await saveNow()
  }

  async function reflectionNext(allowMissing = false) {
    if (transition.current) return
    if (!allowMissing && (!text.trim() || elicitation === null)) { setSkip('reflection'); return }
    setSkip(null); transition.current = true
    const isLast = block + 1 >= BLOCKS
    reflections.current.push({ block: block + 1, target, text: text.trim(), elicitation })
    // Persist the final status and responses together before showing completion.
    stageRef.current = isLast ? 'done' : 'ready'
    if (await saveNow()) {
      setText(''); setElicitation(null)
      if (isLast) moveTo('done')
      else { setBlock(block + 1); moveTo('ready') }
    } else { reflections.current.pop(); stageRef.current = 'reflection' }
    transition.current = false
  }

  function exportBrowser() {
    const blob = new Blob([JSON.stringify(result(), null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `ratings-${run.dyad}-${run.participantId}-${run.runId}.json`
    a.click(); setDownloaded(true)
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  return <div className="rating-station-task" ref={container}>
    <header className="rating-task-header"><span>Session View <span>/ Conversation review</span></span><span>{stage === 'questionnaire' ? 'Your conversation' : stage === 'instructions' ? 'Before you begin' : stage === 'done' ? 'Complete' : `Part ${block + 1} of ${BLOCKS}`}</span></header>
    <div className="rating-task-content">
      {saveError && <p className="rating-warning" role="alert">{saveError}</p>}
      <div className="rating-task-media" aria-hidden={stage !== 'playing'}>
        {[{ ref: own, video: ownVideo, name: 'You' }, { ref: partner, video: partnerVideo, name: 'Your partner' }].map(({ ref, video, name }) => <figure key={name}>
          <video ref={ref} playsInline preload="metadata" disablePictureInPicture disableRemotePlayback src={video?.url}
            onContextMenu={e => e.preventDefault()}
            onWaiting={() => pauseFor('The recording paused while loading.')}
            onError={() => pauseFor('The recording cannot be read. Ask the researcher to check the video file.')}
            onEnded={() => { if ((own.current?.currentTime || 0) >= (block + 1) * BLOCK_SECONDS - .05) void endBlock(); else pauseFor('A recording ended earlier than expected. Ask the researcher for help.') }}
            onTimeUpdate={() => { if (ref === own && (own.current?.currentTime || 0) >= (block + 1) * BLOCK_SECONDS) void endBlock() }} />
          <figcaption>{name}</figcaption>
        </figure>)}
      </div>
      {stage === 'questionnaire' && <div className="rating-task-form"><div className="rating-form-heading"><ClipboardList size={24} /><div><h1 tabIndex={-1}>Your conversation</h1><p>{Object.keys(answers).length} of {POST_CONVERSATION_ITEMS.length} answered</p></div></div>
        {POST_CONVERSATION_ITEMS.map(([id, question], index) => <fieldset key={id} className="rating-question"><legend><span>{String(index + 1).padStart(2, '0')}</span> {question}</legend><div className="rating-scale-labels"><span>{id === 'relative_talking' ? 'My partner talked much more' : 'Not at all'}</span><span>{id === 'relative_talking' ? 'I talked much more' : 'Very much'}</span></div><div className="rating-numbers">{Array.from({ length: 11 }, (_, i) => i + (id === 'relative_talking' ? -5 : 0)).map(n => <button key={n} aria-pressed={answers[id] === n} className={answers[id] === n ? 'selected' : ''} onClick={() => setAnswers(a => ({ ...a, [id]: n }))}>{n}</button>)}</div></fieldset>)}
        <div className="rating-task-actions"><button className="rating-primary" disabled={saving} onClick={() => void questionnaireNext()}>{saving ? 'Saving...' : 'Continue'} <ArrowRight size={17} /></button></div>
      </div>}
      {stage === 'instructions' && <div className="rating-task-form centered"><Headphones size={28} /><span className="rating-eyebrow">Before you begin · {instruction + 1} of {RATING_INSTRUCTIONS.length}</span><h1 tabIndex={-1}>{RATING_INSTRUCTIONS[instruction]}</h1><div className="rating-step-dots" aria-hidden="true">{RATING_INSTRUCTIONS.map((_, i) => <span key={i} className={i <= instruction ? 'complete' : ''} />)}</div><button className="rating-primary" onClick={() => { if (instruction + 1 < RATING_INSTRUCTIONS.length) setInstruction(instruction + 1); else moveTo('ready') }}>Continue <ArrowRight size={17} /></button></div>}
      {stage === 'ready' && <div className="rating-task-form centered"><span className="rating-eyebrow">Part {block + 1} of {BLOCKS} · 2 minutes 30 seconds</span><h1 tabIndex={-1}>Focus on {target === 'self' ? 'your own' : "your partner's"} feelings.</h1><p>The recording will play once. Move the slider continuously as you watch.</p><button className="rating-primary" onClick={() => void beginBlock()}><Play size={17} /> Begin part</button></div>}
      {stage === 'playing' && <div className="rating-task-controls">
        <div className="rating-task-banner">Part {block + 1} of {BLOCKS} · {target === 'self' ? 'YOUR OWN FEELINGS' : "YOUR PARTNER'S FEELINGS"}</div>
        {(hold || starting) && <div className="rating-playback-hold" role="status"><div><strong>{starting ? 'Preparing playback' : 'Playback paused'}</strong><p>{starting ? 'Getting both videos ready.' : hold}</p></div>{starting ? <Loader2 size={20} className="rating-spin" /> : <button className="rating-primary" disabled={saving} onClick={() => void resumePlayback()}><Play size={16} /> Continue playback</button>}</div>}
        <h2>How positive or negative did {target === 'self' ? 'you' : 'your partner'} feel?</h2><input type="range" min="0" max="100" disabled={Boolean(hold) || starting} value={value} onChange={e => { const next = Number(e.target.value); setValue(next); rating.current = { value: next, touched: true } }} aria-label="Feelings from very negative to very positive" /><div className="rating-scale-labels"><span>Very negative</span><span>Neutral</span><span>Very positive</span></div>
      </div>}
      {stage === 'reflection' && <div className="rating-task-form centered"><span className="rating-eyebrow">Part {block + 1} of {BLOCKS} · Reflection</span><h1 tabIndex={-1}>How {target === 'self' ? 'were you' : 'was your partner'} feeling during the part you just watched?</h1><textarea value={text} onChange={e => setText(e.target.value)} aria-label="Describe feelings" maxLength={20000} /><p>How much did {target === 'self' ? 'your partner' : 'you'} contribute to those feelings?</p><div className="rating-scale-labels"><span>Not at all</span><span>Very much</span></div><div className="rating-numbers">{Array.from({ length: 9 }, (_, i) => i + 1).map(n => <button key={n} className={elicitation === n ? 'selected' : ''} aria-pressed={elicitation === n} onClick={() => setElicitation(n)}>{n}</button>)}</div><button className="rating-primary" disabled={saving} onClick={() => void reflectionNext()}>{saving ? 'Saving...' : 'Continue'} <ArrowRight size={17} /></button></div>}
      {stage === 'done' && <div className="rating-task-form centered"><Check size={34} className="rating-ready-text" /><h1 tabIndex={-1}>You have finished. Thank you.</h1><p>{run.native ? 'Your responses are saved.' : 'Please let the researcher download your responses before leaving this station.'}</p>{!run.native && <button className="rating-primary" onClick={exportBrowser}><Download size={17} /> {downloaded ? 'Download again' : 'Download responses'}</button>}<button className="suite-btn" disabled={!saved || (!run.native && !downloaded)} onClick={onExit}>Return to station setup</button></div>}
    </div>
    {skip && <dialog ref={skipDialog} className="rating-dialog" aria-labelledby="rating-missing-title" onCancel={() => setSkip(null)}><h2 id="rating-missing-title">Leave unanswered items blank?</h2><p>{skip === 'questionnaire' ? `${POST_CONVERSATION_ITEMS.filter(([id]) => answers[id] === undefined).length} questions have no response.` : 'Your reflection or rating is incomplete.'} You cannot return to this page after continuing.</p><div><button className="suite-btn" autoFocus onClick={() => setSkip(null)}>Keep answering</button><button className="rating-primary" onClick={() => void (skip === 'questionnaire' ? questionnaireNext(true) : reflectionNext(true))}>Continue with blanks <ArrowRight size={16} /></button></div></dialog>}
  </div>
}
