// The calibration strip that sits under a participant's video.
//
// Shows the four measured phases as thumbnails with the numbers that matter
// under each — or "Not calibrated" when the participant has not been through
// it yet — plus the buttons to run it, redo a single phase, and accept.
//
// Shared by the researcher dashboard (one per seat) and the 1-person test
// station (one, for whoever is at the keyboard), so both modes show the same
// thing and a change here cannot land in only one of them.

import { CALIBRATION_PROMPTS, QUALITY_FLAG_LABELS } from '../lib/calibration'
import { CALIBRATION_PHASES } from '../lib/protocol'
import type {
  CalibrationPhase,
  CalibrationPhaseSummary,
  CalibrationProfile,
  CalibrationRuntimeState,
} from '../lib/protocol'

export type CalibrationUiStatus = 'idle' | 'running' | 'needs-redo' | 'complete' | 'accepted'

export interface CalibrationUiState {
  status: CalibrationUiStatus
  currentPhase: CalibrationPhase | null
  phases: Partial<Record<CalibrationPhase, CalibrationPhaseSummary>>
  screenshots: Partial<Record<CalibrationPhase, string>>
  profile: CalibrationProfile | null
  acceptedAt?: string
  /** Reported by the participant with each phase; the researcher can't know it. */
  camera?: { width: number; height: number }
}

export function emptyCalibrationUiState(): CalibrationUiState {
  return { status: 'idle', currentPhase: null, phases: {}, screenshots: {}, profile: null }
}

/** Every phase measured and none flagged — the bar for accepting. */
export function calibrationComplete(state: CalibrationUiState): boolean {
  return CALIBRATION_PHASES.every((phase) => state.phases[phase]?.status === 'ok')
}

export function CalibrationPanel({
  state,
  runtime,
  enabled,
  disabledReason,
  onRun,
  onRedo,
  onAccept,
}: {
  state: CalibrationUiState
  runtime?: CalibrationRuntimeState
  enabled: boolean
  disabledReason?: string
  onRun: () => void
  onRedo: (phase: CalibrationPhase) => void
  onAccept: () => void
}) {
  const measured = Object.keys(state.phases).length > 0
  const canAccept = enabled && calibrationComplete(state) && state.status !== 'accepted'
  const flags = Array.from(
    new Set(CALIBRATION_PHASES.flatMap((phase) => state.phases[phase]?.qualityFlags ?? [])),
  )

  return (
    <div className="mt-3 rounded-xl border border-gray-800 bg-gray-950/45 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          Calibration
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${statusClass(
            state.status,
            enabled,
          )}`}
        >
          {enabled ? statusText(state) : (disabledReason ?? 'offline')}
        </span>
      </div>

      {!measured ? (
        <p className="mt-2 rounded-lg bg-gray-900/70 px-3 py-4 text-center text-[11px] text-gray-500">
          Not calibrated
        </p>
      ) : (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {CALIBRATION_PHASES.map((phase) => (
            <PhaseThumb
              key={phase}
              phase={phase}
              summary={state.phases[phase]}
              screenshot={state.screenshots[phase]}
              neutral={state.phases.neutral}
              enabled={enabled}
              onRedo={() => onRedo(phase)}
            />
          ))}
        </div>
      )}

      {state.profile && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px]">
          <Figure
            label="Smile reach"
            value={`${(state.profile.derived.smile.cornerTravel * 100).toFixed(1)}%`}
            hint="of mouth width at their max"
          />
          <Figure
            label="Frown reach"
            value={`${(state.profile.derived.frown.cornerTravel * 100).toFixed(1)}%`}
            hint="of mouth width at their max"
          />
          <Figure
            label="Jaw effect"
            value={state.profile.derived.jawCoupling.toFixed(2)}
            hint="corner travel from opening"
          />
        </div>
      )}

      {runtime?.calibrated && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px]">
          <Figure
            label="Their face now"
            value={`${Math.round(runtime.liveLevel * 100)}%`}
            hint="toward their own max"
          />
          <Figure
            label="Morph budget"
            value={`${Math.round(runtime.headroom * 100)}%`}
            hint="left after their expression"
          />
          <Figure
            label="Applied"
            value={runtime.appliedAlpha.toFixed(2)}
            hint={runtime.talking ? 'talking' : 'alpha in effect'}
          />
        </div>
      )}

      {flags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {flags.map((flag) => (
            <span
              key={flag}
              className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-200 ring-1 ring-red-500/25"
            >
              {QUALITY_FLAG_LABELS[flag]}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onRun}
          disabled={!enabled || state.status === 'running'}
          className="rounded-lg bg-sky-600 px-3 py-1.5 text-[11px] font-semibold text-white transition enabled:hover:bg-sky-500 disabled:opacity-40"
        >
          {measured ? 'Run calibration again' : 'Run calibration'}
        </button>
        <button
          type="button"
          onClick={onAccept}
          disabled={!canAccept}
          className="ml-auto rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white transition enabled:hover:bg-emerald-500 disabled:opacity-40"
        >
          {state.status === 'accepted' ? 'Accepted' : 'Accept'}
        </button>
      </div>
    </div>
  )
}

function PhaseThumb({
  phase,
  summary,
  screenshot,
  neutral,
  enabled,
  onRedo,
}: {
  phase: CalibrationPhase
  summary: CalibrationPhaseSummary | undefined
  screenshot: string | undefined
  neutral: CalibrationPhaseSummary | undefined
  enabled: boolean
  onRedo: () => void
}) {
  const label = CALIBRATION_PROMPTS[phase].shortLabel
  const scoreKey = phase === 'frown' ? 'frown' : 'smile'
  // The peak is what matters for an expression phase; neutral has only a mean.
  const peakValue = summary?.peak?.scores[scoreKey].mean ?? summary?.scores[scoreKey].mean
  // Neutral → max is the number the researcher is really judging: a phase that
  // barely moves off the resting face cannot be used to scale anything.
  const delta =
    phase === 'neutral' || !summary?.peak || !neutral
      ? null
      : summary.peak.scores[scoreKey].mean - neutral.scores[scoreKey].mean

  return (
    <div
      className={`overflow-hidden rounded-lg border ${
        summary?.status === 'needs-redo'
          ? 'border-red-500/40 bg-red-500/5'
          : 'border-gray-800 bg-gray-900/70'
      }`}
    >
      <div className="relative aspect-[4/3] bg-gray-950">
        {screenshot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={screenshot} alt={label} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-[10px] text-gray-600">
            no frame
          </div>
        )}
      </div>
      <div className="px-2 py-1.5 text-[10px] leading-tight">
        <p className="truncate font-medium text-gray-300">{label}</p>
        <p className="font-mono text-gray-500">
          {typeof peakValue === 'number' ? peakValue.toFixed(2) : '--'}
          {delta !== null && (
            <span className={delta > 0 ? ' text-emerald-400' : ' text-red-400'}>
              {' '}
              {delta >= 0 ? '+' : ''}
              {delta.toFixed(2)}
            </span>
          )}
        </p>
        <button
          type="button"
          onClick={onRedo}
          disabled={!enabled}
          className="mt-1 w-full rounded bg-gray-800 py-0.5 text-[10px] font-medium text-gray-300 transition enabled:hover:bg-gray-700 disabled:opacity-40"
        >
          Redo
        </button>
      </div>
    </div>
  )
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg bg-gray-900/80 px-2 py-1.5">
      <p className="font-medium text-gray-400">{label}</p>
      <p className="font-mono text-gray-200">{value}</p>
      <p className="text-[9.5px] text-gray-600">{hint}</p>
    </div>
  )
}

function statusText(state: CalibrationUiState): string {
  switch (state.status) {
    case 'idle':
      return 'not run'
    case 'running':
      return state.currentPhase
        ? CALIBRATION_PROMPTS[state.currentPhase].shortLabel.toLowerCase()
        : 'running'
    case 'needs-redo':
      return 'redo needed'
    case 'complete':
      return 'ready to accept'
    case 'accepted':
      return state.acceptedAt
        ? `accepted ${new Date(state.acceptedAt).toLocaleTimeString()}`
        : 'accepted'
  }
}

function statusClass(status: CalibrationUiStatus, enabled: boolean): string {
  if (!enabled) return 'bg-gray-800 text-gray-500 ring-gray-700'
  if (status === 'accepted') return 'bg-emerald-600/25 text-emerald-200 ring-emerald-500/35'
  if (status === 'complete') return 'bg-sky-600/25 text-sky-200 ring-sky-500/35'
  if (status === 'needs-redo') return 'bg-red-600/25 text-red-200 ring-red-500/35'
  if (status === 'running') return 'bg-amber-600/25 text-amber-200 ring-amber-500/35'
  return 'bg-gray-800 text-gray-400 ring-gray-700'
}
