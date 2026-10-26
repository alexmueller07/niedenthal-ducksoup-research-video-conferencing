import { useEffect, useState } from 'react'
import { Play, Pause, Square, ClipboardList } from 'lucide-react'
import { buildSegments } from '../../main/review'
import { DEFAULT_REVIEW_CONFIG } from '../lib/protocol'
import type { Phase, PSlot, ReviewAvailability, ReviewConfig, ReviewControlAction, ReviewMedia, ReviewState } from '../lib/protocol'
import { readReviewDefaults, saveReviewDefaults } from '../lib/suitePreferences'

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
  const [config, setConfig] = useState<ReviewConfig>({ ...DEFAULT_REVIEW_CONFIG, task: 'continuous', segmentSec: 150, minTailSec: 0, mediaPolicy: 'self-clean-partner-altered' })
  useEffect(() => { void readReviewDefaults().then(c => {
    setConfig({ ...c, task: 'continuous', segmentSec: 150, minTailSec: 0, allowPause: false, advance: 'both-done', mediaPolicy: 'self-clean-partner-altered' })
  }) }, [])
  const running = props.phase === 'review' && props.state
  const update = (patch: Partial<ReviewConfig>) => setConfig(c => ({ ...c, ...patch }))
  const field = 'rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200'
  return <section id="rating-task" className="rounded-lg border border-gray-700 bg-gray-900/40 p-5">
    <h2 className="mb-4 flex items-center gap-2 text-base font-semibold"><ClipboardList size={19} />Rating Station</h2>
    {props.error && <p role="alert" className="mb-3 text-red-300">{props.error}</p>}
    {running ? <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><strong>{props.state?.status === 'questionnaire' ? 'Post-conversation questions' : props.state?.status === 'done' ? 'Ratings complete' : `Part ${(props.state?.current ?? 0) + 1} of ${props.state?.segments.length}`}</strong><span className="text-sm text-sky-300">{props.state?.status}</span></div>
      <div className="mb-4 grid grid-cols-2 gap-4">{(['P1','P2'] as const).map(slot => <div key={slot} className="border-l-2 border-sky-700 pl-3"><strong>{props.names[slot]}</strong><p className="text-sm text-gray-400">{!props.state?.connected[slot] ? 'Disconnected' : props.state.done[slot] ? 'Saved' : props.state.status === 'questionnaire' || props.state.status === 'writing' ? 'Answering' : props.state.ready[slot] ? 'Ready' : 'Preparing'}</p></div>)}</div>
      <div className="flex flex-wrap gap-3">
        {props.state?.status === 'playing' && <button className={field} onClick={() => props.onControl('pause')}><Pause size={16} className="inline mr-2" />Technical pause</button>}
        {props.state?.status === 'paused' && <button className={field} onClick={() => props.onControl('resume')}><Play size={16} className="inline mr-2" />Resume</button>}
        <button className={field} onClick={() => { if (props.state?.status === 'done' || window.confirm('End this rating task early? Saved answers remain, and the task will be marked incomplete.')) props.onEnd() }}><Square size={16} className="inline mr-2" />{props.state?.status === 'done' ? 'Close ratings' : 'End ratings'}</button>
      </div>
    </> : <>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-2 text-xs text-gray-400">Video perspective<select className={field} value={config.viewMode} onChange={e => update({ viewMode: e.target.value as ReviewConfig['viewMode'] })}><option value="active">Person being rated</option><option value="single">Conversation partner</option><option value="gallery">Gallery</option></select></label>
        <label className="flex flex-col gap-2 text-xs text-gray-400">First person rated<select className={field} value={config.firstSeat} onChange={e => update({ firstSeat: e.target.value as PSlot })}><option value="P1">P1</option><option value="P2">P2</option></select></label>
      </div>
      <p className="mt-4 text-sm text-gray-400">Each person sees their own clean recording and their partner's altered recording.</p>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-gray-400">{props.availability?.canStart ? `${buildSegments(props.availability.conversationMs, config).length} parts · 2:30 each · questions first` : props.availability?.reason || 'End the conversation to begin ratings.'}</p><button className="rounded-md bg-sky-600 px-4 py-2 font-semibold disabled:opacity-40" disabled={!props.availability?.canStart} onClick={() => { void saveReviewDefaults(config); props.onStart(config) }}><Play size={16} className="inline mr-2" />Start ratings</button></div>
      {props.availability?.warning && <p className="mt-3 text-sm text-amber-300">{props.availability.warning}</p>}
    </>}
  </section>
}
