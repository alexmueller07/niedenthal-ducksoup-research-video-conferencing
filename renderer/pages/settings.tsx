import { useEffect, useRef, useState } from 'react'
import {
  RefreshCw,
  FolderOpen,
  Save,
  Camera,
  Square,
  Monitor,
  Download,
  CheckCircle2,
} from 'lucide-react'
import { PageHeading } from '../components/SuiteShell'
import { APP_VERSION, DEFAULT_REVIEW_CONFIG } from '../lib/protocol'
import type { ReviewConfig } from '../lib/protocol'
import { hasIpc, ipcInvoke } from '../lib/ipcUtil'
import {
  readDevices,
  readStudy,
  readReviewDefaults,
  saveDevices,
  saveStudy,
  saveReviewDefaults,
} from '../lib/suitePreferences'
import type { DevicePreferences } from '../lib/suitePreferences'
import { checkReleaseUpdate } from '../../shared/releaseUpdate'
import type { ReleaseUpdate } from '../../shared/releaseUpdate'

export default function SettingsPage() {
  const [native, setNative] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selected, setSelected] = useState<DevicePreferences>({
    cameraId: '',
    microphoneId: '',
  })
  const [studyId, setStudyId] = useState('')
  const [review, setReview] = useState<ReviewConfig>(DEFAULT_REVIEW_CONFIG)
  const [root, setRoot] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [testing, setTesting] = useState(false)
  const [starting, setStarting] = useState(false)
  const [level, setLevel] = useState(0)
  const [update, setUpdate] = useState<ReleaseUpdate | null>(null)
  const [checking, setChecking] = useState(false)
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const audio = useRef<AudioContext | null>(null)
  const raf = useRef(0)
  const generation = useRef(0)

  function stopTest() {
    generation.current++
    cancelAnimationFrame(raf.current)
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void audio.current?.close().catch(() => {})
    audio.current = null
    if (video.current) video.current.srcObject = null
    setTesting(false)
    setStarting(false)
    setLevel(0)
  }
  async function refreshDevices() {
    if (navigator.mediaDevices)
      setDevices(await navigator.mediaDevices.enumerateDevices())
  }
  useEffect(() => {
    setNative(hasIpc())
    setSelected(readDevices())
    setStudyId(readStudy().studyId)
    void refreshDevices().catch((e) => setError(String(e)))
    void readReviewDefaults()
      .then(setReview)
      .catch((e) => setError(String(e)))
    if (hasIpc())
      void ipcInvoke<string>('suite:output-root')
        .then((value) => setRoot(value || ''))
        .catch((e) => setError(String(e)))
    const changed = () => void refreshDevices().catch(() => {})
    navigator.mediaDevices?.addEventListener('devicechange', changed)
    return () => {
      stopTest()
      navigator.mediaDevices?.removeEventListener('devicechange', changed)
    }
  }, [])

  async function testDevices() {
    stopTest()
    setError('')
    setStarting(true)
    const token = ++generation.current
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          ...(selected.cameraId
            ? { deviceId: { ideal: selected.cameraId } }
            : {}),
        },
        audio: selected.microphoneId
          ? { deviceId: { ideal: selected.microphoneId } }
          : true,
      })
      if (token !== generation.current) {
        media.getTracks().forEach((t) => t.stop())
        return
      }
      stream.current = media
      if (video.current) {
        video.current.srcObject = media
        await video.current.play()
      }
      if (token !== generation.current) {
        media.getTracks().forEach((t) => t.stop())
        return
      }
      const ctx = new AudioContext()
      audio.current = ctx
      await ctx.resume()
      if (token !== generation.current) {
        await ctx.close().catch(() => {})
        media.getTracks().forEach((t) => t.stop())
        return
      }
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      ctx.createMediaStreamSource(media).connect(analyser)
      const buffer = new Uint8Array(analyser.fftSize)
      const tick = () => {
        analyser.getByteTimeDomainData(buffer)
        let energy = 0
        for (const value of buffer) energy += ((value - 128) / 128) ** 2
        setLevel(Math.min(1, Math.sqrt(energy / buffer.length) * 4))
        raf.current = requestAnimationFrame(tick)
      }
      raf.current = requestAnimationFrame(tick)
      await refreshDevices()
      if (token === generation.current) setTesting(true)
    } catch (e) {
      if (token === generation.current) {
        stopTest()
        setError(
          `Device check failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    } finally {
      if (token === generation.current) setStarting(false)
    }
  }
  async function save() {
    setError('')
    setNote('')
    try {
      saveDevices(selected)
      saveStudy({ studyId: studyId.trim() })
      await saveReviewDefaults(review)
      setNote(
        'Settings saved. Device selections apply when the next camera or microphone starts.',
      )
    } catch (e) {
      setError(String(e))
    }
  }
  async function checkUpdates() {
    setChecking(true)
    try {
      setUpdate(
        hasIpc()
          ? await ipcInvoke<ReleaseUpdate>('suite:check-update')
          : await checkReleaseUpdate(APP_VERSION, 'browser'),
      )
    } catch {
      setUpdate({ status: 'unavailable' })
    } finally {
      setChecking(false)
    }
  }

  return (
    <main className="suite-content">
      <PageHeading
        title="Settings & Updates"
        eyebrow="Workspace preferences"
        action={
          <button className="suite-btn primary" onClick={() => void save()}>
            <Save size={16} />
            Save settings
          </button>
        }
      >
        <p>Preferences for this computer.</p>
      </PageHeading>
      {note && (
        <p role="status" className="suite-notice">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="suite-notice suite-error">
          {error}
        </p>
      )}
      <section
        className="suite-section"
        style={{ borderTop: 0, paddingTop: 0 }}
      >
        <div className="suite-row" style={{ justifyContent: 'space-between' }}>
          <h2>Application</h2>
          <span className="suite-badge">
            <Monitor size={12} />
            {native ? 'Desktop app' : 'Browser workspace'}
          </span>
        </div>
        <div className="suite-row" style={{ marginBottom: 12 }}>
          <span style={{ marginRight: 14 }}>
            Session View <span className="suite-muted">v{APP_VERSION}</span>
          </span>
          <button
            className="suite-btn"
            disabled={checking}
            onClick={() => void checkUpdates()}
          >
            <RefreshCw size={15} />
            {checking ? 'Checking...' : 'Check for updates'}
          </button>
        </div>
        {update && (
          <div className="suite-row" role="status">
            <span className="suite-muted">
              {update.status === 'up_to_date'
                ? `Up to date with published release ${update.latestVersion}.`
                : update.status === 'available'
                  ? `Version ${update.latestVersion} is available.`
                  : 'Update check unavailable. Try again when connected.'}
            </span>
            {update.status === 'available' && update.releaseUrl && (
              <a
                className="suite-btn"
                href={update.downloadUrl || update.releaseUrl}
                target="_blank"
                rel="noreferrer"
              onClick={event => {
                if (!hasIpc()) return
                event.preventDefault()
                void ipcInvoke('app:open-external', update.downloadUrl || update.releaseUrl).catch(e => setError(String(e)))
              }}
              >
                <Download size={15} />
                {update.downloadUrl ? 'Download update' : 'View release'}
              </a>
            )}
          </div>
        )}
      </section>
      <section className="suite-section">
        <div
          className="suite-row"
          style={{ justifyContent: 'space-between', marginBottom: 16 }}
        >
          <h2 style={{ margin: 0 }}>Camera & audio</h2>
          <button
            className="suite-btn icon"
            aria-label="Refresh devices"
            title="Refresh devices"
            onClick={() =>
              void refreshDevices().catch((e) => setError(String(e)))
            }
          >
            <RefreshCw size={16} />
          </button>
        </div>
        <div className="suite-form-grid">
          {(
            [
              { field: 'cameraId', kind: 'videoinput', label: 'Camera' },
              {
                field: 'microphoneId',
                kind: 'audioinput',
                label: 'Microphone',
              },
            ] as const
          ).map((d) => (
            <label className="suite-field" key={d.field}>
              <span>{d.label}</span>
              <select
                className="suite-input"
                value={selected[d.field]}
                onChange={(e) => {
                  stopTest()
                  setNote('')
                  setSelected((s) => ({ ...s, [d.field]: e.target.value }))
                }}
              >
                <option value="">System default</option>
                {devices
                  .filter((v) => v.kind === d.kind && v.deviceId)
                  .map((v, i) => (
                    <option key={v.deviceId} value={v.deviceId}>
                      {v.label || `${d.label} ${i + 1}`}
                    </option>
                  ))}
                {selected[d.field] &&
                  !devices.some((v) => v.deviceId === selected[d.field]) && (
                    <option value={selected[d.field]}>
                      Saved device unavailable · default will be used
                    </option>
                  )}
              </select>
            </label>
          ))}
        </div>
        <div className="suite-device-preview">
          <video ref={video} muted playsInline />
          <div>
            <div className="suite-row" style={{ marginBottom: 16 }}>
              <button
                className="suite-btn"
                disabled={starting}
                onClick={() => (testing ? stopTest() : void testDevices())}
              >
                {testing ? <Square size={15} /> : <Camera size={15} />}
                {starting
                  ? 'Opening devices...'
                  : testing
                    ? 'Stop device check'
                    : 'Test camera & microphone'}
              </button>
              {testing && <CheckCircle2 size={17} color="#68d1a5" />}
            </div>
            <label className="suite-field">
              <span>Microphone input</span>
              <meter
                min={0}
                max={1}
                value={level}
                aria-label="Microphone input level"
              />
            </label>
            <p className="suite-muted" style={{ fontSize: 12, marginTop: 12 }}>
              Speaker output follows the system audio device.
            </p>
          </div>
        </div>
      </section>
      <section className="suite-section">
        <h2>Study defaults</h2>
        <div className="suite-form-grid">
          <label className="suite-field">
            <span>Study ID (optional)</span>
            <input
              className="suite-input"
              value={studyId}
              onChange={(e) => {
                setStudyId(e.target.value)
                setNote('')
              }}
              placeholder="Study identifier"
            />
          </label>
          <label className="suite-field">
            <span>Review perspective</span>
            <select
              className="suite-input"
              value={review.viewMode}
              onChange={(e) => {
                setReview((r) => ({
                  ...r,
                  viewMode: e.target.value as ReviewConfig['viewMode'],
                }))
                setNote('')
              }}
            >
              <option value="active">Speaker</option>
              <option value="single">Individual</option>
              <option value="gallery">Gallery</option>
            </select>
          </label>
          <label className="suite-field">
            <span>Review segment length (seconds)</span>
            <input
              className="suite-input"
              type="number"
              min={10}
              max={1800}
              value={review.segmentSec}
              onChange={(e) => {
                setReview((r) => ({
                  ...r,
                  segmentSec: Math.min(
                    1800,
                    Math.max(10, Number(e.target.value) || 150),
                  ),
                }))
                setNote('')
              }}
            />
          </label>
          <label className="suite-field">
            <span>Advance review</span>
            <select
              className="suite-input"
              value={review.advance}
              onChange={(e) => {
                setReview((r) => ({
                  ...r,
                  advance: e.target.value as ReviewConfig['advance'],
                }))
                setNote('')
              }}
            >
              <option value="both-done">When both participants finish</option>
              <option value="auto">Automatically after the clip</option>
            </select>
          </label>
        </div>
      </section>
      <section className="suite-section">
        <h2>Export & storage</h2>
        <div className="suite-row">
          <span
            className="suite-muted"
            style={{ flex: 1, overflowWrap: 'anywhere' }}
          >
            {native
              ? root || 'Loading output folder...'
              : 'Browser recordings save to Downloads. Open a saved folder in Session Data to inspect it.'}
          </span>
          {native && (
            <button
              className="suite-btn"
              onClick={() =>
                void ipcInvoke<string>('suite:choose-output')
                  .then((value) => {
                    if (value) {
                      setRoot(value)
                      setNote('Output folder saved for future call sessions.')
                    }
                  })
                  .catch((e) => setError(String(e)))
              }
            >
              <FolderOpen size={16} />
              Choose folder
            </button>
          )}
        </div>
        <p className="suite-muted" style={{ fontSize: 12, marginTop: 15 }}>
          Recordings retain their original format. Measurements, events, and
          review responses use CSV; session summaries and calibration profiles
          use JSON.
        </p>
      </section>
    </main>
  )
}
