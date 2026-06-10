import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import { CaptureStation } from '../lib/capture'
import { PRESETS, getPreset, DEFAULT_PRESET_ID } from '../lib/presets'
import type {
  ConnectionStatus,
  RecordingStatus,
  SessionConfig,
  SessionManifest,
} from '../lib/types'

type LogEntry = { ts: string; message: string; level: string }

function ipc() {
  return typeof window !== 'undefined'
    ? (window as unknown as { ipc?: { invoke: <T>(c: string, a?: unknown) => Promise<T> } }).ipc
    : undefined
}

export default function DashboardPage() {
  const cleanRef = useRef<HTMLVideoElement>(null)
  const alteredRef = useRef<HTMLCanvasElement>(null)
  const hiddenRef = useRef<HTMLVideoElement>(null)
  const alteredWrapRef = useRef<HTMLDivElement>(null)
  const stationRef = useRef<CaptureStation | null>(null)

  const [config, setConfig] = useState<SessionConfig>({
    studyId: 'PPS2026',
    dyadId: '',
    participantId: '',
    partnerId: '',
    raName: '',
    presetId: DEFAULT_PRESET_ID,
    saveRoot: null,
  })
  const preset = getPreset(config.presetId)
  const [alpha, setAlpha] = useState(preset.alpha)
  const [voice, setVoice] = useState(preset.voiceSemitones)
  const [overlay, setOverlay] = useState(false)

  const [connection, setConnection] = useState<ConnectionStatus>('disconnected')
  const [recording, setRecording] = useState<RecordingStatus>('idle')
  const [recTime, setRecTime] = useState(0)
  const [faceFound, setFaceFound] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [lastSaved, setLastSaved] = useState<SessionManifest | null>(null)
  // Determined after mount so the first client render matches the server-rendered
  // HTML (window.ipc only exists in Electron). Avoids a hydration mismatch.
  const [inElectron, setInElectron] = useState(false)
  useEffect(() => setInElectron(!!ipc()), [])

  const addLog = useCallback((message: string, level = 'info') => {
    setLogs((p) => [{ ts: new Date().toLocaleTimeString(), message, level }, ...p].slice(0, 80))
  }, [])

  // Build the capture station once the DOM nodes exist.
  useEffect(() => {
    if (!cleanRef.current || !alteredRef.current || !hiddenRef.current) return
    const station = new CaptureStation(cleanRef.current, alteredRef.current, hiddenRef.current, {
      onStatus: (c, r) => {
        setConnection(c)
        setRecording(r)
      },
      onLog: (m, l) => addLog(m, l),
      onTime: (s) => setRecTime(s),
      onSaved: (m) => {
        setLastSaved(m)
        addLog('Session saved', 'success')
      },
      onFaceState: (f) => setFaceFound(f),
    })
    stationRef.current = station
    return () => station.stop()
  }, [addLog])

  // Load persisted config (Electron only).
  useEffect(() => {
    ipc()
      ?.invoke<SessionConfig | null>('config:get')
      .then((saved) => {
        if (saved) setConfig((c) => ({ ...c, ...saved, dyadId: '', participantId: '', partnerId: '' }))
      })
      .catch(() => {})
  }, [])

  // Push live changes to the engine.
  useEffect(() => {
    stationRef.current?.setAlpha(alpha)
  }, [alpha])
  useEffect(() => {
    stationRef.current?.setVoiceSemitones(voice)
  }, [voice])
  useEffect(() => {
    stationRef.current?.setOverlay(overlay)
  }, [overlay])

  const applyPreset = (id: string) => {
    const p = getPreset(id)
    setConfig((c) => ({ ...c, presetId: id }))
    setAlpha(p.alpha)
    setVoice(p.voiceSemitones)
  }

  const selectFolder = async () => {
    const folder = await ipc()?.invoke<string | null>('dialog:select-folder')
    if (folder) setConfig((c) => ({ ...c, saveRoot: folder }))
  }

  const startCapture = () => {
    stationRef.current?.setConfig(config)
    stationRef.current?.setAlpha(alpha)
    stationRef.current?.setVoiceSemitones(voice)
    void stationRef.current?.start()
    ipc()?.invoke('config:set', config).catch(() => {})
  }
  const stopCapture = () => stationRef.current?.stop()
  const startRec = () => stationRef.current?.startRecording()
  const stopRec = () => void stationRef.current?.stopRecording()

  const goFullscreen = () => {
    alteredWrapRef.current?.requestFullscreen?.().catch(() => {})
  }

  const formValid = config.dyadId.trim() && config.participantId.trim() && config.raName.trim() && (!inElectron || config.saveRoot)
  const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  const statusText: Record<ConnectionStatus, string> = {
    disconnected: 'Idle',
    connecting: 'Starting…',
    connected: 'Live',
    error: 'Error',
  }

  return (
    <>
      <Head>
        <title>DuckSoup Capture Station</title>
      </Head>

      <div className="app">
        <header className="topbar">
          <div className="title">
            DuckSoup Capture Station
            <span className="version">Niedenthal Emotions Lab</span>
          </div>
          <div className="status">
            <span className={`dot ${connection}`} />
            {statusText[connection]}
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
              <h2>Session</h2>
              <div className="grid2">
                <label>Study<input value={config.studyId} onChange={(e) => setConfig({ ...config, studyId: e.target.value })} /></label>
                <label>RA<input value={config.raName} onChange={(e) => setConfig({ ...config, raName: e.target.value })} /></label>
                <label>Dyad ID<input value={config.dyadId} onChange={(e) => setConfig({ ...config, dyadId: e.target.value })} /></label>
                <label>Participant ID<input value={config.participantId} onChange={(e) => setConfig({ ...config, participantId: e.target.value })} /></label>
                <label>Partner ID<input value={config.partnerId} onChange={(e) => setConfig({ ...config, partnerId: e.target.value })} /></label>
              </div>
              {inElectron ? (
                <label className="folder">Output folder
                  <button className="ghost" onClick={selectFolder}>{config.saveRoot ? config.saveRoot : 'Select folder…'}</button>
                </label>
              ) : (
                <p className="note">Browser mode: recordings download to your Downloads folder. Run the desktop app for structured saving.</p>
              )}
            </section>

            <section>
              <h2>Modification condition</h2>
              <div className="presets">
                {PRESETS.map((p) => (
                  <button key={p.id} className={`preset ${config.presetId === p.id ? 'active' : ''}`} onClick={() => applyPreset(p.id)}>
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="desc">{preset.description}</p>

              <div className="slider">
                <div className="slider-head"><span>Smile (face)</span><span className="val">{alpha.toFixed(2)}</span></div>
                <input type="range" min={-2} max={5} step={0.1} value={alpha} onChange={(e) => setAlpha(parseFloat(e.target.value))} />
                <div className="ticks"><span>Frown</span><span>Neutral</span><span>Smile</span></div>
              </div>

              <div className="slider">
                <div className="slider-head"><span>Voice pitch</span><span className="val">{voice > 0 ? '+' : ''}{voice} st</span></div>
                <input type="range" min={-8} max={8} step={1} value={voice} onChange={(e) => setVoice(parseInt(e.target.value))} />
                <div className="ticks"><span>Lower</span><span>Neutral</span><span>Higher</span></div>
              </div>

              <label className="check">
                <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
                Show tracking overlay
              </label>
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
              {connection !== 'connected' ? (
                <button className="primary" disabled={!formValid || connection === 'connecting'} onClick={startCapture}>
                  {connection === 'connecting' ? 'Starting…' : 'Start capture'}
                </button>
              ) : (
                <button className="secondary" onClick={stopCapture}>Stop capture</button>
              )}

              {recording !== 'recording' ? (
                <button className="record" disabled={connection !== 'connected' || recording === 'saving'} onClick={startRec}>
                  {recording === 'saving' ? 'Saving…' : 'Start recording'}
                </button>
              ) : (
                <button className="recording" onClick={stopRec}>
                  <span className="recdot" /> Stop · {fmt(recTime)}
                </button>
              )}
            </div>

            {!formValid && (
              <p className="warn">Enter Dyad ID, Participant ID, RA{inElectron ? ', and select an output folder' : ''} to start.</p>
            )}

            <section className="output">
              <h2>Output → questionnaire pipeline</h2>
              {lastSaved ? (
                <div className="saved">
                  <div className="saved-head">{lastSaved.config.dyadId} / p{lastSaved.config.participantId} · {lastSaved.preset.label} · {lastSaved.durationSec}s</div>
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
                <p className="note">Each session writes a clean video, an altered video, and a session.json manifest the questionnaire app reads.</p>
              )}
            </section>

            <section className="log">
              <div className="log-head"><h2>Event log</h2><button className="link" onClick={() => setLogs([])}>Clear</button></div>
              <div className="log-body">
                {logs.length === 0 && <p className="note">No events yet.</p>}
                {logs.map((l, i) => (
                  <div key={i} className={`logline ${l.level}`}>[{l.ts}] {l.message}</div>
                ))}
              </div>
            </section>
          </main>
        </div>

        <video ref={hiddenRef} autoPlay playsInline muted style={{ position: 'absolute', width: 2, height: 2, opacity: 0, pointerEvents: 'none' }} />
      </div>

      <style jsx>{`
        .app { display: flex; flex-direction: column; height: 100vh; background: #0e1116; color: #d7dbe0; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
        .topbar { display: flex; justify-content: space-between; align-items: center; padding: 12px 20px; background: #161a21; border-bottom: 1px solid #232831; }
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

        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        label { display: block; font-size: 12px; color: #9aa3af; }
        input[type='text'], input:not([type]) { width: 100%; margin-top: 4px; padding: 7px 9px; background: #1a1f27; border: 1px solid #2a313b; border-radius: 6px; color: #e4e7eb; font-size: 13px; }
        input:focus { outline: none; border-color: #3b6fb0; }
        .folder { margin-top: 12px; }
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
        .check { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #aab2bd; }
        .check input { width: auto; }

        .main { flex: 1; padding: 16px 20px; overflow-y: auto; }
        .videos { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .vid { position: relative; background: #000; border: 1px solid #232831; border-radius: 8px; overflow: hidden; aspect-ratio: 16 / 9; }
        .vid video, .vid canvas { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
        .vid-label { position: absolute; top: 8px; left: 8px; z-index: 2; font-size: 11px; padding: 3px 8px; background: rgba(0,0,0,0.55); border-radius: 4px; color: #cdd3da; }
        .fs { position: absolute; bottom: 8px; right: 8px; z-index: 2; font-size: 11px; padding: 4px 9px; background: rgba(0,0,0,0.55); border: 1px solid #3a4250; border-radius: 5px; color: #cdd3da; cursor: pointer; }
        .fs:hover { background: rgba(0,0,0,0.8); }

        .ops { display: flex; gap: 10px; margin: 16px 0 6px; }
        .ops button { padding: 10px 18px; border-radius: 7px; font-size: 14px; font-weight: 500; cursor: pointer; border: 1px solid transparent; }
        .primary { background: #2f6fc0; color: #fff; }
        .primary:hover { background: #3a7cd0; }
        .primary:disabled { background: #2a323d; color: #6b7480; cursor: not-allowed; }
        .secondary { background: #2a313b; color: #d7dbe0; border-color: #39424f; }
        .record { background: #b14a44; color: #fff; }
        .record:hover { background: #c2554f; }
        .record:disabled { background: #2a323d; color: #6b7480; cursor: not-allowed; }
        .recording { background: #2a313b; color: #f0d2d0; border-color: #5a3a38; display: flex; align-items: center; gap: 8px; }
        .recdot { width: 9px; height: 9px; border-radius: 50%; background: #e0524b; }
        .warn { font-size: 12px; color: #d2a24a; margin: 4px 0; }

        .output, .log { margin-top: 22px; border-top: 1px solid #232831; padding-top: 16px; }
        .saved-head { font-size: 13px; color: #cfe0f5; margin-bottom: 6px; }
        .file { font-size: 12px; color: #8b94a1; font-variant-numeric: tabular-nums; }
        .log-head { display: flex; justify-content: space-between; align-items: center; }
        .link { background: none; border: none; color: #6b7480; font-size: 11px; cursor: pointer; }
        .log-body { max-height: 180px; overflow-y: auto; font-family: ui-monospace, 'Cascadia Code', monospace; font-size: 11px; line-height: 1.6; }
        .logline.error { color: #d98a85; }
        .logline.warn { color: #d2a24a; }
        .logline.success { color: #6fce9a; }
        .logline.info { color: #8b94a1; }
      `}</style>
    </>
  )
}
