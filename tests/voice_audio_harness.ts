import { FormantCorrectionNode } from '@soundtouchjs/formant-correction-worklet'
import { PitchDetector } from 'pitchy'
import { VoiceProcessor } from '../renderer/lib/voice'
import { DEFAULT_VOICE_CONDITION } from '../main/voiceProtocol'
import { VOICE_STRETCH } from '../renderer/lib/voiceDspConfig'

const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const rms=(a:Float32Array)=>Math.sqrt(a.reduce((s,x)=>s+x*x,0)/a.length)
const pitch=(a:Float32Array,rate:number)=>{
  const d=PitchDetector.forFloat32Array(4096),values:number[]=[]
  for(let i=rate*.5;i+4096<a.length-rate*.1;i+=4096) {
    const [hz,c]=d.findPitch(a.slice(i,i+4096),rate)
    if(c>.8)values.push(hz)
  }
  values.sort((a,b)=>a-b)
  return values[Math.floor(values.length/2)]??null
}
async function render(rate:number,hz:number,shift:number,amplitude=.1,stretch=VOICE_STRETCH) {
  const ctx=new OfflineAudioContext(1,rate*3,rate)
  await FormantCorrectionNode.register(ctx,'/voice/formant-processor.js')
  await ctx.audioWorklet.addModule('/voice/voice.worklet.js')
  const source=ctx.createBufferSource(),buf=ctx.createBuffer(1,rate*3,rate)
  const input=buf.getChannelData(0)
  for(let i=0;i<input.length;i++)input[i]=amplitude*Math.sin(2*Math.PI*hz*i/rate)
  source.buffer=buf
  const node=new FormantCorrectionNode({context:ctx,outputChannelCount:1})
  node.setStretchParameters(stretch)
  node.pitchSemitones.value=shift
  const limiter=new AudioWorkletNode(ctx,'voice-limiter',{outputChannelCount:[1]})
  source.connect(node).connect(limiter).connect(ctx.destination)
  source.start(.25)
  // Offline rendering can outrun MessagePort configuration. Allow the same
  // initialization interval the live graph gets before judging DSP latency.
  const suspended=ctx.suspend(0)
  const rendered=ctx.startRendering()
  await suspended;await wait(100);await ctx.resume()
  const output=(await rendered).getChannelData(0)
  const f=pitch(output,rate)
  let peak=0,first=-1,nonfinite=0
  output.forEach((x,i)=>{if(!Number.isFinite(x))nonfinite++;peak=Math.max(peak,Math.abs(x));if(first<0&&Math.abs(x)>.001)first=i})
  return {rate,hz,shift,measuredHz:f,errorCents:f?1200*Math.log2(f/(hz*2**(shift/12))):null,
    rms:rms(output.slice(rate)),peak,firstSignalMs:first/rate*1000-250,nonfinite}
}
async function limiterIdentity(rate:number) {
  const ctx=new OfflineAudioContext(1,rate,rate)
  await ctx.audioWorklet.addModule('/voice/voice.worklet.js')
  const s=ctx.createBufferSource(),b=ctx.createBuffer(1,rate,rate),x=b.getChannelData(0)
  for(let i=0;i<x.length;i++)x[i]=.15*Math.sin(i*.039)+.1*Math.sin(i*.127)
  s.buffer=b;s.connect(new AudioWorkletNode(ctx,'voice-limiter',{outputChannelCount:[1]})).connect(ctx.destination);s.start()
  const y=(await ctx.startRendering()).getChannelData(0),delay=Math.ceil(rate*.005)
  let error=0
  for(let i=delay;i<rate;i++)error=Math.max(error,Math.abs(y[i]-x[i-delay]))
  return {rate,error,delayMs:delay/rate*1000}
}
async function realtime(seconds=90) {
  const input=new AudioContext({sampleRate:48000}),destination=input.createMediaStreamDestination()
  const buffer=await input.decodeAudioData(await(await fetch('/speech.wav')).arrayBuffer())
  const source=input.createBufferSource();source.buffer=buffer;source.loop=true
  const gain=input.createGain();gain.gain.value=0
  source.connect(gain).connect(destination);source.start();await input.resume()
  const processor=new VoiceProcessor(destination.stream)
  processor.setSlot('P1');await processor.resume()
  const samples:any[]=[],start=performance.now()
  let conditionApplied=false
  try {
    while(performance.now()-start<seconds*1000) {
      const elapsed=(performance.now()-start)/1000
      const on=elapsed%12>=2&&elapsed%12<10
      gain.gain.setTargetAtTime(on?1:0,input.currentTime,.01)
      const r=processor.report()
      if(r) {
        samples.push(r)
        if(!conditionApplied&&['usable','strong'].includes(r.calibration.state)) {
          processor.setCondition({...DEFAULT_VOICE_CONDITION,mode:'detone',targetSlot:'P1',pitchRangeScale:.75,intensityRangeScale:.8})
          conditionApplied=true
        }
      }
      await wait(250)
    }
    processor.setCondition({...DEFAULT_VOICE_CONDITION})
    await wait(600)
    const bypass=processor.report()
    return {samples,bypass,conditionApplied}
  } finally {processor.close();source.stop();await input.close()}
}
async function manualPitch() {
  const input=new AudioContext({sampleRate:48000}),destination=input.createMediaStreamDestination()
  const oscillator=input.createOscillator(),gain=input.createGain()
  oscillator.frequency.value=200;gain.gain.value=.1
  oscillator.connect(gain).connect(destination);oscillator.start();await input.resume()
  const processor=new VoiceProcessor(destination.stream)
  const monitor=input.createMediaStreamSource(processor.outputStream),analyser=input.createAnalyser()
  analyser.fftSize=8192;monitor.connect(analyser)
  const detector=PitchDetector.forFloat32Array(8192),samples=[]
  try {
    await processor.resume()
    const start=performance.now()
    while(processor.report()?.health.state==='loading'&&performance.now()-start<30000)await wait(100)
    for(const requested of [-4,0,4]) {
      processor.setSemitones(requested);await wait(1600)
      const data=new Float32Array(8192);analyser.getFloatTimeDomainData(data)
      const [hz,clarity]=detector.findPitch(data,input.sampleRate)
      samples.push({requested,hz,clarity,applied:processor.report()?.applied.pitchSemitones,
        errorCents:1200*Math.log2(hz/(200*2**(requested/12))),health:processor.report()?.health})
    }
    processor.setCondition({...DEFAULT_VOICE_CONDITION});await wait(600)
    return {samples,bypass:processor.report()?.applied.pitchSemitones}
  } finally {monitor.disconnect();processor.close();oscillator.stop();await input.close()}
}
Object.assign(window,{voiceQA:{render,limiterIdentity,realtime,manualPitch}})
