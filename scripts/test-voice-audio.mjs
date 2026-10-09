import { build } from 'esbuild'
import { chromium } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'
import assert from 'node:assert/strict'

const root=resolve(import.meta.dirname,'..'),out=join(root,'scratchpad/voice-qa')
await mkdir(out,{recursive:true})
await build({entryPoints:[join(root,'tests/voice_audio_harness.ts')],outfile:join(out,'harness.js'),
  bundle:true,format:'esm',platform:'browser',target:'es2022'})
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost').pathname
  if(url==='/'){res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/harness.js"></script>');return}
  const file=url.startsWith('/voice/')?join(root,'renderer/public',url):join(out,url)
  if(!file.startsWith(out)&&!file.startsWith(join(root,'renderer/public/voice'))){res.writeHead(403).end();return}
  try {const data=await readFile(file);res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.wasm':'application/wasm','.wav':'audio/wav'})[extname(file)]??'application/octet-stream');res.end(data)}
  catch {res.writeHead(404).end()}
})
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']})
const results={tones:[],identity:[],alignment:[],runtime:null,manual:null,errors:[]}
let failed
try {
  const page=await browser.newPage()
  page.on('pageerror',e=>results.errors.push(String(e)))
  page.on('console',m=>{if(m.type()==='error')console.error(m.text())})
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(()=>!!window.voiceQA)
  if(process.env.VOICE_QA_SWEEP==='1') {
    for(const p of [[30,8],[40,10],[50,12],[60,15]]) {
      for(const hz of [90,200,300])for(const shift of [-.75,.75]) {
        const stretch={blockMs:p[0],intervalMs:p[1]}
        const result=await page.evaluate(({hz,shift,stretch})=>window.voiceQA.render(48000,hz,shift,.1,stretch),{hz,shift,stretch})
        console.log(JSON.stringify({...result,stretch}))
      }
    }
  }
  for(const rate of [44100,48000]) {
    results.identity.push(await page.evaluate(rate=>window.voiceQA.limiterIdentity(rate),rate))
    results.alignment.push(await page.evaluate(rate=>window.voiceQA.alignment(rate),rate))
    for(const hz of [90,200,300])for(const shift of [-.75,0,.75]) {
      const result=await page.evaluate(({rate,hz,shift})=>window.voiceQA.render(rate,hz,shift),{rate,hz,shift})
      results.tones.push(result);console.log(JSON.stringify(result))
    }
    // Smiling voice moves the vocal resonances, never the pitch.
    for(const hz of [90,200])results.tones.push(await page.evaluate(({rate,hz})=>window.voiceQA.render(rate,hz,0,.1,undefined,1.5),{rate,hz}))
  }
  const seconds=Number(process.env.VOICE_QA_SECONDS??150)
  results.manual=await page.evaluate(()=>window.voiceQA.manualPitch())
  assert.ok(results.manual.micLevel>.02,`Raw microphone level lost during voice processing: ${JSON.stringify(results.manual)}`)
  for(const r of results.manual.samples) {
    assert.equal(r.health.state,'ready',JSON.stringify(r.health));assert.ok(r.clarity>.8)
    assert.ok(Math.abs(r.applied-r.requested)<.01,`Manual control failed: ${JSON.stringify(r)}`)
    assert.ok(Math.abs(r.errorCents)<25,`Rendered manual pitch failed: ${JSON.stringify(r)}`)
  }
  assert.ok(Math.abs(results.manual.bypass)<.001)
  if(seconds>0) {
    console.log(`Running real-time speech test for ${seconds}s`)
    results.runtime=await page.evaluate(seconds=>window.voiceQA.realtime(seconds),seconds)
    console.log(JSON.stringify({conditionApplied:results.runtime.conditionApplied,last:results.runtime.samples.at(-1)}))
  }
  for(const r of results.identity)assert.ok(r.error<1e-6,'Neutral limiter must be identity apart from known delay')
  for(const r of results.alignment) {
    assert.ok(r.latencyMs<=60.5,`Shifter delay over the 60 ms budget: ${JSON.stringify(r)}`)
    assert.ok(Math.abs(r.wetOnsetMs-r.dryOnsetMs)<5,`Dry and shifted paths must line up: ${JSON.stringify(r)}`)
  }
  for(const r of results.tones) {
    assert.equal(r.nonfinite,0);assert.ok(r.peak<=10**(-3/20)+1e-6)
    assert.ok(r.errorCents!==null&&Math.abs(r.errorCents)<20,`Pitch accuracy failed: ${JSON.stringify(r)}`)
  }
  if(results.runtime) {
    assert.ok(results.runtime.samples.some(r=>r.health.state==='ready'),'Worker must initialize')
    assert.ok(!results.runtime.samples.some(r=>r.health.state==='failed'),'Audio must not fall back unexpectedly')
    assert.ok(results.runtime.conditionApplied,'Real speech must reach usable baseline')
    assert.ok(results.runtime.samples.some(r=>r.applied.active),'Condition must actually become active')
    assert.ok(results.runtime.samples.every(r=>r.applied.gainDb>=-2.01&&r.applied.gainDb<=2.01),'Actual gain must stay inside safety bounds')
    assert.ok(results.runtime.samples.every(r=>Math.abs(r.applied.pitchSemitones)<=.751),'Actual pitch must stay inside safety bounds')
    assert.ok(Math.abs(results.runtime.bypass.applied.pitchSemitones)<.001,'Bypass must reset pitch')
  }
  assert.deepEqual(results.errors,[])
}catch(e){failed=e}finally{
  await writeFile(join(out,'audio-results.json'),JSON.stringify(results,null,2))
  await browser.close();await new Promise(r=>server.close(r))
}
if(failed)throw failed
console.log(`Voice DSP tests passed; evidence in ${out}`)
