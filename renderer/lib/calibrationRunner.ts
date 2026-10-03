// Drives the guided calibration sequence: prompt, countdown, record, pick the
// peak, screenshot it, summarize.
//
// Both modes run exactly this loop — the 1-person test station calls it
// directly against its own CaptureStation, and a participant machine in the
// three-seat call runs it when the researcher presses "Run calibration". The
// only difference is where the result goes afterwards, so the timing, the
// prompts and the maths stay identical between them rather than drifting apart
// in two copies.

import {
  CALIBRATION_PREP_MS,
  CALIBRATION_PROMPTS,
  CALIBRATION_SAMPLE_MS,
  CALIBRATION_SETTLE_MS,
  phaseDurationMs,
  summarizePhase,
  validatePhase,
  type CalibrationFrame,
} from './calibration'
import type { CalibrationPhase, CalibrationPhaseSummary } from './protocol'

export interface CalibrationProgress {
  phase: CalibrationPhase
  title: string
  instruction: string
  /** 1-based position in this run, which may be a single-phase redo. */
  index: number
  total: number
  stage: 'prepare' | 'recording' | 'settling'
  /** Whole seconds left in the current stage, for the on-screen countdown. */
  secondsLeft: number
  /** 0..1 through the recording stage. */
  progress: number
}

export interface CalibrationPhaseOutcome {
  summary: CalibrationPhaseSummary
  screenshotDataUrl: string | null
}

export interface CalibrationRunnerDeps {
  /** One frame of the participant's real face, or null if nothing is tracked yet. */
  sample: (tsMs: number) => CalibrationFrame | null
  /** The current raw camera frame as a JPEG data URL. */
  snapshot: () => string | null
  /** Prompt/countdown state for the participant's screen; null when finished. */
  onProgress: (progress: CalibrationProgress | null) => void
  /** Called as each phase finishes, so results can be sent while the run continues. */
  onPhase?: (outcome: CalibrationPhaseOutcome) => void
  /** Return false to abandon the run (participant left, session ended, restarted). */
  shouldContinue: () => boolean
}

/**
 * Run the given phases in order and return what each one measured.
 *
 * Passing a single phase is how a redo works: the researcher retakes just the
 * flagged one and it merges into the existing results, rather than the
 * participant sitting through all four again.
 */
export async function runCalibrationPhases(
  phases: CalibrationPhase[],
  deps: CalibrationRunnerDeps,
  previous?: Partial<Record<CalibrationPhase, CalibrationPhaseSummary>>,
): Promise<Partial<Record<CalibrationPhase, CalibrationPhaseSummary>>> {
  const results: Partial<Record<CalibrationPhase, CalibrationPhaseSummary>> = { ...previous }

  for (let i = 0; i < phases.length; i++) {
    if (!deps.shouldContinue()) break
    const phase = phases[i]
    const prompt = CALIBRATION_PROMPTS[phase]
    const durationMs = phaseDurationMs(phase)

    // Prep: the prompt is on screen and counting down, but nothing is recorded
    // yet, so the frames we keep are the expression rather than the run-up to it.
    await countdown(CALIBRATION_PREP_MS, (left) =>
      deps.onProgress({
        phase,
        title: prompt.title,
        instruction: prompt.instruction,
        index: i + 1,
        total: phases.length,
        stage: 'prepare',
        secondsLeft: left,
        progress: 0,
      }),
      deps.shouldContinue,
    )
    if (!deps.shouldContinue()) break

    const { frames, screenshotDataUrl } = await record(phase, durationMs, deps, (left, progress) =>
      deps.onProgress({
        phase,
        title: prompt.title,
        instruction: prompt.instruction,
        index: i + 1,
        total: phases.length,
        stage: 'recording',
        secondsLeft: left,
        progress,
      }),
    )
    if (!deps.shouldContinue()) break

    const summary = validatePhase(
      { ...summarizePhase(phase, frames, durationMs), screenshot: screenshotFileName(phase) },
      phase === 'neutral' ? undefined : results.neutral,
    )
    results[phase] = summary
    deps.onPhase?.({ summary, screenshotDataUrl })

    // A short beat so the participant is not jumped straight into the next
    // instruction while still holding the last expression.
    await countdown(CALIBRATION_SETTLE_MS, (left) =>
      deps.onProgress({
        phase,
        title: prompt.title,
        instruction: 'Thanks — relax for a moment.',
        index: i + 1,
        total: phases.length,
        stage: 'settling',
        secondsLeft: left,
        progress: 1,
      }),
      deps.shouldContinue,
    )
  }

  deps.onProgress(null)
  return results
}

export function screenshotFileName(phase: CalibrationPhase): string {
  switch (phase) {
    case 'neutral':
      return 'neutral.jpg'
    case 'smileClosed':
      return 'max_smile_closed.jpg'
    case 'smileOpen':
      return 'max_smile_open.jpg'
    case 'frown':
      return 'max_frown.jpg'
  }
}

/**
 * Sample for `durationMs`, keeping a screenshot of the strongest frame.
 *
 * The screenshot is taken the moment a frame beats the running best rather
 * than by buffering every frame — that is a handful of small JPEG encodes over
 * four seconds instead of holding a hundred full-resolution frames in memory.
 */
async function record(
  phase: CalibrationPhase,
  durationMs: number,
  deps: CalibrationRunnerDeps,
  onTick: (secondsLeft: number, progress: number) => void,
): Promise<{ frames: CalibrationFrame[]; screenshotDataUrl: string | null }> {
  const frames: CalibrationFrame[] = []
  const startedAt = now()
  const scoreKey = phase === 'frown' ? 'frown' : 'smile'
  let best = -Infinity
  let screenshotDataUrl: string | null = null
  // Neutral has no peak, so its screenshot is simply the middle of the take.
  const neutralShotAt = startedAt + durationMs / 2
  let neutralShotTaken = false

  while (true) {
    const tsMs = now()
    const elapsed = tsMs - startedAt
    if (elapsed >= durationMs || !deps.shouldContinue()) break

    const frame = deps.sample(tsMs)
    if (frame) {
      frames.push(frame)
      if (phase === 'neutral') {
        if (!neutralShotTaken && tsMs >= neutralShotAt && frame.faceFound) {
          screenshotDataUrl = deps.snapshot()
          neutralShotTaken = true
        }
      } else if (frame.faceFound && frame.scores[scoreKey] > best) {
        best = frame.scores[scoreKey]
        screenshotDataUrl = deps.snapshot() ?? screenshotDataUrl
      }
    }

    onTick(Math.max(0, Math.ceil((durationMs - elapsed) / 1000)), elapsed / durationMs)
    await sleep(CALIBRATION_SAMPLE_MS)
  }

  if (!screenshotDataUrl) screenshotDataUrl = deps.snapshot()
  return { frames, screenshotDataUrl }
}

async function countdown(
  totalMs: number,
  onTick: (secondsLeft: number) => void,
  shouldContinue: () => boolean,
): Promise<void> {
  const startedAt = now()
  while (true) {
    const elapsed = now() - startedAt
    if (elapsed >= totalMs || !shouldContinue()) return
    onTick(Math.max(0, Math.ceil((totalMs - elapsed) / 1000)))
    await sleep(100)
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
