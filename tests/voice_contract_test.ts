import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_VOICE_CONDITION, parseVoiceCondition, validVoiceReport } from '../main/voiceProtocol'
import { VoiceAnalysis, voiceAdjustment, IDENTITY_VOICE } from '../renderer/lib/voiceAnalysis'
import type { AcousticFrame } from '../renderer/lib/voiceAnalysis'
import { VoiceSession, correlation } from '../main/voiceSession'
import { VoiceLogger } from '../main/voiceLogger'
import { features, report, turn } from './voice_fixtures'

function recording(level=-24, pitch=200, turns=5, noise=-60) {
  const engine=new VoiceAnalysis()
  let at=1000
  const ingest=(speech:boolean,i:number) => engine.ingest({at:at+=40,durationMs:40,
    rmsDbfs:speech?level+3*Math.sin(i/10):noise,peakDbfs:speech?level+10:noise+5,
    f0Hz:speech?pitch*2**(Math.sin(i/12)*2/12):null,pitchClarity:speech?.95:0,
    clippingRate:0,speechProbability:speech?.95:.01})
  for(let i=0;i<25;i++)ingest(false,i)
  for(let t=0;t<turns;t++) {
    for(let i=0;i<250;i++)ingest(true,i)
    for(let i=0;i<25;i++)ingest(false,i)
  }
  return {engine,ingest}
}

test('silence never produces a usable baseline or fabricated pitch',()=>{
  const a=new VoiceAnalysis()
  for(let i=0;i<5000;i++) {
    const f=a.ingest({at:i*40,durationMs:40,rmsDbfs:-160,peakDbfs:-160,f0Hz:null,
      pitchClarity:0,clippingRate:0,speechProbability:0})
    assert.equal(f.f0Hz,null)
  }
  assert.equal(a.calibration.state,'uncalibrated')
  assert.equal(a.calibration.confidence,0)
  assert.deepEqual(a.takeTurns(),[])
})
test('multiple natural turns build and freeze a baseline; reset clears it',()=>{
  const {engine}=recording()
  assert.equal(engine.calibration.state,'strong')
  assert.equal(engine.calibration.frozen,true)
  assert.equal(engine.calibration.validTurns,5)
  assert.ok(Math.abs(engine.calibration.baselinePitchSt!-12)<.5)
  const frozen={...engine.calibration}
  engine.ingest({at:70000,durationMs:40,rmsDbfs:-10,peakDbfs:-1,f0Hz:500,pitchClarity:.95,clippingRate:0,speechProbability:.95})
  assert.deepEqual(engine.calibration,frozen)
  assert.equal(engine.takeTurns().length,5)
  assert.deepEqual(engine.takeTurns(),[])
  engine.reset()
  assert.equal(engine.calibration.state,'uncalibrated')
})
test('quiet and low/high-pitch speakers normalize against their own baseline',()=>{
  for(const [level,pitch] of [[-40,90],[-20,300]]) {
    const {engine,ingest}=recording(level,pitch)
    assert.equal(engine.calibration.state,'strong')
    assert.ok(Math.abs(ingest(true,0).relativePitchZ!)<.5)
    assert.ok(Math.abs(ingest(true,0).relativeIntensityDb!)<1)
  }
})
test('noise and clipped speech cannot create a usable baseline',()=>{
  assert.notEqual(recording(-35,200,5,-40).engine.calibration.state,'usable')
  const a=new VoiceAnalysis()
  for(let i=0;i<2000;i++)a.ingest({at:i*40,durationMs:40,rmsDbfs:-1,peakDbfs:0,
    f0Hz:200,pitchClarity:.99,clippingRate:.1,speechProbability:.99})
  assert.equal(a.calibration.voicedSeconds,0)
})
test('audibility uses bounded fixed gain and leaves pitch unchanged',()=>{
  const c=report().calibration
  for(const level of [-45,-24,-10]) {
    c.baselineIntensityDbfs=level
    const a=voiceAdjustment({...DEFAULT_VOICE_CONDITION,mode:'audibility'},false,features(),c,null,0,true)
    assert.equal(a.gainDb,Math.max(-6,Math.min(6,-24-level)))
    assert.equal(a.pitchSemitones,0)
  }
})
test('natural condition is identity; untargeted participant stays natural',()=>{
  assert.deepEqual(voiceAdjustment(DEFAULT_VOICE_CONDITION,true,features(),report().calibration,null,0,true),IDENTITY_VOICE)
  assert.deepEqual(voiceAdjustment({...DEFAULT_VOICE_CONDITION,mode:'detone',targetSlot:'P1',pitchRangeScale:.75},false,
    features(),report().calibration,null,0,true),IDENTITY_VOICE)
})
test('detone reduces excursions on either side without shifting baseline pitch',()=>{
  const condition={...DEFAULT_VOICE_CONDITION,mode:'detone' as const,targetSlot:'P1' as const,pitchRangeScale:.75,intensityRangeScale:.8}
  for(const delta of [-4,-1,0,1,4]) {
    const f={...features(),f0Semitones:12+delta,relativeIntensityDb:delta*2}
    const a=voiceAdjustment(condition,true,f,report().calibration,null,0,true)
    assert.ok(Math.abs(a.pitchSemitones-Math.max(-.75,Math.min(.75,-delta*.25)))<1e-8)
    assert.ok(Math.abs(a.gainDb)<=2)
  }
})
test('match never uses stale/invalid partner turns and obeys hard bounds',()=>{
  const c={...DEFAULT_VOICE_CONDITION,mode:'match' as const,targetSlot:'P1' as const}
  for(const p of [null,{...turn(),valid:false},turn(1,1000)]) {
    const a=voiceAdjustment(c,true,features(),report().calibration,p,Date.now(),true)
    assert.equal(a.active,false)
  }
  const a=voiceAdjustment(c,true,{...features(),f0Semitones:30,relativeIntensityDb:40},report().calibration,
    {...turn(),relativePitchZ:100,relativeIntensityDb:100,pitchRangeRatio:10,intensityRangeRatio:10},Date.now(),true)
  assert.ok(Math.abs(a.pitchSemitones)<=.75)
  assert.ok(Math.abs(a.gainDb)<=2)
  assert.equal(a.pitchRangeScale,1.15)
})
test('processor failures and clipping fall back without experimental changes',()=>{
  const c={...DEFAULT_VOICE_CONDITION,mode:'detone' as const,targetSlot:'P1' as const}
  for(const [f,healthy] of [[features(),false],[{...features(),clippingRate:.1},true]] as const) {
    const a=voiceAdjustment(c,true,f,report().calibration,null,Date.now(),healthy)
    assert.equal(a.active,false);assert.equal(a.gainDb,0);assert.ok(a.fallbackReason)
  }
})
test('condition validation rejects unsafe settings and missing target',()=>{
  assert.ok(parseVoiceCondition(DEFAULT_VOICE_CONDITION))
  for(const change of [{mode:'match'},{pitchRangeScale:.5},{outputGainDb:3},{strength:NaN},{audibility:'yes'}])
    assert.equal(parseVoiceCondition({...DEFAULT_VOICE_CONDITION,...change}),null)
})
test('telemetry validation checks every nullable field, bounds and timestamps',()=>{
  assert.equal(validVoiceReport(report()),true)
  const good=report();good.turns=[turn()];assert.equal(validVoiceReport(good),true)
  const paths=[['clean','relativePitchZ'],['altered','rollingPitchRangeSt'],['calibration','baselinePitchSt'],
    ['applied','pitchSemitones'],['health','bufferedMs']]
  for(const [a,b] of paths) {
    for(const v of [undefined,NaN,Infinity,'oops']) {
      const r=report() as any;r[a][b]=v;assert.equal(validVoiceReport(r),false,`${a}.${b}=${v}`)
    }
  }
  for(const value of [-1,1e20])assert.equal(validVoiceReport({...report(),capturedAt:value}),false)
  assert.equal(validVoiceReport({...report(),turns:[{...turn(),voicedMs:Infinity}]}),false)
})
test('session rejects unavailable, stale and not-yet-calibrated participants',()=>{
  const s=new VoiceSession(),c={...DEFAULT_VOICE_CONDITION,mode:'match' as const,targetSlot:'P1' as const}
  assert.ok(s.canApply(c,1000))
  assert.equal(s.snapshot(0).available.P1,false)
  s.update('P1',report(),1000);s.update('P2',report(),1000)
  assert.equal(s.canApply(c,1100),null)
  assert.ok(s.canApply(c,3000))
  s.disconnect('P2');assert.ok(s.canApply(c,1100))
  assert.ok(s.canApply({...DEFAULT_VOICE_CONDITION,audibility:true},1100))
})
test('sequence and turn IDs deduplicate retransmissions; reconnect clears old turns',()=>{
  const s=new VoiceSession(),r=report();r.turns=[turn()]
  assert.equal(s.update('P1',r).length,1)
  assert.equal(s.update('P1',r).length,0)
  assert.equal(s.update('P1',{...r,sequence:2}).length,0)
  s.disconnect('P1');assert.equal(s.lastTurn('P1'),null)
  assert.equal(s.update('P1',r).length,1)
})
test('synchrony is unavailable for constant or insufficient samples',()=>{
  assert.equal(correlation([1,1,1,1,1],[2,2,2,2,2]),null)
  assert.equal(correlation([1,2],[2,3]),null)
  assert.equal(correlation([1,2,3,4,5],[5,4,3,2,1]),-1)
})
test('voice exports contain separate clean/altered values and actual applied settings',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'voice-contract-'))
  const logger=new VoiceLogger(dir,Date.now()),r=report(),s=new VoiceSession()
  r.altered.rmsDbfs=-20;r.applied.gainDb=4;r.turns=[turn()]
  s.update('P1',r);logger.condition(r.condition)
  logger.write({slot:'P1',participantId:'test',dyadId:'test',phase:'live',liveStartedAtMs:Date.now()},r,s.snapshot(),r.turns)
  await logger.close()
  const csv=await readFile(path.join(dir,'voice_features_P1.csv'),'utf8')
  const lines=csv.trim().split('\n').map(line=>line.split(',').map(s=>s.replace(/^"|"$/g,'')))
  assert.equal(lines[0].length,lines[1].length)
  const result=Object.fromEntries(lines[0].map((k,i)=>[k,lines[1][i]]))
  assert.equal(result.clean_rms_dbfs,'-24');assert.equal(result.altered_rms_dbfs,'-20')
  assert.equal(result.applied_gain_db,'4');assert.equal(result.measured_latency_ms,'')
  assert.ok((await readFile(path.join(dir,'voice_turns.csv'),'utf8')).includes('response_gap_ms'))
  assert.equal(logger.manifest().conditions.length,1)
})
