import { build } from 'esbuild'
import { mkdir, copyFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const destination = join(root, 'renderer/public/voice')
await mkdir(destination, { recursive: true })
await build({ entryPoints: [join(root, 'renderer/audio/analysis.worker.ts')], outfile: join(destination, 'analysis.worker.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true })
await copyFile(join(root, 'renderer/audio/voice.worklet.js'), join(destination, 'voice.worklet.js'))
// Served unbundled: it stringifies its own code into the worklet, which bundler rewrites would break.
await copyFile(join(dirname(require.resolve('signalsmith-stretch')), 'SignalsmithStretch.mjs'), join(destination, 'signalsmith-stretch.mjs'))
const vad = dirname(require.resolve('@ricky0123/vad-web'))
await copyFile(join(vad, 'silero_vad_v5.onnx'), join(destination, 'silero_vad_v5.onnx'))
const ort = dirname(require.resolve('onnxruntime-web/wasm'))
for (const file of await readdir(ort)) {
  if (/^ort-wasm-simd-threaded\.(mjs|wasm)$/.test(file)) await copyFile(join(ort, file), join(destination, file))
}
console.log('Built local voice worklets, worker, and speech model.')
