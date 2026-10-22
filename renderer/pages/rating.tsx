import { useEffect, useRef, useState } from 'react'
import {
  Film,
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Upload,
  Check,
} from 'lucide-react'
import { PageHeading } from '../components/SuiteShell'

type Seat = 'P1' | 'P2'
type Version = 'altered' | 'clean'
type ClipKey = `${Seat}_${Version}`
type Clip = { url: string; name: string; duration: number }
type View = 'gallery' | 'single' | 'active'
const CLIP_KEYS: ClipKey[] = [
  'P1_altered',
  'P1_clean',
  'P2_altered',
  'P2_clean',
]
const timeLabel = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`

export default function RatingStationPage() {
  const [clips, setClips] = useState<Partial<Record<ClipKey, Clip>>>({})
  const [mode, setMode] = useState<View>('active')
  const [target, setTarget] = useState<Seat>('P1')
  const [version, setVersion] = useState<Version>('altered')
  const [perspective, setPerspective] = useState<'self' | 'partner'>('self')
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [segmentSec, setSegmentSec] = useState(150)
  const [segment, setSegment] = useState(0)
  const [responses, setResponses] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState('')
  const [error, setError] = useState('')
  const players = useRef(new Map<ClipKey, HTMLVideoElement>())
  const probes = useRef(new Map<ClipKey, HTMLVideoElement>())
  const urls = useRef(new Set<string>())
  const duration = Math.min(
    ...Object.values(clips)
      .filter((c) => c.duration > 0)
      .map((c) => c.duration),
    Infinity,
  )
  const total = Number.isFinite(duration) ? duration : 0
  const start = segment * segmentSec
  const end = Math.min(total, start + segmentSec)
  const key = `${segment}:${target}:${version}:${perspective}`
  const shownSeats: Seat[] =
    mode === 'gallery'
      ? ['P1', 'P2']
      : [mode === 'single' ? (target === 'P1' ? 'P2' : 'P1') : target]
  const shownKeys = shownSeats.map((seat) => `${seat}_${version}` as ClipKey)
  const master = shownKeys.find((k) => !!clips[k])

  function pause() {
    for (const video of players.current.values()) video.pause()
    setPlaying(false)
  }
  function seek(next: number) {
    const value = Math.max(start, Math.min(end, next))
    for (const video of players.current.values()) video.currentTime = value
    setPosition(value)
  }
  useEffect(
    () => () => {
      for (const video of probes.current.values()) {
        video.onloadedmetadata = null
        video.onerror = null
        video.removeAttribute('src')
        video.load()
      }
      urls.current.forEach((url) => URL.revokeObjectURL(url))
    },
    [],
  )
  useEffect(() => {
    pause()
    for (const video of players.current.values())
      if (video.readyState > 0) video.currentTime = start
    setPosition(start)
  }, [mode, version, target, segment, segmentSec])

  function loadClip(clipKey: ClipKey, file: File | undefined) {
    if (!file) return
    pause()
    setError('')
    setSegment(0)
    setPosition(0)
    setResponses({})
    setSaved('')
    const previousProbe = probes.current.get(clipKey)
    if (previousProbe) {
      previousProbe.onloadedmetadata = null
      previousProbe.onerror = null
      previousProbe.removeAttribute('src')
      previousProbe.load()
    }
    const previous = clips[clipKey]
    if (previous) {
      URL.revokeObjectURL(previous.url)
      urls.current.delete(previous.url)
    }
    const url = URL.createObjectURL(file)
    urls.current.add(url)
    setClips((prev) => ({
      ...prev,
      [clipKey]: { url, name: file.name, duration: 0 },
    }))
    // Read metadata even when this seat/version is not visible.
    const probe = document.createElement('video')
    probes.current.set(clipKey, probe)
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => {
      const seconds = probe.duration
      setClips((prev) =>
        prev[clipKey]?.url === url
          ? {
              ...prev,
              [clipKey]: {
                ...prev[clipKey]!,
                duration: Number.isFinite(seconds) ? seconds : 0,
              },
            }
          : prev,
      )
      if (!Number.isFinite(seconds))
        setError(
          'This recording has no usable duration. Use a finalized recording.',
        )
      probe.removeAttribute('src')
      probe.onloadedmetadata = null
      probe.onerror = null
      probe.load()
      probes.current.delete(clipKey)
    }
    probe.onerror = () => {
      setError(`Could not load ${file.name}. Choose a playable MP4 or WebM.`)
      probe.onloadedmetadata = null
      probe.onerror = null
      probe.removeAttribute('src')
      probe.load()
      probes.current.delete(clipKey)
    }
    probe.src = url
  }
  async function togglePlayback() {
    setError('')
    if (playing) {
      pause()
      return
    }
    if (position >= end) seek(start)
    try {
      await Promise.all([...players.current.values()].map((v) => v.play()))
      setPlaying(true)
    } catch {
      pause()
      setError('Playback could not start. Check the selected recording.')
    }
  }

  return (
    <main className="suite-content">
      <PageHeading
        title="Rating Station"
        eyebrow="Post-call review"
        action={<span className="suite-badge preview">Temporary preview</span>}
      >
        <p>Conversation playback and participant responses.</p>
      </PageHeading>
      <p className="suite-notice">
        Temporary preview. Questions are provisional; responses clear when you
        leave this section.
      </p>
      {error && (
        <p role="alert" className="suite-notice suite-error">
          {error}
        </p>
      )}
      <section
        className="suite-section"
        style={{ paddingTop: 0, borderTop: 0 }}
      >
        <div
          className="suite-row"
          style={{ justifyContent: 'space-between', marginBottom: 20 }}
        >
          <div
            className="suite-tabs"
            role="tablist"
            aria-label="Review perspective"
            style={{ margin: 0 }}
          >
            {(
              [
                { id: 'active', label: 'Speaker' },
                { id: 'single', label: 'Individual' },
                { id: 'gallery', label: 'Gallery' },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                role="tab"
                aria-selected={mode === v.id}
                onClick={() => setMode(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
          <div className="suite-row">
            <label className="suite-field">
              <span>Review turn</span>
              <select
                aria-label="Review turn"
                className="suite-input"
                value={target}
                onChange={(e) => setTarget(e.target.value as Seat)}
              >
                <option value="P1">Participant 1</option>
                <option value="P2">Participant 2</option>
              </select>
            </label>
            <label className="suite-field">
              <span>Recording version</span>
              <select
                aria-label="Recording version"
                className="suite-input"
                value={version}
                onChange={(e) => setVersion(e.target.value as Version)}
              >
                <option value="altered">Altered</option>
                <option value="clean">Unaltered</option>
              </select>
            </label>
          </div>
        </div>
        <div className="suite-review-layout">
          <div style={{ minWidth: 0 }}>
            <div
              className="suite-player-grid"
              style={{
                gridTemplateColumns:
                  mode === 'gallery' ? undefined : 'minmax(0, 1fr)',
              }}
            >
              {shownSeats.map((seat) => {
                const clipKey = `${seat}_${version}` as ClipKey
                const clip = clips[clipKey]
                return (
                  <div className="suite-player" key={clipKey}>
                    <header>
                      <span>
                        {seat === 'P1' ? 'Participant 1' : 'Participant 2'}
                      </span>
                      <span>
                        {version === 'clean' ? 'Unaltered' : 'Altered'}
                      </span>
                    </header>
                    {clip ? (
                      <video
                        ref={(el) => {
                          if (el) players.current.set(clipKey, el)
                          else players.current.delete(clipKey)
                        }}
                        src={clip.url}
                        playsInline
                        preload="metadata"
                        muted={clipKey !== master}
                        onLoadedMetadata={(e) => {
                          e.currentTarget.currentTime = start
                        }}
                        onError={() => setError(`Cannot play ${clip.name}.`)}
                        onTimeUpdate={(e) => {
                          if (clipKey !== master) return
                          const now = e.currentTarget.currentTime
                          setPosition(now)
                          for (const [id, video] of players.current)
                            if (
                              id !== master &&
                              Math.abs(video.currentTime - now) > 0.15
                            )
                              video.currentTime = now
                          if (now >= end && end > start) pause()
                        }}
                        onEnded={() => pause()}
                      />
                    ) : (
                      <div
                        className="suite-empty"
                        style={{
                          border: 0,
                          borderRadius: 0,
                          aspectRatio: '16/9',
                          minHeight: 0,
                        }}
                      >
                        <Film size={30} />
                        <p>
                          No {version === 'clean' ? 'unaltered' : 'altered'}{' '}
                          recording loaded
                        </p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="suite-row" style={{ marginTop: 16 }}>
              <button
                className="suite-btn icon"
                title="Replay segment"
                aria-label="Replay segment"
                disabled={!master || !total}
                onClick={() => {
                  pause()
                  seek(start)
                }}
              >
                <RotateCcw size={16} />
              </button>
              <button
                className="suite-btn primary"
                disabled={!master || !total}
                onClick={() => void togglePlayback()}
              >
                {playing ? <Pause size={16} /> : <Play size={16} />}
                {playing ? 'Pause' : 'Play'}
              </button>
              <input
                aria-label="Playback position"
                type="range"
                min={start}
                max={Math.max(start, end)}
                step={0.1}
                value={Math.min(
                  Math.max(position, start),
                  Math.max(start, end),
                )}
                disabled={!master || !total}
                onChange={(e) => seek(Number(e.target.value))}
                style={{ flex: 1, minWidth: 100, accentColor: '#22b4df' }}
              />
              <span
                className="suite-muted"
                style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}
              >
                {timeLabel(position)} / {timeLabel(total)}
              </span>
            </div>
            <div
              className="suite-row"
              style={{ justifyContent: 'space-between', marginTop: 20 }}
            >
              <div className="suite-row">
                <button
                  className="suite-btn icon"
                  aria-label="Previous segment"
                  title="Previous segment"
                  disabled={segment === 0}
                  onClick={() => setSegment((s) => s - 1)}
                >
                  <SkipBack size={16} />
                </button>
                <span className="suite-muted">
                  Segment {segment + 1}
                  {total > 0 ? ` of ${Math.ceil(total / segmentSec)}` : ''}
                </span>
                <button
                  className="suite-btn icon"
                  aria-label="Next segment"
                  title="Next segment"
                  disabled={!total || end >= total}
                  onClick={() => setSegment((s) => s + 1)}
                >
                  <SkipForward size={16} />
                </button>
              </div>
              <label className="suite-row suite-muted" style={{ fontSize: 12 }}>
                Segment length
                <select
                  className="suite-input"
                  style={{ width: 100 }}
                  value={segmentSec}
                  onChange={(e) => {
                    setSegmentSec(Number(e.target.value))
                    setSegment(0)
                  }}
                >
                  <option value={30}>30 sec</option>
                  <option value={60}>60 sec</option>
                  <option value={150}>150 sec</option>
                </select>
              </label>
            </div>
          </div>
          <aside>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 18 }}>
              Participant response
            </h2>
            <div className="suite-tabs" aria-label="Response perspective">
              {(['self', 'partner'] as const).map((p) => (
                <button
                  key={p}
                  aria-pressed={perspective === p}
                  onClick={() => setPerspective(p)}
                >
                  {p === 'self' ? 'Self-report' : 'Partner rating'}
                </button>
              ))}
            </div>
            <label className="suite-field">
              <span>
                {perspective === 'self'
                  ? 'What were you feeling during this part?'
                  : `What do you think Participant ${target === 'P1' ? '1' : '2'} was feeling?`}
              </span>
              <textarea
                className="suite-input"
                placeholder="Write a response..."
                value={responses[key] || ''}
                onChange={(e) => {
                  setResponses((r) => ({ ...r, [key]: e.target.value }))
                  setSaved('')
                }}
              />
            </label>
            <button
              className="suite-btn primary"
              style={{ marginTop: 14 }}
              disabled={!responses[key]?.trim()}
              onClick={() => setSaved(key)}
            >
              <Check size={15} />
              Save preview response
            </button>
            {saved === key && (
              <p
                role="status"
                className="suite-muted"
                style={{ fontSize: 12, marginTop: 10 }}
              >
                Saved for this preview.
              </p>
            )}
          </aside>
        </div>
      </section>
      <section className="suite-section">
        <h2>Review recordings</h2>
        <div className="suite-form-grid">
          {CLIP_KEYS.map((clipKey) => (
            <label className="suite-field" key={clipKey}>
              <span>
                {clipKey.slice(0, 2)} ·{' '}
                {clipKey.endsWith('clean') ? 'Unaltered' : 'Altered'}
              </span>
              <span
                className="suite-btn"
                style={{
                  justifyContent: 'flex-start',
                  whiteSpace: 'normal',
                  overflowWrap: 'anywhere',
                }}
              >
                <Upload size={15} style={{ flexShrink: 0 }} />
                {clips[clipKey]?.name || 'Choose recording'}
                <input
                  type="file"
                  accept="video/mp4,video/webm"
                  className="sr-only"
                  onChange={(e) => {
                    loadClip(clipKey, e.target.files?.[0])
                    e.target.value = ''
                  }}
                  aria-label={`Load ${clipKey}`}
                />
              </span>
            </label>
          ))}
        </div>
      </section>
    </main>
  )
}
