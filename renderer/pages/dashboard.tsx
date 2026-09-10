import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { CaptureStation } from '../lib/capture'
import type { ExpressionState } from '../lib/protocol'
import { PRESETS, getPreset, DEFAULT_PRESET_ID } from '../lib/presets'
import type {
  ConnectionStatus,
  RecordingStatus,
  SessionConfig,
  SessionManifest,
} from '../lib/types'

// This page is video-only, so presets whose only effect is a voice-pitch
// change (e.g. "Lower voice" / "Higher voice") would silently do nothing here
// while keeping a misleading label — leave them out of the picker.
const VIDEO_PRESETS = PRESETS.filter((p) => p.voiceSemitones === 0)

function ipc() {
  return typeof window !== 'undefined'
    ? (window as unknown as { ipc?: { invoke: <T>(c: string, a?: unknown) => Promise<T> } }).ipc
    : undefined
}

export default function DashboardPage() {
  const router = useRouter()
  const cleanRef = useRef<HTMLVideoElement>(null)
  const alteredRef = useRef<HTMLCanvasElement>(null)
  const hiddenRef = useRef<HTMLVideoElement>(null)
  const alteredWrapRef = useRef<HTMLDivElement>(null)
  const stationRef = useRef<CaptureStation | null>(null)

  const [config, setConfig] = useState<SessionConfig>({
    presetId: DEFAULT_PRESET_ID,
    saveRoot: null,
  })
  const preset = getPreset(config.presetId)
  const [alpha, setAlpha] = useState(preset.alpha)

  const [connection, setConnection] = useState<ConnectionStatus>('disconnected')
  const [recording, setRecording] = useState<RecordingStatus>('idle')
  const [recTime, setRecTime] = useState(0)
  const [faceFound, setFaceFound] = useState(false)
  const [expression, setExpression] = useState<ExpressionState | null>(null)
  const [calibrationStatus, setCalibrationStatus] = useState<string | null>(null)
  const [lastSaved, setLastSaved] = useState<SessionManifest | null>(null)
  // Determined after mount so the first client render matches the server-rendered
  // HTML (window.ipc only exists in Electron). Avoids a hydration mismatch.
  const [inElectron, setInElectron] = useState(false)
  useEffect(() => setInElectron(!!ipc()), [])

  // Build the capture station once the DOM nodes exist.
  useEffect(() => {
    if (!cleanRef.current || !alteredRef.current || !hiddenRef.current) return
    const station = new CaptureStation(cleanRef.current, alteredRef.current, hiddenRef.current, {
      onStatus: (c, r) => {
        setConnection(c)
        setRecording(r)
      },
      onLog: () => {},
      onTime: (s) => setRecTime(s),
      onSaved: (m) => setLastSaved(m),
      onFaceState: (f) => setFaceFound(f),
      onExpression: (e) => setExpression(e),
      onCalibrationStatus: (t) => setCalibrationStatus(t),
    })
    stationRef.current = station
    return () => station.stop()
  }, [])

  // Load persisted config (Electron only) — just the preset and output folder now.
  useEffect(() => {
    ipc()
      ?.invoke<SessionConfig | null>('config:get')
      .then((saved) => {
        if (saved) setConfig((c) => ({ ...c, ...saved }))
      })
      .catch(() => {})
  }, [])

  // Push live changes to the engine.
  useEffect(() => {
    stationRef.current?.setAlpha(alpha)
  }, [alpha])

  const applyPreset = (id: string) => {
    const p = getPreset(id)
    setConfig((c) => ({ ...c, presetId: id }))
    setAlpha(p.alpha)
  }

  const selectFolder = async () => {
    const folder = await ipc()?.invoke<string | null>('dialog:select-folder')
    if (folder) setConfig((c) => ({ ...c, saveRoot: folder }))
  }

  const start = () => {
    setExpression(null)
    setLastSaved(null)
    stationRef.current?.setConfig(config)
    stationRef.current?.setAlpha(alpha)
    void stationRef.current?.start()
    ipc()?.invoke('config:set', config).catch(() => {})
  }
  const stop = useCallback(async () => {
    await stationRef.current?.stopRecording()
    stationRef.current?.stop()
    setExpression(null)
    setCalibrationStatus(null)
  }, [])
  const backHome = async () => {
    if (recording === 'saving') return
    if (recording === 'recording' || connection === 'connected' || connection === 'connecting') {
      const ok = window.confirm(
        'Return home? This will stop the active session on this machine, saving the videos first if recording.',
      )
      if (!ok) return
      await stop()
    }
    void router.push('/')
  }

  const goFullscreen = () => {
    alteredWrapRef.current?.requestFullscreen?.().catch(() => {})
  }

  const formValid = !inElectron || !!config.saveRoot
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  const busy = connection === 'connecting' || recording === 'recording' || recording === 'saving'
  const startLabel =
    connection === 'connecting'
      ? calibrationStatus ?? 'Starting…'
      : recording === 'saving'
        ? 'Saving…'
        : 'Start'

  const expressionText =
    expression?.label === 'smiling'
      ? expression.smileType && expression.smileTypeTrusted
        ? `smiling · ${expression.smileType}`
        : 'smiling · uncertain'
      : expression?.label ?? 'waiting'
  const expressionConfidence =
    expression?.label === 'smiling' && typeof expression.smileTypeConfidence === 'number'
      ? expression.smileTypeConfidence
      : expression?.labelConfidence

  return (
    <>
      <Head>
        <title>1-Person Test Station</title>
      </Head>

      <div className="app">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="back"
              type="button"
              onClick={() => void backHome()}
              disabled={recording === 'saving'}
              aria-label="Back to main screen"
            >
              <span aria-hidden="true">‹</span>
              {recording === 'saving' ? 'Saving…' : 'Back'}
            </button>
            <div className="title">
              1-Person Test Station
            </div>
          </div>
          <div className="status">
            <span className={`dot ${connection}`} />
            {connection === 'connecting' ? calibrationStatus ?? 'Starting…' : recording === 'recording' ? 'Recording' : connection === 'connected' ? 'Live' : connection === 'error' ? 'Error' : 'Idle'}
            {connection === 'connected' && (
              <span className={`face ${faceFound ? 'ok' : 'no'}`}>
                {faceFound ? 'face tracked' : 'no face'}
              </span>
            )}
          </div>
        </header>

        <div className="body">
          {/* Left controls */}
          <aside className="panel">
            <section>
              <h2>Output</h2>
              {inElectron ? (
                <label className="folder">Output folder
                  <button className="ghost" onClick={selectFolder}>{config.saveRoot ? config.saveRoot : 'Select folder…'}</button>
                </label>
              ) : (
                <p className="note">Browser mode. Recordings download to your Downloads folder. Use the desktop app to save them into folders instead.</p>
              )}
            </section>

            <section>
              <h2>Modification condition</h2>
              <div className="presets">
                {VIDEO_PRESETS.map((p) => (
                  <button key={p.id} className={`preset ${config.presetId === p.id ? 'active' : ''}`} onClick={() => applyPreset(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="desc">{preset.description}</p>

              <div className="slider">
                <div className="slider-head"><span>Smile (face)</span><span className="val">{alpha.toFixed(2)}</span></div>
                <input type="range" min={-0.75} max={0.75} step={0.05} value={alpha} onChange={(e) => setAlpha(parseFloat(e.target.value))} />
                <div className="ticks"><span>Frown</span><span>Neutral</span><span>Smile</span></div>
              </div>
            </section>
          </aside>

          {/* Center: video + operation */}
          <main className="main">
            <div className="videos">
              <div className="vid">
                <div className="vid-label">Clean (unaltered)</div>
                <video ref={cleanRef} autoPlay playsInline muted />
              </div>
              <div className="vid" ref={alteredWrapRef}>
                <div className="vid-label">Altered (participant sees this)</div>
                <canvas ref={alteredRef} />
                <button className="fs" onClick={goFullscreen} title="Participant fullscreen">Fullscreen</button>
              </div>
            </div>

            <div className="ops">
              <div
                className={`detect ${expression?.label === 'smiling' && expression.smileTypeTrusted === false ? 'uncertain' : ''}`}
              >
                <div>
                  <span className="detect-label">Detected expression</span>
                  <span className="detect-value">{expressionText}</span>
                </div>
                <div className="detect-meta">
                  <span>{typeof expressionConfidence === 'number' ? `${Math.round(expressionConfidence * 100)}% confidence` : 'no reading yet'}</span>
                  <span>{expression?.classifierMode ?? 'classifier idle'}</span>
                  {expression?.classifierVersion && <span>{expression.classifierVersion}</span>}
                </div>
              </div>

              {recording !== 'recording' ? (
                <button className="primary" disabled={!formValid || busy} onClick={start}>
                  {startLabel}
                </button>
              ) : (
                <button className="recording" onClick={() => void stop()}>
                  <span className="recdot" /> Stop · {fmt(recTime)}
                </button>
              )}
            </div>

            {!formValid && (
              <p className="warn">Select an output folder to start.</p>
            )}

            <section className="output">
              <h2>Output → questionnaire pipeline</h2>
              {lastSaved ? (
                <div className="saved">
                  <div className="saved-head">{lastSaved.sessionLabel} · {lastSaved.preset.label} · {lastSaved.durationSec}s</div>
                  {lastSaved.files.map((f) => (
                    <div key={f.kind} className="file">{f.kind}: {f.filename} ({(f.bytes / 1048576).toFixed(1)} MB)</div>
                  ))}
                  {inElectron && (
                    <button className="ghost small" onClick={() => ipc()?.invoke('shell:open-path', lastSaved.files[0]?.path.replace(/[/\\][^/\\]+$/, ''))}>
                      Open session folder
                    </button>
                  )}
                </div>
              ) : (
                <p className="note">Each session saves a clean video, an altered video, and a session.json file.</p>
              )}
            </section>
          </main>
        </div>

        <video ref={hiddenRef} autoPlay playsInline muted style={{ position: 'absolute', width: 2, height: 2, opacity: 0, pointerEvents: 'none' }} />
      </div>

      <style jsx>{`
        .app { display: flex; flex-direction: column; height: 100vh; background: #0e1116; color: #d7dbe0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
        .topbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: #161a21; border-bottom: 1px solid #232831; }
        .topbar-left { display: flex; align-items: center; gap: 14px; min-width: 0; }
        .back { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px 0 9px; background: #1d232c; border: 1px solid #2e3642; border-radius: 7px; color: #c7ccd3; font-size: 12px; font-weight: 600; cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease; }
        .back span { font-size: 20px; line-height: 1; margin-top: -1px; }
        .back:hover { background: #242b36; border-color: #3b6fb0; color: #f1f5f9; }
        .back:focus-visible { outline: 2px solid #3b6fb0; outline-offset: 2px; }
        .title { font-size: 15px; font-weight: 600; letter-spacing: 0.2px; }
        .version { margin-left: 12px; font-size: 12px; font-weight: 400; color: #7d8794; }
        .status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #aab2bd; }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #6b7280; }
        .dot.connected { background: #3fa66a; }
        .dot.connecting { background: #d4a13a; }
        .dot.error { background: #c2554f; }
        .face { font-size: 11px; padding: 2px 7px; border-radius: 4px; }
        .face.ok { background: #1d3b2a; color: #6fce9a; }
        .face.no { background: #3b2424; color: #d99; }

        .body { display: flex; flex: 1; overflow: hidden; }
        .panel { width: 340px; padding: 16px; overflow-y: auto; border-right: 1px solid #232831; }
        .panel section { margin-bottom: 24px; }
        h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b94a1; margin: 0 0 12px; font-weight: 600; }

        label { display: block; font-size: 12px; color: #9aa3af; }
        .folder { margin-top: 0; }
        .ghost { width: 100%; margin-top: 4px; text-align: left; padding: 7px 9px; background: #1a1f27; border: 1px solid #2a313b; border-radius: 6px; color: #c7ccd3; font-size: 12px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .ghost:hover { border-color: #3b6fb0; }
        .ghost.small { width: auto; margin-top: 10px; }
        .note { font-size: 12px; color: #79828f; line-height: 1.5; margin: 8px 0 0; }

        .presets { display: flex; flex-direction: column; gap: 6px; }
        .preset { text-align: left; padding: 8px 11px; background: #1a1f27; border: 1px solid #2a313b; border-radius: 6px; color: #c7ccd3; font-size: 13px; cursor: pointer; }
        .preset:hover { border-color: #394454; }
        .preset.active { background: #1b2c44; border-color: #3b6fb0; color: #cfe0f5; }
        .desc { font-size: 12px; color: #79828f; margin: 10px 0 16px; line-height: 1.5; }

        .slider { margin-bottom: 18px; }
        .slider-head { display: flex; justify-content: space-between; font-size: 12px; color: #9aa3af; margin-bottom: 6px; }
        .slider-head .val { font-variant-numeric: tabular-nums; color: #cfe0f5; }
        .slider input[type='range'] { width: 100%; accent-color: #3b6fb0; }
        .ticks { display: flex; justify-content: space-between; font-size: 10px; color: #5f6873; margin-top: 3px; }

        .main { flex: 1; padding: 16px 20px; overflow-y: auto; }
        .videos { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .vid { position: relative; background: #000; border: 1px solid #232831; border-radius: 8px; overflow: hidden; aspect-ratio: 16 / 9; }
        .vid video, .vid canvas { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
        .vid-label { position: absolute; top: 8px; left: 8px; z-index: 2; font-size: 11px; padding: 3px 8px; background: rgba(0,0,0,0.55); border-radius: 4px; color: #cdd3da; }
        .fs { position: absolute; bottom: 8px; right: 8px; z-index: 2; font-size: 11px; padding: 4px 9px; background: rgba(0,0,0,0.55); border: 1px solid #3a4250; border-radius: 5px; color: #cdd3da; cursor: pointer; }
        .fs:hover { background: rgba(0,0,0,0.8); }

        .ops { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 16px 0 6px; }
        .detect { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 42px; flex: 1 1 420px; padding: 9px 12px; background: #121923; border: 1px solid #263343; border-radius: 8px; color: #cfe0f5; }
        .detect.uncertain { background: #20190d; border-color: #5d4520; color: #f1d49b; }
        .detect-label { display: block; margin-bottom: 2px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #778392; }
        .detect-value { font-size: 14px; font-weight: 650; }
        .detect-meta { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; font-size: 11px; color: #8f9aaa; }
        .detect-meta span { padding: 2px 7px; border-radius: 999px; background: #1b222c; white-space: nowrap; }
        .detect.uncertain .detect-meta span { background: #2b2113; color: #d7b979; }
        .ops button { padding: 10px 18px; border-radius: 7px; font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid transparent; }
        .primary { background: #2f6fc0; color: #fff; }
        .primary:hover { background: #3a7cd0; }
        .primary:disabled { background: #2a323d; color: #6b7480; cursor: not-allowed; }
        .recording { background: #2a313b; color: #f0d2d0; border-color: #5a3a38; display: flex; align-items: center; gap: 8px; }
        .recdot { width: 9px; height: 9px; border-radius: 50%; background: #e0524b; }
        .warn { font-size: 12px; color: #d2a24a; margin: 4px 0; }

        .output { margin-top: 22px; border-top: 1px solid #232831; padding-top: 16px; }
        .saved-head { font-size: 13px; color: #cfe0f5; margin-bottom: 6px; }
        .file { font-size: 12px; color: #8b94a1; font-variant-numeric: tabular-nums; }
      `}</style>
    </>
  )
}
