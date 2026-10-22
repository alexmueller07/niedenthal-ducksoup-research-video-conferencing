import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import {
  Camera,
  Image as ImageIcon,
  Play,
  Square,
  ArrowRight,
  FlaskConical,
} from 'lucide-react'
import { PageHeading } from '../components/SuiteShell'
import { LiveEffects } from '../lib/effects'
import { PRESETS } from '../lib/presets'
import type { Telemetry } from '../lib/protocol'

const FACES = [
  {
    id: 'straight',
    label: 'Neutral example',
    url: '/images/test-faces/straight.png',
  },
  {
    id: 'reward',
    label: 'Reward example',
    url: '/images/test-faces/reward.jpg',
  },
  {
    id: 'affiliative',
    label: 'Affiliative example',
    url: '/images/test-faces/affiliative.jpg',
  },
  {
    id: 'dominance',
    label: 'Dominance example',
    url: '/images/test-faces/dominance.jpg',
  },
  { id: 'frown', label: 'Frown example', url: '/images/test-faces/frown.png' },
]
const FACE_PRESETS = PRESETS.filter((p) => !p.voiceSemitones && !p.voiceSmile)

export default function TestingStationPage() {
  const [selected, setSelected] = useState(FACES[0])
  const [alpha, setAlpha] = useState(0)
  const [starting, setStarting] = useState(false)
  const [running, setRunning] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState('')
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)
  const [sample, setSample] =
    useState<ReturnType<LiveEffects['sampleForCalibration']>>(null)
  const effects = useRef<LiveEffects | null>(null)
  const clean = useRef<HTMLVideoElement>(null)
  const altered = useRef<HTMLVideoElement>(null)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)
  const generation = useRef(0)

  function stop() {
    generation.current++
    if (tick.current) clearInterval(tick.current)
    tick.current = null
    effects.current?.stop()
    effects.current = null
    if (clean.current) clean.current.srcObject = null
    if (altered.current) altered.current.srcObject = null
    setRunning(false)
    setStarting(false)
    setTelemetry(null)
    setSample(null)
  }
  useEffect(() => () => stop(), [])
  useEffect(() => {
    effects.current?.setAlpha(alpha)
  }, [alpha])

  async function start() {
    stop()
    setStarting(true)
    setError('')
    const token = ++generation.current
    const pipeline = new LiveEffects()
    effects.current = pipeline
    try {
      await pipeline.start(
        (message, level) => {
          if (token !== generation.current || message.startsWith('TEST MODE:'))
            return
          if (level === 'warn' || level === 'error') setError(message)
        },
        { testFaceUrl: selected.url },
      )
      if (token !== generation.current) {
        pipeline.stop()
        return
      }
      pipeline.setAlpha(alpha)
      if (clean.current) {
        clean.current.srcObject = pipeline.cleanStream
        await clean.current.play()
      }
      if (altered.current) {
        altered.current.srcObject = pipeline.alteredStream
        await altered.current.play()
      }
      if (token !== generation.current) {
        pipeline.stop()
        return
      }
      setRunning(true)
      tick.current = setInterval(() => {
        setTelemetry(pipeline.telemetry())
        setSample(pipeline.sampleForCalibration(performance.now()))
      }, 500)
    } catch (e) {
      if (token === generation.current) {
        stop()
        setError(String(e))
      }
    } finally {
      if (token === generation.current) setStarting(false)
    }
  }
  async function selectFace(face: (typeof FACES)[number]) {
    setSwitching(true)
    try {
      await effects.current?.setTestFaceImage(face.url)
      setSelected(face)
    } catch (e) {
      setError(String(e))
    } finally {
      setSwitching(false)
    }
  }

  return (
    <main className="suite-content">
      <PageHeading
        title="Testing Station"
        eyebrow="Internal checks"
        action={
          <span className="suite-badge">
            <FlaskConical size={12} />
            Testing workspace
          </span>
        }
      >
        <p>Face, voice, and calibration checks before a session.</p>
      </PageHeading>
      <div className="suite-test-tiles">
        <Link
          className="suite-launcher tone-cyan"
          style={{ minHeight: 160 }}
          href="/dashboard"
        >
          <div className="suite-row">
            <Camera size={22} color="#72d5ea" />
            <h2 style={{ margin: 0 }}>Live camera & voice</h2>
          </div>
          <p>
            Morph presets, voice previews, recording, and calibration
            diagnostics.
          </p>
          <span className="suite-open">
            Open one-person station <ArrowRight size={16} />
          </span>
        </Link>
        <a
          className="suite-launcher tone-amber"
          style={{ minHeight: 160 }}
          href="#sample-face-check"
        >
          <div className="suite-row">
            <ImageIcon size={22} color="#dfbe81" />
            <h2 style={{ margin: 0 }}>Sample-face check</h2>
          </div>
          <p>
            Bundled faces with the call's live morph and expression pipeline.
          </p>
          <span className="suite-open">
            Open sample faces <ArrowRight size={16} />
          </span>
        </a>
      </div>
      <section
        id="sample-face-check"
        className="suite-section"
        style={{ marginTop: 30, scrollMarginTop: 20 }}
      >
        <div className="suite-row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Sample-face check</h2>
          <button
            className="suite-btn primary"
            disabled={starting}
            onClick={() => (running ? stop() : void start())}
          >
            {running ? <Square size={15} /> : <Play size={15} />}
            {starting
              ? 'Loading face model...'
              : running
                ? 'Stop preview'
                : 'Start preview'}
          </button>
        </div>
        <div className="suite-sample-faces">
          {FACES.map((face) => (
            <button
              key={face.id}
              disabled={starting || switching}
              aria-pressed={face.id === selected.id}
              onClick={() => void selectFace(face)}
            >
              <img src={face.url} alt={face.label} />
              <span>{face.label}</span>
            </button>
          ))}
        </div>
        {error && (
          <p role="alert" className="suite-notice suite-error">
            {error}
          </p>
        )}
        <div className="suite-player-grid">
          {[
            { ref: clean, label: 'Unaltered' },
            { ref: altered, label: 'Altered' },
          ].map((v) => (
            <div className="suite-player" key={v.label}>
              <header>
                {v.label}
                <span>{running ? selected.label : 'Preview stopped'}</span>
              </header>
              <video ref={v.ref} muted playsInline poster={selected.url} />
            </div>
          ))}
        </div>
        <div
          className="suite-tabs"
          style={{ marginTop: 20 }}
          aria-label="Sample morph presets"
        >
          {FACE_PRESETS.map((p) => (
            <button
              key={p.id}
              aria-pressed={alpha === p.alpha}
              disabled={!running}
              onClick={() => setAlpha(p.alpha)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label className="suite-field">
          <span>
            Morph strength{' '}
            <strong
              style={{ float: 'right', fontVariantNumeric: 'tabular-nums' }}
            >
              {alpha.toFixed(2)}
            </strong>
          </span>
          <input
            aria-label="Sample morph strength"
            type="range"
            min={-1}
            max={1}
            step={0.01}
            value={alpha}
            disabled={!running}
            onChange={(e) => setAlpha(Number(e.target.value))}
            style={{ accentColor: '#35c5df', width: '100%' }}
          />
        </label>
        <details style={{ marginTop: 25 }}>
          <summary
            style={{ cursor: 'pointer', color: '#a2b2c7', fontSize: 13 }}
          >
            Tracking & calibration diagnostics
          </summary>
          <div className="suite-table-wrap" style={{ marginTop: 12 }}>
            <table className="suite-table">
              <tbody>
                <tr>
                  <th>Tracking</th>
                  <td>
                    {telemetry
                      ? telemetry.faceFound
                        ? 'Face tracked'
                        : 'No face tracked'
                      : '--'}
                  </td>
                  <th>Frame rate</th>
                  <td>{telemetry ? `${telemetry.fps} fps` : '--'}</td>
                </tr>
                <tr>
                  <th>Detected expression</th>
                  <td>{telemetry?.expression?.label || '--'}</td>
                  <th>Label confidence</th>
                  <td>
                    {telemetry?.expression?.labelConfidence != null
                      ? `${Math.round(telemetry.expression.labelConfidence * 100)}%`
                      : '--'}
                  </td>
                </tr>
                <tr>
                  <th>Smile / frown scores</th>
                  <td>
                    {telemetry?.expression
                      ? `${telemetry.expression.smile.toFixed(3)} / ${telemetry.expression.frown.toFixed(3)}`
                      : '--'}
                  </td>
                  <th>Calibration</th>
                  <td>Uncalibrated sample · default geometry</td>
                </tr>
                <tr>
                  <th>Applied morph</th>
                  <td>{telemetry?.calibration?.appliedAlpha ?? '--'}</td>
                  <th>Sample available</th>
                  <td>{sample ? 'Yes' : 'No'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </main>
  )
}
