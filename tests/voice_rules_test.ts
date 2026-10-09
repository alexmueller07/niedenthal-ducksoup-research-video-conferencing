import assert from 'node:assert/strict'
import { RuleEngine } from '../main/rules'
import { DEFAULT_VOICE_CONDITION } from '../main/voiceProtocol'
import type { VoiceCondition } from '../main/voiceProtocol'
import { NEUTRAL_EFFECTS } from '../main/protocol'
import type { AutomationRule, EffectState, Phase } from '../main/protocol'

let phase: Phase = 'waiting', liveStart: number | null = null, ready = true
let voice: VoiceCondition = { ...DEFAULT_VOICE_CONDITION }
const effects: Record<'P1'|'P2',EffectState> = {
  P1:{ ...NEUTRAL_EFFECTS, voiceSemitones:3, voiceSmile:.5 },P2:{ ...NEUTRAL_EFFECTS },
}
const sent: string[] = []
const engine=new RuleEngine({
  phase:()=>phase, liveStartMs:()=>liveStart,
  effectsOf:slot=>effects[slot],
  applyEffects:(slot,change,rule,why)=>{effects[slot]={...change};sent.push(`${rule.id}:${why}:${slot}:${change.voiceSemitones}`)},
  voiceConditionOf:()=>voice,
  canApplyVoice:()=>ready,
  applyVoice:(condition,rule,why)=>{
    voice={...condition}
    if(condition.mode!=='bypass')for(const slot of ['P1','P2'] as const){effects[slot].voiceSemitones=0;effects[slot].voiceSmile=0}
    sent.push(`${rule.id}:${why}:${condition.mode}`)
  },
  onActiveChange:()=>{},
})
const expression=(id:string,mode:Extract<AutomationRule['action'],{kind:'voice'}>['mode']):AutomationRule=>({
  id,enabled:true,trigger:{kind:'expression',slot:'P1',expression:'smiling',holdSec:1},
  action:{kind:'voice',slot:'P2',mode},release:'previous',revertAfterSec:null,
})
const smile={label:'smiling',smileType:null} as Parameters<RuleEngine['onExpression']>[1]
engine.setRules([expression('match','match')])
engine.onExpression('P1',smile)
ready=false;engine.tick(1000);engine.tick(2000)
assert.equal(voice.mode,'bypass','not ready: do not apply voice rule')
ready=true;engine.tick(2250)
assert.equal(voice.mode,'match')
assert.equal(voice.targetSlot,'P2')
engine.onExpression('P1',null);engine.tick(2500)
assert.equal(voice.mode,'bypass','release restores previous mode')
assert.equal(effects.P1.voiceSemitones,3,'release restores prior manual pitch')
assert.equal(effects.P1.voiceSmile,.5,'release restores prior smiling voice')
assert.deepEqual(sent.slice(-3),['match:fired:match','match:released:bypass','match:released:P1:3'])

engine.setRules([expression('detone','detone')]);engine.onExpression('P1',smile)
engine.tick(3000);engine.tick(4000)
assert.equal(voice.mode,'detone')
voice={...DEFAULT_VOICE_CONDITION,mode:'audibility'}
engine.onExpression('P1',null);engine.tick(4250)
assert.equal(voice.mode,'audibility','a later RA change must not be overwritten')

voice={...DEFAULT_VOICE_CONDITION}
effects.P2={...NEUTRAL_EFFECTS,alpha:.35}
engine.setRules([expression('pitch','lower')]);engine.onExpression('P1',smile)
engine.tick(5000);engine.tick(6000)
assert.deepEqual(effects.P2,{alpha:.35,voiceSemitones:-1,voiceSmile:0},'lower voice preserves face morph')
engine.setRules([{...expression('pitch','higher')}])
assert.deepEqual(effects.P2,{alpha:.35,voiceSemitones:0,voiceSmile:0},'editing a firing rule releases old pitch')
engine.tick(7000);engine.tick(8000)
assert.equal(effects.P2.voiceSemitones,1)
effects.P2.voiceSemitones=4
engine.onExpression('P1',null);engine.tick(8250)
assert.equal(effects.P2.voiceSemitones,4,'manual pitch edit must survive rule release')

phase='live';liveStart=9000;ready=false
engine.setRules([{id:'timer',enabled:true,trigger:{kind:'timer',atSec:2},
  action:{kind:'voice',slot:'P2',mode:'match'},release:'previous',revertAfterSec:3}])
engine.tick(11000);ready=true;engine.tick(12000)
assert.equal(voice.mode,'bypass','missed timer must not fire late when calibration becomes ready')
engine.setRules([{id:'timer2',enabled:true,trigger:{kind:'timer',atSec:4},
  action:{kind:'voice',slot:'P2',mode:'match'},release:'previous',revertAfterSec:3}])
engine.tick(13000);assert.equal(voice.mode,'match')
engine.tick(16000);assert.equal(voice.mode,'bypass','timer reverts voice condition')

phase='waiting';liveStart=null;ready=true
engine.setRules([expression('pitch-first','lower'),expression('condition-second','match')])
engine.onExpression('P1',smile)
engine.tick(17000);engine.tick(18000)
assert.equal(effects.P2.voiceSemitones,-1)
assert.equal(voice.mode,'bypass','a second voice rule cannot replace active manual pitch')
engine.onExpression('P1',null);engine.tick(18250)
engine.setRules([expression('condition-first','match'),expression('pitch-second','lower')])
engine.onExpression('P1',smile)
engine.tick(19000);engine.tick(20000)
assert.equal(voice.mode,'match')
assert.equal(effects.P2.voiceSemitones,0,'a second voice rule cannot replace active voice condition')
console.log('voice automation rules passed')
