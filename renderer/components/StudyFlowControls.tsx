import { useState } from 'react'
import { Check, ClipboardList, Play, Square, ArrowRight, Shuffle } from 'lucide-react'
import { STUDY_FACE_PRESETS, STUDY_BLOCK_MS, STUDY_MANUAL } from '../../main/studyFlow'
import type { Phase, PSlot, StudyAssignment, StudyFlowState, StudyValence } from '../lib/protocol'

const mmss = (ms: number) => `${Math.floor(Math.max(0, ms) / 60000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, '0')}`

export function StudyFlowControls({ state, phase, connected, now, error, onArm, onDisarm, onStart, onNext }: {
  state: StudyFlowState | null
  phase: Phase
  connected: Record<PSlot, boolean>
  now: number
  error: string
  onArm: (assignment: StudyAssignment, blockSec: number) => void
  onDisarm: () => void
  onStart: () => void
  onNext: (force: boolean) => void
}) {
  const [presetId, setPresetId] = useState('')
  const [firstValence, setFirstValence] = useState<StudyValence>('positive')
  const [manipulatedBlock, setManipulatedBlock] = useState<1 | 2>(1)
  const [blockMin, setBlockMin] = useState(String(STUDY_BLOCK_MS / 60000))
  const status = state?.status ?? 'idle'
  const field = 'rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200'
  const both = connected.P1 && connected.P2
  const step = state && state.step >= 0 ? state.steps[state.step] : null
  const nextStep = state && status === 'running' ? state.steps[state.step + 1] : null
  const elapsed = state?.stepStartedAtMs ? now - state.stepStartedAtMs : 0
  const ratingPending = step?.kind === 'rating' && !(state?.submitted.P1 && state?.submitted.P2)
  const minutes = Number(blockMin)
  const lengthOk = Number.isFinite(minutes) && minutes >= 1 / 6 && minutes <= 60
  const summary = state?.assignment
    ? `Topic first: ${state.assignment.firstValence}. Face change: block ${state.assignment.manipulatedBlock} (${state.assignment.presetId === STUDY_MANUAL ? 'Manual' : STUDY_FACE_PRESETS.find(p => p.id === state.assignment?.presetId)?.label}).`
    : ''
  return <section className="rounded-lg border border-gray-700 bg-gray-900/40 p-5" aria-label="Study flow">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold"><ClipboardList size={18} />Study flow</h2>
      <span className="text-sm text-gray-400">{status === 'idle' ? 'Not set up' : status === 'armed' ? 'Ready' : status === 'running' ? `Step ${state!.step + 1} of ${state!.steps.length}` : 'Complete'}</span>
    </div>
    {state && state.steps.length > 0 && <ol className="mb-4 grid gap-1 text-sm">{state.steps.map((s, i) => {
      const current = status === 'running' && i === state.step
      const done = status === 'complete' || (status === 'running' && i < state.step)
      return <li key={i} className={`flex items-center justify-between rounded px-3 py-1.5 ${current ? 'bg-sky-600/25 text-white ring-1 ring-sky-500' : done ? 'text-gray-500' : 'text-gray-300'}`}>
        <span className="flex items-center gap-2">{done ? <Check size={14} /> : <span className="inline-block w-3.5 text-center text-xs text-gray-500">{i + 1}</span>}{s.label}{s.kind === 'conversation' && <span className="text-xs text-gray-500">· {s.valence}{state.assignment?.manipulatedBlock === s.block ? ' · face change' : ''}</span>}</span>
        {current && s.kind === 'conversation' && <span className={state.timeUp ? 'font-semibold text-amber-300' : 'text-gray-300'}>{mmss(elapsed)} / {mmss(state.blockMs)}{state.timeUp ? ' · time is up' : ''}</span>}
        {current && s.kind === 'rating' && <span className="text-gray-300">P1 {state.submitted.P1 ? 'done' : 'waiting'} · P2 {state.submitted.P2 ? 'done' : 'waiting'}</span>}
      </li>
    })}</ol>}
    {error && <p role="alert" className="mb-3 text-sm text-red-300">{error}</p>}
    {summary && <p className="mb-3 text-xs text-gray-400">{summary}</p>}

    {status === 'idle' && phase === 'waiting' && <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-2 text-xs text-gray-400">Topic first<select className={field} value={firstValence} onChange={e => setFirstValence(e.target.value as StudyValence)}><option value="positive">Positive</option><option value="negative">Negative</option></select></label>
      <label className="flex flex-col gap-2 text-xs text-gray-400">Face change in<select className={field} value={manipulatedBlock} onChange={e => setManipulatedBlock(Number(e.target.value) as 1 | 2)}><option value={1}>Block 1</option><option value={2}>Block 2</option></select></label>
      <label className="flex min-w-40 flex-col gap-2 text-xs text-gray-400">Face condition<select className={field} value={presetId} onChange={e => setPresetId(e.target.value)}><option value="">Select preset</option><option value={STUDY_MANUAL}>Manual</option>{STUDY_FACE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="flex w-24 flex-col gap-2 text-xs text-gray-400">Block (min)<input className={field} value={blockMin} onChange={e => setBlockMin(e.target.value)} inputMode="decimal" /></label>
      <button className={field} title="Pick the topic order and the face-change block at random" onClick={() => { setFirstValence(Math.random() < 0.5 ? 'positive' : 'negative'); setManipulatedBlock(Math.random() < 0.5 ? 1 : 2) }}><Shuffle size={14} className="mr-2 inline" />Randomize</button>
      <button className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={!presetId || !lengthOk} onClick={() => onArm({ firstValence, manipulatedBlock, presetId }, Math.round(minutes * 60))}><Play size={15} className="mr-2 inline" />Confirm setup</button>
    </div>}
    {status === 'idle' && phase !== 'waiting' && <p className="text-sm text-gray-400">Return to the waiting room to set up the study flow.</p>}

    {status === 'armed' && <div className="flex items-center justify-between gap-3">
      <button className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={!both || phase !== 'waiting'} onClick={onStart}><Play size={15} className="mr-2 inline" />Start: show first screen</button>
      <button className={field} onClick={onDisarm}>Change setup</button>
    </div>}

    {status === 'running' && <div className="flex items-center justify-between gap-3">
      {nextStep ? <button className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={ratingPending} onClick={() => onNext(false)}>Next: {nextStep.label}<ArrowRight size={15} className="ml-2 inline" /></button>
        : <button className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold" onClick={() => onNext(false)}>Finish</button>}
      <span className="flex items-center gap-2">
        {ratingPending && <button className={field} onClick={() => onNext(true)}>Continue anyway</button>}
        <button className={field} onClick={onDisarm}><Square size={14} className="mr-2 inline" />Stop</button>
      </span>
    </div>}
    {status === 'complete' && <p className="text-sm text-gray-400">All steps done. Use the Post-call review or end the session as usual.</p>}
  </section>
}
