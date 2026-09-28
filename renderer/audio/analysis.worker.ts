import * as ort from 'onnxruntime-web/wasm'
import { PitchDetector } from 'pitchy'
import { Resampler } from '@ricky0123/vad-web/dist/resampler'

const scope = self as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: MessageEvent) => void) | null }
let session: ort.InferenceSession
let state: ort.Tensor
let sr: ort.Tensor
let resampler: Resampler
let detector: PitchDetector<Float32Array>
let rate = 48000
let busy = false
let dropped = 0
let probability = 0

function acoustic(samples: Float32Array) {
  let square = 0, peak = 0, clips = 0
  for (const n of samples) { square += n * n; peak = Math.max(peak, Math.abs(n)); if (Math.abs(n) >= .999) clips++ }
  const [hz, clarity] = detector.findPitch(samples, rate)
  return {
    rmsDbfs: 20 * Math.log10(Math.max(1e-8, Math.sqrt(square / samples.length))),
    peakDbfs: 20 * Math.log10(Math.max(1e-8, peak)),
    f0Hz: clarity >= .8 && hz >= 50 && hz <= 700 ? hz : null,
    pitchClarity: clarity, clippingRate: clips / samples.length,
  }
}

scope.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      rate = data.sampleRate
      ort.env.wasm.numThreads = 1
      ort.env.wasm.wasmPaths = data.assets
      session = await ort.InferenceSession.create(`${data.assets}silero_vad_v5.onnx`, { executionProviders: ['wasm'] })
      state = new ort.Tensor('float32', new Float32Array(256), [2, 1, 128])
      sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(16000)]), [1])
      resampler = new Resampler({ nativeSampleRate: rate, targetSampleRate: 16000, targetFrameSize: 512 })
      detector = PitchDetector.forFloat32Array(2048)
      scope.postMessage({ type: 'ready' })
    } catch (error) { scope.postMessage({ type: 'error', message: String(error) }) }
    return
  }
  if (!session || data.type !== 'frame') return
  if (busy) { dropped++; return }
  busy = true
  try {
    for (const frame of resampler.process(data.clean)) {
      const input = new ort.Tensor('float32', frame, [1, frame.length])
      const result = await session.run({ input, state, sr })
      probability = Number(result.output.data[0])
      state.dispose()
      state = result.stateN
      input.dispose()
      result.output.dispose()
    }
    scope.postMessage({ type: 'features', at: data.at, audioTime: data.audioTime,
      durationMs: data.clean.length / rate * 1000, clean: acoustic(data.clean), altered: acoustic(data.altered),
      speechProbability: probability, dropped })
  } catch (error) { scope.postMessage({ type: 'error', message: String(error) }) }
  finally { busy = false }
}
