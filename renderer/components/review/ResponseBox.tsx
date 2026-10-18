// The writing panel beside the review videos: which turn this is, the
// question for this person, the answer box, and the Done button.

import { fmtTimeline } from '../../lib/reviewSync'
import type { ReviewSegment, ReviewStatus } from '../../lib/protocol'

export interface ResponseBoxProps {
  segment: ReviewSegment
  totalTurns: number
  /** True when this turn is about the person writing. */
  aboutMe: boolean
  aboutName: string
  partnerName: string
  status: ReviewStatus
  positionMs: number
  text: string
  submitted: boolean
  partnerDone: boolean
  /** Seconds until the next turn starts by itself, or null. */
  autoAdvanceIn: number | null
  canPause: boolean
  onText: (text: string) => void
  onDone: () => void
  onPauseToggle: () => void
}

export function ResponseBox({
  segment,
  totalTurns,
  aboutMe,
  aboutName,
  partnerName,
  status,
  positionMs,
  text,
  submitted,
  partnerDone,
  autoAdvanceIn,
  canPause,
  onText,
  onDone,
  onPauseToggle,
}: ResponseBoxProps) {
  const length = Math.max(1, segment.endMs - segment.startMs)
  const progress = Math.min(1, Math.max(0, (positionMs - segment.startMs) / length))
  const clipOver = status === 'writing'

  return (
    <div className="flex h-full flex-col">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-sky-300">
        Turn {segment.index} of {totalTurns}
      </p>
      <h2 className="mt-1 text-lg font-semibold text-white">
        {aboutMe ? 'Your video' : `${aboutName}'s video`}
      </h2>
      <p className="mt-0.5 text-xs text-gray-500">
        Minutes {fmtTimeline(segment.startMs)} – {fmtTimeline(segment.endMs)} of your conversation
      </p>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-800">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${clipOver ? 'bg-emerald-400' : 'bg-sky-400'}`}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-gray-500">
        <span className="font-mono tabular-nums">
          {fmtTimeline(positionMs - segment.startMs)} / {fmtTimeline(length)}
        </span>
        {canPause && (status === 'playing' || status === 'paused') && (
          <button
            type="button"
            onClick={onPauseToggle}
            className="rounded-md bg-gray-800 px-2.5 py-1 text-[11px] font-medium text-gray-200 transition hover:bg-gray-700"
          >
            {status === 'paused' ? '▶ Resume' : '❚❚ Pause'}
          </button>
        )}
      </div>

      <label htmlFor="review-answer" className="mt-6 block text-base font-medium leading-snug text-white">
        {aboutMe
          ? 'What were you feeling during this part of the conversation?'
          : `What do you think ${aboutName} was feeling during this part of the conversation?`}
      </label>
      <textarea
        id="review-answer"
        value={text}
        onChange={(e) => onText(e.target.value)}
        disabled={submitted}
        placeholder="Write as much or as little as you like…"
        className="mt-3 min-h-[160px] w-full flex-1 resize-none rounded-xl border border-gray-700 bg-gray-950 px-4 py-3 text-sm leading-relaxed text-white outline-none transition placeholder:text-gray-600 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:opacity-60"
      />

      <div className="mt-4">
        {submitted ? (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-200 ring-1 ring-emerald-500/30">
            Saved.{' '}
            {partnerDone ? 'Starting the next turn…' : `Waiting for ${partnerName} to finish…`}
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={onDone}
              disabled={!clipOver}
              className="w-full rounded-xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition enabled:hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Done
            </button>
            <p className="mt-2 text-center text-[11px] text-gray-500">
              {clipOver
                ? autoAdvanceIn !== null
                  ? `The next turn starts in ${autoAdvanceIn} s`
                  : 'Press Done when you have finished writing.'
                : 'You can start writing now. Done unlocks when the clip ends.'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
