import { useEffect, useState } from 'react'
import { Play, RotateCcw, ShieldOff } from 'lucide-react'
import { DEFAULT_VOICE_CONDITION, voiceUsable } from '../../main/voiceProtocol'
import type { VoiceCondition, VoicePairState, VoiceSeat } from '../../main/voiceProtocol'

const number = (v: number | null | undefined, unit = '', digits = 1) => v == null ? '--' : `${v.toFixed(digits)}${unit}`
const button = 'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition active:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:opacity-40 disabled:cursor-not-allowed'
const modeName = (mode: VoiceCondition['mode']) => ({bypass:'Natural',audibility:'Audibility',match:'Match',detone:'Detone'})[mode]
const sameCondition = (a: VoiceCondition, b: VoiceCondition) =>
  (Object.keys(DEFAULT_VOICE_CONDITION) as (keyof VoiceCondition)[]).every(key =>
    key === 'targetSlot' && (a.mode === 'bypass' || a.mode === 'audibility') || a[key] === b[key])

export function AudioSetupCheck({slot, state, connected, participantConnected, phase, onReset}: {
  slot: VoiceSeat; state: VoicePairState | null; connected: boolean; participantConnected: boolean
  phase: string; onReset: () => void
}) {
  const [now,setNow]=useState(Date.now())
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t)},[])
  const report=state?.reports[slot]
  const fresh=connected&&participantConnected&&!!state?.available[slot]&&!!report&&Math.abs(now-report.capturedAt)<4000
  const r=fresh?report:undefined, c=r?.calibration
  const healthy=r?.health.state==='ready'
  const ready=!!c&&voiceUsable(c)&&healthy
  const quality=!r?'Unavailable':!healthy?'Needs attention':r.clean.clippingRate>.001?'Clipping'
    :r.clean.speechActive&&r.clean.rmsDbfs-r.clean.noiseFloorDbfs<12?'Noisy':r.clean.speechActive&&r.clean.rmsDbfs< -40?'Quiet':'Connected'
  const status=!connected||!participantConnected?'Offline':!r?'Waiting':!healthy?'Needs attention':ready?'Ready':'Collecting'
  const message=!connected?'Waiting for session server':!participantConnected?'Waiting for participant':!r?'Waiting for audio signal'
    :!healthy?r.health.reason??'Audio processor needs attention':ready?c?.state==='strong'?'Strong voice baseline':'Voice baseline ready':c?.reason??'Waiting for natural speech'
  return <section aria-label={`${slot} audio setup check`} className="border-t border-gray-800 pt-3">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-semibold text-gray-300">Audio setup check</h3>
      <button type="button" className={`${button} bg-sky-600 text-white`} disabled={!fresh||!healthy||phase==='ended'}
        title={`Reset ${slot}'s voice baseline and return audio effects to Natural`} onClick={onReset}><RotateCcw size={13}/>Recalibrate</button>
    </div>
    <div className="flex items-center justify-between gap-3">
      <p role="status" className="text-xs text-gray-400">{message}</p>
      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ring-1 ${ready?'bg-emerald-600/20 text-emerald-200 ring-emerald-500/30':fresh?'bg-sky-600/20 text-sky-200 ring-sky-500/30':'bg-gray-800 text-gray-500 ring-gray-700'}`}>{status}</span>
    </div>
    {c&&<progress aria-label={`${slot} voice baseline quality`} title="Speech coverage and signal quality" value={c.confidence} max={1} className="mt-3 h-1.5 w-full accent-sky-500"/>}
    <dl className="mt-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 text-xs">
      <dt className="text-gray-400">Microphone</dt><dd className="text-right">{quality}</dd>
      <dt className="text-gray-400">Applied pitch / volume</dt><dd className="text-right font-mono">{number(r?.applied.pitchSemitones,' st',2)} / {number(r?.applied.gainDb,' dB')}</dd>
    </dl>
    <details className="mt-3 text-xs text-gray-400"><summary className="cursor-pointer py-1">Diagnostics</summary>
      {r?<dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
        <dt>Baseline coverage</dt><dd>{number((c?.confidence??0)*100,'%',0)}</dd>
        <dt>Clean level</dt><dd>{number(r.clean.rmsDbfs,' dBFS')}</dd>
        <dt>Altered level</dt><dd>{number(r.altered.rmsDbfs,' dBFS')}</dd>
        <dt>Pitch movement</dt><dd>{number(r.clean.relativePitchZ,' z')}</dd>
        <dt>Pitch range</dt><dd>{number(r.clean.rollingPitchRangeSt,' st')}</dd>
        <dt>Accepted speech / turns</dt><dd>{number(c?.voicedSeconds,'s',0)} / {c?.validTurns??0}</dd>
        <dt>Processor</dt><dd>{r.health.state}</dd>
        <dt>Signal / noise</dt><dd>{number(c?.snrDb,' dB')}</dd>
        <dt>Pitch clarity</dt><dd>{number(r.clean.pitchClarity,'',2)}</dd>
        <dt>Dropped frames / underruns</dt><dd>{r.health.analysisDroppedFrames} / {r.health.underruns}</dd>
        <dt>Limiter reduction</dt><dd>{number(r.applied.limiterReductionDb,' dB')}</dd>
        <dt>Buffer / latency</dt><dd>{number(r.health.bufferedMs,' ms')} / {number(r.health.measuredLatencyMs,' ms')}</dd>
        <dt>Baseline</dt><dd>{c?.frozen?'Frozen':'Collecting'}</dd>
      </dl>:<p className="mt-2">No current audio measurements.</p>}
      {r?.applied.fallbackReason&&<p className="mt-2 text-amber-300">{r.applied.fallbackReason}</p>}
    </details>
  </section>
}

export function VoiceControls({ state, error, phase, connected, onApply }: {
  state: VoicePairState | null; error: string; phase: string; connected: boolean
  onApply: (c: VoiceCondition) => void
}) {
  const [draft,setDraft]=useState<VoiceCondition>({...DEFAULT_VOICE_CONDITION,targetSlot:'P1'})
  const [tick,setTick]=useState(Date.now())
  useEffect(()=>{const t=setInterval(()=>setTick(Date.now()),1000);return()=>clearInterval(t)},[])
  useEffect(()=>{if(state) setDraft(state.condition)},[state?.condition.mode,state?.condition.targetSlot,state?.condition.strength,state?.condition.audibility])
  const target=draft.targetSlot??'P1'
  const active=state?.condition
  const pending=!!active&&!sameCondition(draft,active)
  const seats: VoiceSeat[]=draft.mode==='match'||draft.audibility||draft.mode==='audibility'?['P1','P2']:[target]
  const ready=draft.mode==='bypass'&&!draft.audibility||seats.every(s=>{
    const r=state?.reports[s]
    return r&&state?.available[s]&&Math.abs(tick-r.capturedAt)<4000&&voiceUsable(r.calibration)&&r.health.state==='ready'
  })
  return <section aria-label="Audio controls" className="min-w-0 border-t border-gray-800 pt-4 xl:col-span-2">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-semibold text-gray-300">Audio controls</h2>
      <button className={`${button} bg-gray-800 text-gray-200`} disabled={!connected} title="Return both voices to their natural settings"
        onClick={()=>onApply({...DEFAULT_VOICE_CONDITION})}><ShieldOff size={16}/>Bypass</button>
    </div>
    <div>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Voice condition">
          {(['bypass','audibility','match','detone'] as const).map(mode=><button key={mode} aria-pressed={draft.mode===mode}
            className={`${button} ${draft.mode===mode?'bg-sky-600 text-white':'bg-gray-800 text-gray-300'}`}
            onClick={()=>setDraft({...draft,mode,targetSlot:draft.targetSlot??'P1',pitchRangeScale:mode==='detone'?.75:1,intensityRangeScale:mode==='detone'?.8:1})}>
            {mode==='bypass'?'Natural':mode==='audibility'?'Audibility':mode==='match'?'Match':'Detone'}</button>)}
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="text-sm text-gray-300">Target<select aria-label="Voice target" className="ml-2 rounded-md bg-gray-800 p-2" value={target}
            onChange={e=>setDraft({...draft,targetSlot:e.target.value as VoiceSeat})}><option>P1</option><option>P2</option></select></label>
          <label className="text-sm text-gray-300">Strength<select aria-label="Voice strength" className="ml-2 rounded-md bg-gray-800 p-2" value={draft.strength}
            onChange={e=>setDraft({...draft,strength:Number(e.target.value)})}><option value={.5}>Subtle</option><option value={1}>Standard</option></select></label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.audibility} onChange={e=>setDraft({...draft,audibility:e.target.checked})}/>Audibility gain for both participants</label>
        <details className="text-sm text-gray-400"><summary className="cursor-pointer">Advanced</summary>
          {([{key:'pitchRangeScale',label:'Pitch range',min:.75,max:1.15,step:.01},{key:'intensityRangeScale',label:'Intensity range',min:.8,max:1.15,step:.01},
            {key:'pitchOffsetSemitones',label:'Pitch offset (st)',min:-.75,max:.75,step:.05},{key:'outputGainDb',label:'Level offset (dB)',min:-2,max:2,step:.1}] as const).map(x=>
              <label key={x.key} className="mt-3 block">{x.label}<span className="float-right font-mono">{draft[x.key].toFixed(2)}</span>
                <input aria-label={x.label} type="range" className="block w-full accent-sky-500" min={x.min} max={x.max} step={x.step} value={draft[x.key]}
                  disabled={draft.mode==='match'&&(x.key==='pitchRangeScale'||x.key==='intensityRangeScale')}
                  onChange={e=>setDraft({...draft,[x.key]:Number(e.target.value)})}/></label>)}
        </details>
        <button className={`${button} w-full bg-emerald-700 text-white`} disabled={!connected||!ready||phase==='ended'} onClick={()=>onApply(draft)}>
          <Play size={15}/>Apply voice condition</button>
        <div role="status" aria-live="polite" className="min-h-16 border-l-2 border-emerald-600 pl-3 text-sm">
          <p className="font-medium text-emerald-300">{active?`Active: ${modeName(active.mode)}${['match','detone'].includes(active.mode)?` on ${active.targetSlot}`:''}`:'Waiting for server'}</p>
          {active&&<p className="mt-1 text-xs text-gray-400">{active.mode==='audibility'||active.audibility?'Audibility on both participants':active.mode==='bypass'?'Manual pitch controls available':`${active.strength===1?'Standard':'Subtle'} strength · pitch range ${active.pitchRangeScale.toFixed(2)}x · intensity range ${active.intensityRangeScale.toFixed(2)}x`}</p>}
          {pending&&<p className="mt-1 text-xs text-amber-300">Changes not applied</p>}
        </div>
        {error&&<p role="alert" className="text-sm text-red-300">{error}</p>}
        {!ready&&<p className="text-xs text-amber-300">Waiting for usable voice baselines</p>}
        <details className="border-t border-gray-800 pt-3 text-xs text-gray-400">
          <summary className="cursor-pointer">Pair diagnostics</summary>
          <p title="An exploratory engineering measure, not validated rapport or emotion">Exploratory index: {number(state?.exploratoryIndex,' / 100',0)}</p>
          <p className="text-xs text-gray-400">Pitch r {number(state?.pitchSynchrony,'',2)} · intensity r {number(state?.intensitySynchrony,'',2)}</p>
          <p className="text-xs text-gray-400">Turn coordination {number(state?.turnCoordination,'',2)} · convergence {number(state?.convergence,'',2)}</p>
          <p className="text-xs text-gray-400">{state?.pairedTurns??0} paired turns</p>
        </details>
      </div>
    </div>
  </section>
}
