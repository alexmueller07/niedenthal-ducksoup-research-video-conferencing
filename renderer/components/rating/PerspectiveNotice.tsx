import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useScrollToTop } from "./scroll";
import { useAdvance } from "./useAdvance";
import PressKeyPrompt from "./PressKeyPrompt";

// The screen that tells a participant whose feelings the next thing is about.
//
// One component, two tasks. The continuous-slider task announces a perspective
// before every block; the video task announces one before every rating page.
// Randy asked (2026-08-05) for "the same waiting thing" in both, which is worth
// taking literally: the point of the screen is that a participant recognises it
// instantly and reads it, and two announcements that look slightly different
// are two announcements to learn.
//
// The dwell is a data-quality control, not decoration. A block rated from the
// wrong perspective is unusable and there is no way to detect it afterwards, so
// nothing advances until the countdown expires — and the remaining seconds are
// on screen, so the wait reads as deliberate rather than as a frozen app.
//
// Alex, 2026-09-19: once the dwell is over, a click anywhere works as well as a
// key, and there is a real Continue button. Ben's list had this screen in both
// of its "press any key" complaints — no button to click, and no way through
// for somebody whose hand is on the mouse. The dwell is unchanged; what changed
// is only how you get past it afterwards.

/** How long the announcement holds before any key will advance it. */
export const PERSPECTIVE_DWELL_MS = 3000;

interface PerspectiveNoticeProps {
  /** The main line. "You will now be reporting how YOU felt." */
  headline: ReactNode;
  /** Optional second line, used by the slider task. */
  subline?: ReactNode;
  onContinue: () => void;
}

export default function PerspectiveNotice({
  headline,
  subline,
  onContinue,
}: PerspectiveNoticeProps) {
  useScrollToTop();
  const [remainingMs, setRemainingMs] = useState(PERSPECTIVE_DWELL_MS);
  const locked = remainingMs > 0;

  useEffect(() => {
    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setRemainingMs(Math.max(0, PERSPECTIVE_DWELL_MS - (Date.now() - startedAt)));
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  useAdvance(onContinue, !locked);

  // Left-aligned inside a wide column, matching the slides Randy sent: the text
  // starts in the same place on every one of these screens, so a participant's
  // eye does not have to re-find it each time.
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black">
      <div className="w-full max-w-4xl px-16 text-left">
        <p className="text-white text-3xl leading-relaxed">{headline}</p>

        {subline && (
          <p className="text-white text-3xl leading-relaxed mt-10">{subline}</p>
        )}

        <p className="text-white text-3xl leading-relaxed mt-10">
          Continuing in {Math.ceil(remainingMs / 1000)}…
        </p>

        {/* Reserved rather than revealed: the prompt occupies its space while
            hidden, so the block of text does not jump when the countdown ends. */}
        <div
          className={`mt-16 max-w-xl transition-opacity duration-300 ${
            locked ? "opacity-0 pointer-events-none" : "opacity-100"
          }`}
          aria-hidden={locked}
        >
          <PressKeyPrompt onContinue={onContinue} disabled={locked} />
        </div>
      </div>
    </div>
  );
}
