import { DEFAULT_VOICE_CONDITION, VOICE_VERSION } from '../main/voiceProtocol'
import type { VoiceReport, VoiceFeatures, VoiceTurn } from '../main/voiceProtocol'
import { IDENTITY_VOICE } from '../renderer/lib/voiceAnalysis'

export const features = (): VoiceFeatures => ({ speechActive:true,speechProbability:.95,rmsDbfs:-24,peakDbfs:-12,
  relativeIntensityDb:0,f0Hz:200,f0Semitones:12,relativePitchZ:0,pitchClarity:.98,
  rollingPitchRangeSt:4,rollingIntensityRangeDb:8,voicedFraction:.6,noiseFloorDbfs:-60,clippingRate:0 })
export const turn = (id=1, at=Date.now()): VoiceTurn => ({id,startedAt:at-4000,endedAt:at,durationMs:4000,voicedMs:3000,
  pauseFraction:.1,meanPitchSt:12,pitchRangeSt:4,meanIntensityDbfs:-24,intensityRangeDb:8,
  relativePitchZ:0,relativeIntensityDb:0,pitchRangeRatio:1,intensityRangeRatio:1,valid:true})
export const report = (): VoiceReport => ({version:VOICE_VERSION,sequence:1,capturedAt:Date.now(),clockUncertaintyMs:5,
  clean:features(),altered:features(),calibration:{state:'strong',confidence:1,voicedSeconds:50,validTurns:8,
    baselinePitchSt:12,baselinePitchRangeSt:4,baselineIntensityDbfs:-24,baselineIntensityRangeDb:8,
    noiseFloorDbfs:-60,snrDb:36,frozen:true,reason:null},condition:{...DEFAULT_VOICE_CONDITION},applied:{...IDENTITY_VOICE},
  health:{state:'ready',reason:null,engineVersion:'test',analysisDroppedFrames:0,underruns:0,bufferedMs:0,
    measuredLatencyMs:null,sampleRate:48000},turns:[],settings:{sampleRate:48000,channelCount:1,autoGainControl:false}})
