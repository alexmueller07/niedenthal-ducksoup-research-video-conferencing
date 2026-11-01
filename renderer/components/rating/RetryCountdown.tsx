import { useEffect, useState } from "react";

// What the failed-video panel says while the station is still looking on its
// own. See AUTO_RETRY_ATTEMPTS in App.tsx for why it looks at all.

export interface RetryState {
  /** Automatic searches made so far. */
  attempt: number;
  /** When the next one fires (epoch ms), or null when none is scheduled. */
  nextAt: number | null;
  max: number;
}

/** True once every automatic search has been spent, and the RA's button is next. */
export function retriesExhausted(retry: RetryState): boolean {
  return retry.attempt >= retry.max && retry.nextAt === null;
}

/**
 * "Looking again automatically in 7 s (try 2 of 4)", or null when nothing is
 * pending. Pure, so the wording and the rounding are pinned by a test.
 */
export function retryStatusText(retry: RetryState, now: number): string | null {
  if (retriesExhausted(retry)) return null;
  const next = Math.min(retry.attempt + 1, retry.max);
  // Not scheduled yet, or between a search firing and its answer coming back.
  if (retry.nextAt === null) return "Looking again automatically…";
  // Rounded, not ceiled: the clock this is measured against ticks every
  // 250 ms, so a just-scheduled try can read 10.2 s away and would show "11".
  const seconds = Math.max(0, Math.round((retry.nextAt - now) / 1000));
  return seconds === 0
    ? `Looking again automatically (try ${next} of ${retry.max})…`
    : `Looking again automatically in ${seconds} s (try ${next} of ${retry.max})`;
}

export default function RetryCountdown({ retry }: { retry: RetryState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retry.nextAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [retry.nextAt]);

  const text = retryStatusText(retry, now);
  if (!text) return null;
  return <p className="text-white text-sm">{text}</p>;
}
