import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import { CaptureStation } from '../lib/capture'
import type { CalibrationProgress } from '../lib/calibrationRunner'
import {
  CalibrationPanel,
  emptyCalibrationUiState,
  type CalibrationUiState,
} from '../components/CalibrationPanel'
import { VoicePanel } from '../components/VoiceControls'
import { NORMALIZED_CLASSIFIER_VERSION } from '../lib/faceMorph'
import { VoiceFilePlayer } from '../lib/voiceFile'
import { CALIBRATION_PHASES } from '../lib/protocol'
import type { CalibrationPhase, ExpressionState } from '../lib/protocol'
import { PRESETS, getPreset, DEFAULT_PRESET_ID } from '../lib/presets'
import { DEFAULT_VOICE_CONDITION } from '../../main/voiceProtocol'
import type { VoiceCondition, VoicePairState } from '../../main/voiceProtocol'
import type {
  ConnectionStatus,
  RecordingStatus,
  SessionConfig,
  SessionManifest,
} from '../lib/types'

// Face presets go in the face section; the voice-only ones ("Lower voice" /
// "Higher voice") drive the uploaded recording in the voice section.
const VIDEO_PRESETS = PRESETS.filter((p) => p.voiceSemitones === 0 && p.voiceSmile === 0)
const VOICE_PRESETS = PRESETS.filter((p) => p.voiceSemitones !== 0 || p.voiceSmile !== 0)

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
  const [calibrationProgress, setCalibrationProgress] = useState<CalibrationProgress | null>(null)
  const [calibration, setCalibration] = useState<CalibrationUiState>(emptyCalibrationUiState)
  const [lastSaved, setLastSaved] = useState<SessionManifest | null>(null)
  // Determined after mount so the first client render matches the server-rendered
  // HTML (window.ipc only exists in Electron). Avoids a hydration mismatch.
  const [inElectron, setInElectron] = useState(false)
  useEffect(() => setInElectron(!!ipc()), [])

  // ---- Voice: an uploaded recording run through the call's voice processor ----
  const playerRef = useRef<VoiceFilePlayer | null>(null)
  const [voiceFile, setVoiceFile] = useState<string | null>(null)
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [listenTo, setListenTo] = useState<'original' | 'changed'>('changed')
  const [pitch, setPitch] = useState(0)
  const [smile, setSmile] = useState(0)
  const [voiceCondition, setVoiceCondition] = useState<VoiceCondition>({ ...DEFAULT_VOICE_CONDITION })
  const [voiceState, setVoiceState] = useState<VoicePairState | null>(null)
  const [voiceError, setVoiceError] = useState('')

  useEffect(() => {
    const player = new VoiceFilePlayer()
    player.processor.setSlot('P1')
    playerRef.current = player
    // The voice box reads the same report shape the session server builds.
    const t = setInterval(() => {
      if (!player.processor.isStarted()) return
      const report = player.processor.report()
      if (!report) return
      setVoiceState({
        condition: report.condition,
        reports: { P1: report },
        available: { P1: true, P2: false },
        pitchSynchrony: null,
        intensitySynchrony: null,
        turnCoordination: null,
        convergence: null,
        exploratoryIndex: null,
        pairedTurns: 0,
        reason: null,
      })
    }, 250)
    return () => {
      clearInterval(t)
      player.close()
    }
  }, [])

  const loadVoiceFile = async (file: File | undefined) => {
    if (!file || !playerRef.current) return
    setVoiceError('')
    try {
      await playerRef.current.load(file)
      setVoiceFile(file.name)
      setVoicePlaying(false)
    } catch {
      setVoiceError('Could not read that file. Try an .mp3, .wav or .m4a recording.')
    }
  }
  const toggleVoice = async () => {
    const player = playerRef.current
    if (!player) return
    if (voicePlaying) {
      player.stop()
      setVoicePlaying(false)
      return
    }
    player.listenTo(listenTo)
    await player.play()
    setVoicePlaying(true)
  }
  const applyVoice = (condition: VoiceCondition) => {
    setVoiceCondition(condition)
    playerRef.current?.processor.setCondition(condition)
    // A voice change and the manual pitch control can't run together.
    if (condition.mode !== 'bypass' || condition.audibility) { setPitch(0); setSmile(0) }
  }
  useEffect(() => {
    playerRef.current?.processor.setSemitones(pitch)
  }, [pitch])
  useEffect(() => {
    playerRef.current?.processor.setSmile(smile)
  }, [smile])
  useEffect(() => {
    playerRef.current?.listenTo(listenTo)
  }, [listenTo])

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
      onCalibrationProgress: (p) => setCalibrationProgress(p),
      onCalibrationPhase: (summary, screenshotDataUrl) =>
        setCalibration((prev) => {
          const phases = { ...prev.phases, [summary.phase]: summary }
          const screenshots = { ...prev.screenshots }
          if (screenshotDataUrl) screenshots[summary.phase] = screenshotDataUrl
          const anyRedo = CALIBRATION_PHASES.some((p) => phases[p]?.status === 'needs-redo')
          const allDone = CALIBRATION_PHASES.every((p) => phases[p])
          return {
            ...prev,
            currentPhase: summary.phase,
            phases,
            screenshots,
            profile: null,
            acceptedAt: undefined,
            status: anyRedo ? 'needs-redo' : allDone ? 'complete' : 'running',
          }
        }),
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
    setCalibrationProgress(null)
  }, [])

  const runCalibration = (phases: CalibrationPhase[] = CALIBRATION_PHASES) => {
    const fullRun = phases.length > 1
    setCalibration((prev) => ({
      status: 'running',
      currentPhase: phases[0] ?? null,
      // A redo replaces only the phase being retaken.
      phases: fullRun ? {} : { ...prev.phases },
      screenshots: fullRun ? {} : { ...prev.screenshots },
      profile: null,
    }))
    void stationRef.current?.runCalibration(phases)
  }

  const acceptCalibration = () => {
    const profile = stationRef.current?.acceptCalibration() ?? null
    if (!profile) return
    setCalibration((prev) => ({
      ...prev,
      status: 'accepted',
      acceptedAt: profile.acceptedAt,
      profile,
    }))
  }
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
      ? 'Starting…'
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

  const statusText =
    connection === 'connecting'
      ? 'Starting…'
      : recording === 'recording'
        ? 'Recording'
        : connection === 'connected'
          ? 'Live'
          : connection === 'error'
            ? 'Error'
            : 'Idle'
  const voiceChangeOn = voiceCondition.mode !== 'bypass' || voiceCondition.audibility

  return (
    <>
      <Head>
        <title>1-Person Test Station</title>
      </Head>

      <div className="min-h-screen bg-gray-950 text-white">
        {/* ===== Header ===== */}
        <header className="sticky top-0 z-30 border-b border-gray-800 bg-gray-950/95 backdrop-blur">
          <div className="flex flex-wrap items-center gap-4 px-5 py-3">
            <button
              type="button"
              onClick={() => void backHome()}
              disabled={recording === 'saving'}
              aria-label="Back to main screen"
              className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-semibold text-gray-200 transition hover:border-gray-600 hover:bg-gray-800 disabled:opacity-50"
            >
              <span aria-hidden="true">‹</span>
              {recording === 'saving' ? 'Saving…' : 'Back'}
            </button>
            <h1 className="text-sm font-semibold">1-Person Test Station</h1>
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${
                recording === 'recording'
                  ? 'bg-red-600/20 text-red-300 ring-red-500/40'
                  : connection === 'connected'
                    ? 'bg-emerald-600/20 text-emerald-300 ring-emerald-500/40'
                    : connection === 'error'
                      ? 'bg-red-600/20 text-red-300 ring-red-500/40'
                      : 'bg-gray-900 text-gray-400 ring-gray-800'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  recording === 'recording' ? 'animate-pulse bg-red-500' : connection === 'connected' ? 'bg-emerald-400' : 'bg-gray-600'
                }`}
              />
              {statusText}
            </span>

            <div className="ml-auto flex flex-wrap items-center gap-2">
              {inElectron ? (
                <button
                  type="button"
                  onClick={selectFolder}
                  title="Where recordings are saved"
                  className="max-w-[18rem] truncate rounded-lg bg-gray-900 px-3 py-2 text-[11px] text-gray-400 ring-1 ring-gray-800 transition hover:text-gray-200"
                >
                  {config.saveRoot ? `Saving to ${config.saveRoot}` : 'Choose output folder…'}
                </button>
              ) : (
                <span className="text-[11px] text-gray-500">Browser mode: recordings go to Downloads</span>
              )}
              {recording !== 'recording' ? (
                <button
                  type="button"
                  disabled={!formValid || busy}
                  onClick={start}
                  title={formValid ? undefined : 'Choose an output folder first'}
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold transition enabled:hover:bg-emerald-500 disabled:opacity-40"
                >
                  {startLabel}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void stop()}
                  className="flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-2 text-sm font-semibold text-red-200 ring-1 ring-red-500/40 transition hover:bg-gray-700"
                >
                  <span className="h-2 w-2 rounded-full bg-red-500" /> Stop · {fmt(recTime)}
                </button>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-5xl space-y-4 p-4">
          <section className="overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/60">
            {/* Video */}
            <div className="grid grid-cols-1 gap-px bg-gray-800 md:grid-cols-2">
              <div className="relative aspect-video bg-black">
                <video ref={cleanRef} autoPlay playsInline muted className="h-full w-full -scale-x-100 object-cover" />
                <span className="absolute left-2 top-2 rounded-lg bg-emerald-600 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide">
                  Clean
                </span>
              </div>
              <div ref={alteredWrapRef} className="relative aspect-video bg-black">
                <canvas ref={alteredRef} className="h-full w-full -scale-x-100 object-cover" />
                <span className="absolute left-2 top-2 rounded-lg bg-violet-600 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide">
                  Altered (partner sees)
                </span>
                <button
                  type="button"
                  onClick={goFullscreen}
                  className="absolute bottom-2 right-2 rounded-lg bg-black/60 px-2.5 py-1 text-[10px] font-semibold text-gray-300 backdrop-blur transition hover:text-white"
                >
                  Fullscreen
                </button>
                {connection === 'connected' && (
                  <span
                    className={`absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur ${
                      faceFound ? 'bg-emerald-600/30 text-emerald-300' : 'bg-amber-600/30 text-amber-300'
                    }`}
                  >
                    {faceFound ? 'face tracked' : 'no face'}
                  </span>
                )}
                {connection !== 'connected' && !calibrationProgress && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-600">
                    Press Start to turn on the camera
                  </div>
                )}
                {calibrationProgress && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-1.5 bg-gray-950/80 p-4 text-center backdrop-blur-sm">
                    <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-sky-300">
                      {calibrationProgress.stage === 'recording'
                        ? 'Hold it'
                        : calibrationProgress.stage === 'settling'
                          ? 'Recorded'
                          : 'Get ready'}
                    </p>
                    <p className="text-base font-semibold">{calibrationProgress.title}</p>
                    <p className="max-w-[34ch] text-sm text-gray-300">{calibrationProgress.instruction}</p>
                    {calibrationProgress.stage !== 'settling' && (
                      <p className="text-4xl font-bold tabular-nums">{calibrationProgress.secondsLeft}</p>
                    )}
                    <p className="text-[11px] text-gray-500">
                      Step {calibrationProgress.index} of {calibrationProgress.total}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Face */}
            <div className="border-b border-gray-800 p-4">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Face</p>
              <Slider
                label="Smile"
                hint={alpha > 0.02 ? 'lifted' : alpha < -0.02 ? 'dampened' : 'neutral'}
                min={-1}
                max={1}
                step={0.05}
                value={alpha}
                neutral={0}
                format={(v) => `α ${v.toFixed(2)}`}
                onChange={setAlpha}
              />
              <Pills
                items={VIDEO_PRESETS.map((p) => ({ id: p.id, label: p.label, title: p.description }))}
                active={config.presetId}
                onPick={applyPreset}
              />

              <div
                className={`mt-3 flex items-center justify-between gap-3 rounded-xl border p-3 ${
                  expression?.label === 'smiling' && expression.smileTypeTrusted === false
                    ? 'border-amber-500/30 bg-amber-500/5'
                    : 'border-gray-800 bg-gray-950/45'
                }`}
              >
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Detected expression</p>
                  <p className="mt-0.5 text-sm font-semibold">{expressionText}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5 text-[10px] text-gray-400">
                  <span className="rounded-full bg-gray-800 px-2 py-0.5">
                    {typeof expressionConfidence === 'number' ? `${Math.round(expressionConfidence * 100)}% confidence` : 'no reading yet'}
                  </span>
                  <span className="rounded-full bg-gray-800 px-2 py-0.5">
                    {expression?.classifierVersion === NORMALIZED_CLASSIFIER_VERSION ? 'Calibrated' : 'Calibration not done'}
                  </span>
                </div>
              </div>

              <CalibrationPanel
                state={calibration}
                runtime={undefined}
                enabled={connection === 'connected'}
                disabledReason="start first"
                onRun={() => runCalibration()}
                onRedo={(phase) => runCalibration([phase])}
                onAccept={acceptCalibration}
                showFigures={false}
              />

            </div>

            {/* Voice */}
            <div className="p-4">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Voice</p>
              <div className="rounded-xl border border-gray-800 bg-gray-950/45 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="cursor-pointer rounded-lg bg-sky-600 px-3 py-1.5 text-[11px] font-semibold transition hover:bg-sky-500">
                    {voiceFile ? 'Change recording' : 'Upload a recording'}
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => void loadVoiceFile(e.target.files?.[0])}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={!voiceFile}
                    onClick={() => void toggleVoice()}
                    className="rounded-lg bg-gray-800 px-3 py-1.5 text-[11px] font-semibold text-gray-200 transition enabled:hover:bg-gray-700 disabled:opacity-40"
                  >
                    {voicePlaying ? 'Stop' : 'Play'}
                  </button>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-gray-500">
                    {voiceFile ?? 'About a minute of natural talking with pauses works best. It loops.'}
                  </span>
                  <div className="flex overflow-hidden rounded-lg bg-gray-800 text-[10px] font-semibold" role="group" aria-label="Listen to">
                    {(['original', 'changed'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setListenTo(k)}
                        className={`px-2.5 py-1 uppercase tracking-wide transition ${
                          listenTo === k
                            ? k === 'changed'
                              ? 'bg-violet-600 text-white'
                              : 'bg-emerald-600 text-white'
                            : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
                {voiceError && <p className="mt-2 text-[10.5px] text-red-300">{voiceError}</p>}
              </div>

              <div className="mt-3">
                <Slider
                  label="Voice pitch"
                  hint={pitch > 0.02 ? 'higher' : pitch < -0.02 ? 'lower' : 'neutral'}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={pitch}
                  neutral={0}
                  disabled={voiceChangeOn}
                  format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)} st`}
                  onChange={setPitch}
                />
                <Slider
                  label="Smiling voice"
                  hint={smile > 0.02 ? 'smiling' : smile < -0.02 ? 'darker' : 'neutral'}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={smile}
                  neutral={0}
                  disabled={voiceChangeOn}
                  format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(2)}`}
                  onChange={setSmile}
                />
              </div>
              <Pills
                items={VOICE_PRESETS.map((p) => ({ id: p.id, label: p.label, title: p.description }))}
                active={VOICE_PRESETS.find((p) => Math.abs(p.voiceSemitones - pitch) < 0.011 && Math.abs(p.voiceSmile - smile) < 0.011)?.id ?? null}
                disabled={voiceChangeOn}
                onPick={(id) => {
                  setPitch(getPreset(id).voiceSemitones)
                  setSmile(getPreset(id).voiceSmile)
                }}
              />

              <VoicePanel
                solo
                slot="P1"
                state={voiceState}
                connected
                participantConnected={!!voiceFile}
                phase="waiting"
                error=""
                onApply={applyVoice}
                onReset={() => {
                  playerRef.current?.processor.resetCalibration()
                  applyVoice({ ...DEFAULT_VOICE_CONDITION })
                }}
              />
            </div>
          </section>

          {/* Output */}
          <section className="rounded-2xl border border-gray-800 bg-gray-900/60 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Output</p>
            {lastSaved ? (
              <div className="mt-2 text-xs">
                <p className="text-gray-200">
                  {lastSaved.sessionLabel} · {lastSaved.preset.label} · {lastSaved.durationSec}s
                </p>
                {lastSaved.files.map((f) => (
                  <p key={f.kind} className="font-mono text-[11px] text-gray-500">
                    {f.kind}: {f.filename} ({(f.bytes / 1048576).toFixed(1)} MB)
                  </p>
                ))}
                {inElectron && (
                  <button
                    type="button"
                    onClick={() => ipc()?.invoke('shell:open-path', lastSaved.files[0]?.path.replace(/[/\\][^/\\]+$/, ''))}
                    className="mt-2 rounded-lg bg-gray-800 px-3 py-1.5 text-[11px] text-gray-300 transition hover:bg-gray-700"
                  >
                    Open session folder
                  </button>
                )}
              </div>
            ) : (
              <p className="mt-2 text-[11px] text-gray-500">
                Each session saves a clean video, an altered video, and a session.json file.
              </p>
            )}
          </section>
        </main>

        <video ref={hiddenRef} autoPlay playsInline muted style={{ position: 'absolute', width: 2, height: 2, opacity: 0, pointerEvents: 'none' }} />
      </div>
    </>
  )
}

function Slider({
  label,
  hint,
  min,
  max,
  step,
  value,
  neutral,
  disabled = false,
  format,
  onChange,
}: {
  label: string
  hint: string
  min: number
  max: number
  step: number
  value: number
  neutral: number
  disabled?: boolean
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  const isNeutral = Math.abs(value - neutral) < step / 2
  return (
    <div className={disabled ? 'opacity-40' : undefined}>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="font-medium text-gray-300">
          {label} <span className="text-gray-600">· {hint}</span>
        </span>
        <span className="flex items-center gap-2 font-mono tabular-nums text-gray-400">
          {format(value)}
          {!isNeutral && !disabled && (
            <button
              type="button"
              onClick={() => onChange(neutral)}
              className="rounded bg-gray-800 px-1.5 text-[10px] text-gray-400 transition hover:text-white"
            >
              reset
            </button>
          )}
        </span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full ${isNeutral ? 'accent-gray-500' : 'accent-violet-500'}`}
      />
    </div>
  )
}

function Pills({
  items,
  active,
  disabled = false,
  onPick,
}: {
  items: Array<{ id: string; label: string; title: string }>
  active: string | null
  disabled?: boolean
  onPick: (id: string) => void
}) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {items.map((p) => (
        <button
          key={p.id}
          type="button"
          title={p.title}
          disabled={disabled}
          onClick={() => onPick(p.id)}
          className={
            'rounded-full px-2.5 py-1 text-[11px] transition disabled:opacity-40 ' +
            (active === p.id ? 'bg-violet-600 text-white' : 'bg-gray-800 text-gray-300 enabled:hover:bg-gray-700')
          }
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}
