import { useState } from 'react'
import { Clock3, Play, Square } from 'lucide-react'
import { STUDY_BLOCK_MS, STUDY_FACE_PRESETS } from '../../main/studyTimeline'
import type { Phase, PSlot, StudyTimelineState } from '../lib/protocol'

export function StudyTimelineControls({ state, phase, connected, now, error, onArm, onDisarm }: {
  state: StudyTimelineState | null
  phase: Phase
  connected: Record<PSlot, boolean>
  now: number
  error: string
  onArm: (presetId: string, firstSeat: PSlot) => void
  onDisarm: () => void
}) {
  const [presetId, setPresetId] = useState('')
  const [firstSeat, setFirstSeat] = useState<PSlot>('P1')
  const status = state?.status ?? 'idle'
  const busy = status === 'armed' || status === 'running'
  const labels = ['No alteration', firstSeat, 'No alteration', firstSeat === 'P1' ? 'P2' : 'P1']
  const selectedFirst = state?.firstSeat ?? firstSeat
  labels[1] = selectedFirst
  labels[3] = selectedFirst === 'P1' ? 'P2' : 'P1'
  const elapsed = state?.startedAtMs ? Math.max(0, now - state.startedAtMs) : 0
  const block = status === 'complete' ? 4 : state?.block ?? -1
  const field = 'rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200'
  return <section className="rounded-lg border border-gray-700 bg-gray-900/40 p-5" aria-label="Conversation schedule">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold"><Clock3 size={18} />Conversation schedule <span className="text-xs font-normal text-amber-300">Draft</span></h2>
      <span className="text-sm text-gray-400">{status === 'idle' ? 'Not armed' : status === 'armed' ? 'Armed for next conversation' : status === 'running' ? `Part ${block + 1} of 4` : status === 'complete' ? 'Four parts complete' : 'Interrupted'}</span>
    </div>
    <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">{labels.map((label, i) =>
      <div key={i} className={`border-t-2 pt-3 ${block === i && status === 'running' ? 'border-sky-400' : 'border-gray-700'}`}>
        <div className="text-xs text-gray-500">{i * 2 + Math.floor(i / 2)}:{i % 2 ? '30' : '00'}–{(i + 1) * 2 + Math.floor((i + 1) / 2)}:{(i + 1) % 2 ? '30' : '00'}</div>
        <strong className="mt-1 block text-sm text-gray-200">{label}</strong>
        {block === i && status === 'running' && <div className="mt-2 h-1 rounded bg-gray-700"><div className="h-1 rounded bg-sky-400" style={{ width: `${Math.min(100, Math.max(0, (elapsed - i * STUDY_BLOCK_MS) / STUDY_BLOCK_MS * 100))}%` }} /></div>}
      </div>)}
    </div>
    {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
    {phase === 'waiting' && !busy && <div className="mt-5 flex flex-wrap items-end gap-3">
      <label className="flex min-w-40 flex-col gap-2 text-xs text-gray-400">Face condition<select className={field} value={presetId} onChange={e => setPresetId(e.target.value)}><option value="">Select preset</option>{STUDY_FACE_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="flex min-w-40 flex-col gap-2 text-xs text-gray-400">First altered participant<select className={field} value={firstSeat} onChange={e => setFirstSeat(e.target.value as PSlot)}><option value="P1">P1</option><option value="P2">P2</option></select></label>
      <button className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold disabled:opacity-40" disabled={!presetId || !connected.P1 || !connected.P2} onClick={() => onArm(presetId, firstSeat)}><Play size={15} className="mr-2 inline" />Arm schedule</button>
    </div>}
    {phase === 'waiting' && status === 'armed' && <div className="mt-5 flex items-center justify-between gap-3"><p className="text-sm text-gray-400">Starts when the researcher starts the conversation.</p><button className={field} onClick={onDisarm}><Square size={14} className="mr-2 inline" />Disarm</button></div>}
    {status === 'complete' && phase === 'live' && <p className="mt-4 text-sm text-gray-400">Both faces have returned to neutral. End the conversation when appropriate.</p>}
  </section>
}
