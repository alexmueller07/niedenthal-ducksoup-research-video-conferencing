import { useEffect, useRef, useState } from 'react'
import { POST_CONVERSATION_ITEMS, RATING_INSTRUCTIONS, RATING_TASK_VERSION } from '../../../main/ratingTask'
import { ipcInvoke } from '../../lib/ipcUtil'
import { RATING_BLOCK_SECONDS as BLOCK_SECONDS, startingTarget } from '../../lib/ratingStation'
import { prepareRatingPlayback } from '../../lib/ratingPlayback'
import PostConversation from '../rating/PostConversation'
import Instructions from '../rating/Instructions'
import TransitionScreen from '../rating/TransitionScreen'
import RatingOverlay from '../rating/RatingOverlay'
import Slider from '../rating/Slider'
import { useAdvance } from '../rating/useAdvance'

// The participant's rating task. Every screen here is the lab suite's own
// (src/station/dyad-task and components, copied into components/rating/), in the
// same order: the post-conversation questions, the instruction screens, then for
// each part an announcement of whose feelings come next, the video with the
// slider along the bottom, and the writing + 1-9 screen. What differs from the
// suite is where the video comes from (two recordings from a Session View call,
// the participant's own and their partner's, played together) and where the
// answers are saved (the session folder, through the rating:save IPC).

export type RatingStationRun = {
  runId: string; dyad: string; candidateId: string; participantId: string; partnerId: string; seat: 'P1' | 'P2'
  round: number; group: 'A' | 'B' | 'C'; selfColor: string; partnerColor: string
  initials: string; researcher: string; date: string; time: string; native: boolean
  recordings: { seat: 'P1' | 'P2'; kind: 'clean' | 'altered'; url: string }[]
  /** What the researcher chose to present. */
  audioOnly: boolean
  ownVersion: 'clean' | 'altered'
  partnerVersion: 'clean' | 'altered'
  /** Which of the 2:30 parts to run, 0-based and in order. */
  blocks: number[]
}
type Sample = { block: number; videoMs: number; value: number; touched: boolean }
type Reflection = { block: number; target: 'self' | 'partner'; text: string; elicitation: number | null }
type Stage = 'questionnaire' | 'instructions' | 'transition' | 'playing' | 'reflection' | 'done'

export function RatingStationTask({ run, onExit }: { run: RatingStationRun; onExit: () => void }) {
  const [stage, setStage] = useState<Stage>('questionnaire')
  const [answers, setAnswers] = useState<Record<string, number>>({})
  const [instruction, setInstruction] = useState(0)
  const [block, setBlock] = useState(run.blocks[0] ?? 0)
  const [resetTrigger, setResetTrigger] = useState(0)
  const [text, setText] = useState('')
  const [elicitation, setElicitation] = useState<number | undefined>(undefined)
  const [attempted, setAttempted] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [hold, setHold] = useState('')
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [saved, setSaved] = useState(false)
  const [downloaded, setDownloaded] = useState(false)
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
  const resetCall = useRef(true)
  const lastSample = useRef(-1)
  const own = useRef<HTMLVideoElement>(null)
  const partner = useRef<HTMLVideoElement>(null)
  const stageRef = useRef(stage)
  const canLeave = useRef(false)
  stageRef.current = stage
  canLeave.current = stage === 'done' && saved && (run.native || downloaded)
  const ownVideo = run.recordings.find(r => r.seat === run.seat)
  const partnerVideo = run.recordings.find(r => r.seat !== run.seat)
  const start = startingTarget(run.participantId, run.seat)
  // The perspective alternates with the real part number, so a part keeps its
  // perspective whichever parts the researcher chose to run.
  const target: 'self' | 'partner' = (start.target === 'self') === (block % 2 === 0) ? 'self' : 'partner'

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
      setup: { dyad: run.dyad, recording: run.candidateId, participantId: run.participantId, partnerId: run.partnerId, seat: run.seat, round: run.round, group: run.group, audioOnly: run.audioOnly, ownVersion: run.ownVersion, partnerVersion: run.partnerVersion, blocks: run.blocks.map(b => b + 1), startingPerspective: start.target, startingPerspectiveBasis: start.basis, selfColor: run.selfColor, partnerColor: run.partnerColor, initials: run.initials, researcher: run.researcher, date: run.date, time: run.time },
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
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('beforeunload', guard)
      videos.forEach(video => video?.pause())
    }
  }, [])

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

  async function questionnaireNext() {
    if (transition.current) return
    transition.current = true
    if (await saveNow()) moveTo('instructions')
    transition.current = false
  }

  function advanceInstructions() {
    if (instruction + 1 >= RATING_INSTRUCTIONS.length) moveTo('transition')
    else setInstruction(i => i + 1)
  }
  useAdvance(advanceInstructions, stage === 'instructions')

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

  // The announcement's Continue starts the part.
  async function beginBlock() {
    if (stageRef.current !== 'transition' || startingRef.current) return
    rating.current = { value: 50, touched: false }
    resetCall.current = true
    setResetTrigger(t => t + 1)
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
    setAttempted(false)
    moveTo('reflection')
    own.current?.pause(); partner.current?.pause()
    setPlaybackHold('')
    await saveNow()
  }

  // Same rule as the suite: a rating alone lets the participant through; with
  // no rating the dialog lists what is missing, and "Continue anyway" saves blanks.
  async function reflectionNext(allowMissing = false) {
    if (transition.current || stageRef.current !== 'reflection') return
    if (!allowMissing && elicitation === undefined) { setAttempted(true); return }
    setAttempted(false); transition.current = true
    const nextBlock = run.blocks[run.blocks.indexOf(block) + 1]
    const isLast = nextBlock === undefined
    reflections.current.push({ block: block + 1, target, text: text.trim(), elicitation: elicitation ?? null })
    // Persist the final status and responses together before showing completion.
    stageRef.current = isLast ? 'done' : 'transition'
    if (await saveNow()) {
      setText(''); setElicitation(undefined)
      if (isLast) moveTo('done')
      else { setBlock(nextBlock); moveTo('transition') }
    } else { reflections.current.pop(); stageRef.current = 'reflection' }
    transition.current = false
  }
  const reflectionNextRef = useRef(reflectionNext)
  reflectionNextRef.current = reflectionNext
  useEffect(() => {
    if (stage !== 'reflection') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      event.preventDefault()
      void reflectionNextRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage])

  function exportBrowser() {
    const blob = new Blob([JSON.stringify(result(), null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `ratings-${run.dyad}-${run.participantId}-${run.runId}.json`
    a.click(); setDownloaded(true)
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const playing = stage === 'playing'
  const videoProps = {
    playsInline: true, preload: 'metadata' as const, disablePictureInPicture: true, disableRemotePlayback: true,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onWaiting: () => pauseFor('The recording paused while loading.'),
    onError: () => pauseFor('The recording cannot be read. Ask the researcher to check the video file.'),
  }
  const questionPerson = target === 'self' ? 'YOU' : 'YOUR PARTNER'

  return <div id="rating-root">
    {saveError && <div role="alert" className="fixed top-0 left-0 right-0 z-[300] bg-red-700 border-b-2 border-red-400 px-6 py-3 text-center"><p className="text-white font-bold text-lg">{saveError}</p></div>}

    {stage === 'questionnaire' && <PostConversation responses={answers} onChange={(key, value) => setAnswers(a => ({ ...a, [key]: value }))} onContinue={() => void questionnaireNext()} />}

    {stage === 'instructions' && <div className="h-screen w-screen"><Instructions instructionIndex={instruction} onBack={() => setInstruction(i => Math.max(0, i - 1))} onContinue={advanceInstructions} groupSize={RATING_INSTRUCTIONS.length} instructions={RATING_INSTRUCTIONS} /></div>}

    {stage === 'transition' && <div className="relative h-screen w-screen"><TransitionScreen ratingTarget={target} onContinue={() => void beginBlock()} /></div>}

    {stage === 'reflection' && <div className="h-screen w-screen"><RatingOverlay
      currentRatingTarget={target} textInput={text} setTextInput={setText} numberScale={elicitation} setNumberScale={setElicitation}
      attemptedSubmit={attempted} isFinal={block === 3}
      onSubmit={() => void reflectionNext()} onConfirmIncomplete={() => void reflectionNext(true)} onDismissIncomplete={() => setAttempted(false)} /></div>}

    {stage === 'done' && <div className="h-screen w-screen flex flex-col items-center justify-center bg-black text-center px-8">
      <h1 className="text-white text-3xl mb-6">You have finished. Thank you.</h1>
      <p className="text-gray-400 text-xl mb-10">{run.native ? 'Your responses are saved.' : 'Please let the researcher download your responses before leaving this station.'}</p>
      {!run.native && <button type="button" onClick={exportBrowser} className="mb-4 px-8 py-3 rounded-lg font-semibold bg-white text-black hover:bg-gray-200">{downloaded ? 'Download again' : 'Download responses'}</button>}
      <button type="button" disabled={!saved || (!run.native && !downloaded)} onClick={onExit} className="px-6 py-2 border border-gray-500 text-gray-300 rounded-lg enabled:hover:bg-gray-700 enabled:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed">Return to station setup</button>
    </div>}

    {/* The video screen stays mounted (hidden between parts) so both recordings keep their place. */}
    <div className={playing ? `h-screen w-screen overflow-hidden bg-black relative ${hold || starting ? 'cursor-auto' : 'cursor-none'}` : 'hidden'}>
      {playing && <div className="absolute top-6 right-8 z-20 border-2 border-white bg-black px-5 py-2.5 text-center">
        <span className="block text-gray-400 text-xs uppercase tracking-widest">You are rating</span>
        <span className="block text-white text-xl font-bold">{target === 'self' ? 'YOUR OWN FEELINGS' : "YOUR PARTNER'S FEELINGS"}</span>
      </div>}
      <div className="h-full w-full flex flex-col relative">
        <div className="flex-1 flex flex-col items-center justify-center bg-black">
          <p className="text-center text-white mt-20 mb-7 text-2xl">How positive or negative did <span className="font-bold underline">{questionPerson}</span> feel during this moment in the conversation?</p>
          <div className="flex flex-col items-center w-full h-full pt-8">
            {run.audioOnly && <p className="text-gray-400 text-xl mb-4">Audio only</p>}
            <div className={`flex w-5/6 max-h-full gap-4 items-start justify-center ${run.audioOnly ? 'invisible h-0' : ''}`}>
              <video ref={own} src={ownVideo?.url} className="w-1/2 max-h-full object-contain"
                {...videoProps}
                onEnded={() => { if ((own.current?.currentTime || 0) >= (block + 1) * BLOCK_SECONDS - .05) void endBlock(); else pauseFor('A recording ended earlier than expected. Ask the researcher for help.') }}
                onTimeUpdate={() => { if ((own.current?.currentTime || 0) >= (block + 1) * BLOCK_SECONDS) void endBlock() }} />
              <video ref={partner} src={partnerVideo?.url} className="w-1/2 max-h-full object-contain" {...videoProps} />
            </div>
          </div>
        </div>
        <div className="absolute bottom-0 left-0 w-full cursor-none border-t border-white bg-black px-10 pt-6 pb-8">
          <Slider resetTrigger={resetTrigger} onSample={(value) => {
            // The slider reports a reset to the middle when a part begins; that is not a rating.
            if (resetCall.current) { resetCall.current = false; rating.current = { value, touched: false }; return }
            rating.current = { value, touched: true }
          }} />
        </div>
        {playing && (hold || starting) && <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/85">
          <div role="status" className="max-w-xl border border-white bg-black p-8 text-center">
            <p className="text-white text-2xl mb-6">{starting ? 'Getting the video ready…' : hold}</p>
            {!starting && <button type="button" disabled={saving} onClick={() => void resumePlayback()} className="px-8 py-3 rounded-lg font-semibold bg-white text-black hover:bg-gray-200 disabled:opacity-40">Continue</button>}
          </div>
        </div>}
      </div>
    </div>
  </div>
}
