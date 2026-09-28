import { useEffect, useState } from 'react'
import { AudioLines, Play, RotateCcw, ShieldOff } from 'lucide-react'
import { DEFAULT_VOICE_CONDITION, voiceUsable } from '../../main/voiceProtocol'
import type { VoiceCondition, VoicePairState, VoiceSeat } from '../../main/voiceProtocol'

const number = (v: number | null | undefined, unit = '', digits = 1) => v == null ? '--' : `${v.toFixed(digits)}${unit}`
const button = 'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed'

export function VoiceControls({ state, error, phase, connected, onApply, onReset }: {
  state: VoicePairState | null; error: string; phase: string; connected: boolean
  onApply: (c: VoiceCondition) => void; onReset: (slot: VoiceSeat) => void
}) {
  const [draft,setDraft]=useState<VoiceCondition>({...DEFAULT_VOICE_CONDITION,targetSlot:'P1'})
  const [tick,setTick]=useState(Date.now())
  useEffect(()=>{const t=setInterval(()=>setTick(Date.now()),1000);return()=>clearInterval(t)},[])
  useEffect(()=>{if(state) setDraft(state.condition)},[state?.condition.mode,state?.condition.targetSlot,state?.condition.strength,state?.condition.audibility])
  const target=draft.targetSlot??'P1'
  const seats: VoiceSeat[]=draft.mode==='match'||draft.audibility||draft.mode==='audibility'?['P1','P2']:[target]
  const ready=draft.mode==='bypass'&&!draft.audibility||seats.every(s=>{
    const r=state?.reports[s]
    return r&&state?.available[s]&&Math.abs(tick-r.capturedAt)<4000&&voiceUsable(r.calibration)&&r.health.state==='ready'
  })
  return <section aria-label="Voice synchrony" className="col-span-12 border-t border-gray-800 pt-4">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-base font-semibold"><AudioLines size={19}/>Voice synchrony</h2>
      <button className={`${button} bg-gray-800 text-gray-200`} disabled={!connected} title="Return both voices to their natural settings"
        onClick={()=>onApply({...DEFAULT_VOICE_CONDITION})}><ShieldOff size={16}/>Bypass</button>
    </div>
    <div className="grid gap-5 lg:grid-cols-3">
      {(['P1','P2'] as const).map(slot=>{
        const r=state?.reports[slot], c=r?.calibration
        const stale=!state?.available[slot]||!r||Math.abs(tick-r.capturedAt)>4000
        const quality=stale?'Unavailable':r.clean.clippingRate>.001?'Clipping':r.clean.speechActive&&r.clean.rmsDbfs-r.clean.noiseFloorDbfs<12?'Noisy':r.clean.speechActive&&r.clean.rmsDbfs< -40?'Quiet':'Good'
        return <div key={slot} className="min-w-0 border-l-2 border-gray-700 pl-4">
          <div className="flex items-center justify-between gap-2"><h3 className="font-semibold">{slot} voice</h3>
            <span className={quality==='Good'?'text-emerald-400':'text-amber-300'}>{quality}</span></div>
          <div className="my-2 flex justify-between text-sm text-gray-400"><span>{stale?'Voice analysis unavailable':c?.state}</span>
            <span title="Coverage and signal quality; not an emotion probability">{c?Math.round(c.confidence*100):0}% baseline quality</span></div>
          <progress aria-label={`${slot} voice baseline quality`} value={c?.confidence??0} max={1} className="h-1.5 w-full accent-sky-500"/>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-gray-400">Clean level</dt><dd className="text-right font-mono">{number(r?.clean.rmsDbfs,' dBFS')}</dd>
            <dt className="text-gray-400">Altered level</dt><dd className="text-right font-mono">{number(r?.altered.rmsDbfs,' dBFS')}</dd>
            <dt className="text-gray-400">Pitch movement</dt><dd className="text-right font-mono">{number(r?.clean.relativePitchZ,' z')}</dd>
            <dt className="text-gray-400">Pitch range</dt><dd className="text-right font-mono">{number(r?.clean.rollingPitchRangeSt,' st')}</dd>
            <dt className="text-gray-400">Voice / turns</dt><dd className="text-right font-mono">{number(c?.voicedSeconds,'s',0)} / {c?.validTurns??0}</dd>
            <dt className="text-gray-400">Applied pitch / gain</dt><dd className="text-right font-mono">{number(r?.applied.pitchSemitones,'st',2)} / {number(r?.applied.gainDb,'dB')}</dd>
            <dt className="text-gray-400">Processor</dt><dd className="text-right">{r?.health.state??'unavailable'}</dd>
          </dl>
          <meter aria-label={`${slot} relative loudness`} min={-12} max={12} value={r?.clean.relativeIntensityDb??0} className="mt-3 w-full"/>
          <p className="mt-2 min-h-10 text-xs text-gray-400">{r?.health.reason??r?.applied.fallbackReason??c?.reason??(c?.frozen?'Baseline frozen':'Collecting natural speech')}</p>
          <details className="my-2 text-xs text-gray-400"><summary className="cursor-pointer">Signal details</summary>
            <p>SNR {number(c?.snrDb,' dB')} · clarity {number(r?.clean.pitchClarity,'',2)}</p>
            <p>Dropped frames {r?.health.analysisDroppedFrames??0} · underruns {r?.health.underruns??0}</p>
            <p>Limiter reduction {number(r?.applied.limiterReductionDb,' dB')}</p>
            <p>Buffer {number(r?.health.bufferedMs,' ms')} · measured latency {number(r?.health.measuredLatencyMs,' ms')}</p>
          </details>
          <button className={`${button} bg-gray-800`} title={`Collect a new voice baseline for ${slot}`} disabled={!connected||stale}
            onClick={()=>onReset(slot)}><RotateCcw size={14}/>Recalibrate</button>
        </div>
      })}
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Voice condition">
          {(['bypass','audibility','match','detone'] as const).map(mode=><button key={mode} aria-pressed={draft.mode===mode}
            className={`${button} ${draft.mode===mode?'bg-sky-600 text-white':'bg-gray-800 text-gray-300'}`}
            onClick={()=>setDraft({...draft,mode,targetSlot:draft.targetSlot??'P1',pitchRangeScale:mode==='detone'?.75:1,intensityRangeScale:mode==='detone'?.8:1})}>
            {mode==='bypass'?'Natural':mode==='audibility'?'Audibility':mode==='match'?'Match':'Detone'}</button>)}
        </div>
        <div className="flex gap-4">
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
        <p className="text-xs text-gray-400">Active: {state?.condition.mode??'bypass'}{state?.condition.targetSlot?` on ${state.condition.targetSlot}`:''}</p>
        {error&&<p role="alert" className="text-sm text-red-300">{error}</p>}
        {!ready&&<p className="text-xs text-amber-300">Waiting for usable voice baselines</p>}
        <div className="border-t border-gray-800 pt-3 text-sm">
          <p title="An exploratory engineering measure, not validated rapport or emotion">Exploratory index: {number(state?.exploratoryIndex,' / 100',0)}</p>
          <p className="text-xs text-gray-400">Pitch r {number(state?.pitchSynchrony,'',2)} · intensity r {number(state?.intensitySynchrony,'',2)}</p>
          <p className="text-xs text-gray-400">Turn coordination {number(state?.turnCoordination,'',2)} · convergence {number(state?.convergence,'',2)}</p>
          <p className="text-xs text-gray-400">{state?.pairedTurns??0} paired turns</p>
        </div>
      </div>
    </div>
  </section>
}
