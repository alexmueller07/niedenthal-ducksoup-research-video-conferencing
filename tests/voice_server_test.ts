import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'
import { SessionServer } from '../main/server'
import { SessionLogger } from '../main/logger'
import { DEFAULT_VOICE_CONDITION } from '../main/voiceProtocol'
import { EMPTY_IDENTITY } from '../main/protocol'
import { report, turn } from './voice_fixtures'

const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function client(url:string,role:'admin'|'participant',id:string) {
  const ws=new WebSocket(url),messages:any[]=[]
  ws.on('message',raw=>messages.push(JSON.parse(String(raw))))
  await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)})
  const send=(msg:unknown)=>ws.send(JSON.stringify(msg))
  const take=async(type:string,filter=(x:any)=>true)=>{
    for(let i=0;i<100;i++) {
      const index=messages.findIndex(m=>m.type===type&&filter(m))
      if(index>=0)return messages.splice(index,1)[0]
      await sleep(20)
    }
    throw new Error(`Timed out waiting for ${type}; got ${messages.map(m=>m.type)}`)
  }
  send({type:'hello',role,identity:{...EMPTY_IDENTITY,name:id,participantId:id,dyadId:'qa'},appVersion:'3.0.0'})
  const welcome=await take('welcome')
  return {ws,send,take,messages,slot:welcome.slot}
}

test('three-client routing, authorization, fallback/reset and CSV integration',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'voice-session-')),logger=await SessionLogger.create(root)
  const server=new SessionServer(0,logger)
  await server.start()
  const port=(server as any).wss.address().port
  const url=`ws://127.0.0.1:${port}`,clients:Awaited<ReturnType<typeof client>>[]=[]
  try {
    const admin=await client(url,'admin','QA researcher');clients.push(admin)
    const p1=await client(url,'participant','QA1');clients.push(p1)
    const p2=await client(url,'participant','QA2');clients.push(p2)
    assert.equal(p1.slot,'P1');assert.equal(p2.slot,'P2')
    const condition={...DEFAULT_VOICE_CONDITION,mode:'match' as const,targetSlot:'P1' as const}
    admin.send({type:'voice-condition',condition})
    assert.match((await admin.take('voice-error')).reason,/unavailable/)
    p1.send({type:'voice-condition',condition})
    p1.send({type:'voice-report',data:{...report(),capturedAt:1e30}})
    p1.send({type:'voice-clock',sentAt:12345})
    assert.equal((await p1.take('voice-clock')).sentAt,12345)
    const r1=report(),r2=report();r2.turns=[turn()]
    p1.send({type:'voice-report',data:r1});p2.send({type:'voice-report',data:r2})
    const received=await p1.take('voice-partner-turn')
    assert.equal(received.turn.id,1)
    await admin.take('voice-state',m=>m.state.available.P1&&m.state.available.P2)
    admin.send({type:'voice-condition',condition})
    assert.deepEqual((await p1.take('voice-condition')).condition,condition)
    assert.deepEqual((await p2.take('voice-condition')).condition,condition)
    admin.send({type:'set-effect',slot:'P1',param:'voiceSemitones',value:8})
    assert.match((await admin.take('voice-error')).reason,/legacy/)
    admin.send({type:'apply-preset',slot:'P1',presetId:'voice',effects:{alpha:0,voiceSemitones:8,voiceSmile:0}})
    assert.match((await admin.take('voice-error')).reason,/legacy/)
    admin.send({type:'set-effect',slot:'P1',param:'voiceSmile',value:1})
    assert.match((await admin.take('voice-error')).reason,/legacy/)
    admin.send({type:'apply-preset',slot:'P1',presetId:'smile-voice',effects:{alpha:0,voiceSemitones:0,voiceSmile:1}})
    assert.match((await admin.take('voice-error')).reason,/legacy/)
    await sleep(180)
    p1.send({type:'voice-report',data:{...r1,sequence:2,condition,applied:{...r1.applied,pitchSemitones:.5,active:true}}})
    await admin.take('voice-state',m=>m.state.reports.P1?.sequence===2)
    p1.send({type:'telemetry',data:{alpha:0,voiceSemitones:0,voiceSmile:0,faceFound:true,fps:30,cameraOn:true}})
    admin.send({type:'voice-reset',slot:'P1'})
    await p1.take('voice-reset')
    await p2.take('voice-partner-turn',m=>m.turn===null)
    await admin.take('voice-state',m=>!m.state.available.P1)
    admin.send({type:'set-phase',phase:'ended'})
    await p1.take('phase',m=>m.phase==='ended')
    admin.send({type:'voice-condition',condition})
    assert.match((await admin.take('voice-error')).reason,/ended/)
    await logger.writeManifest({qa:true})
  } finally {
    clients.forEach(c=>c.ws.close())
    await server.stop()
  }
  const files=await readdir(logger.dir)
  assert.ok(files.includes('voice_features_P1.csv'));assert.ok(files.includes('voice_features_P2.csv'))
  assert.ok(files.includes('voice_turns.csv'))
  const events=await readFile(path.join(logger.dir,'events.csv'),'utf8')
  for(const event of ['blocked_action','voice_condition_changed','voice_calibration_reset'])assert.ok(events.includes(event),event)
  const manifest=JSON.parse(await readFile(path.join(logger.dir,'session.json'),'utf8'))
  assert.equal(manifest.voice.version,'voice-1')
  assert.ok(manifest.voice.conditions.some((c:any)=>c.condition.mode==='match'))
  const effectFile=files.find(f=>f.startsWith('effect_state'))
  assert.ok(effectFile,'Must write existing effect-state export as well')
  const state=await readFile(path.join(logger.dir,effectFile),'utf8')
  assert.ok(state.includes('voice_applied_pitch_st'))
  console.log(`Three-client voice output: ${logger.dir}`)
})
