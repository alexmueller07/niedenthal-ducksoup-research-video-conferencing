// "Press any key to continue" — and, since 2026-09-19, click anywhere too.
//
// Ben's list from the lab, two entries of which are the same problem: some
// screens said "press any key or click continue" with no Continue button on
// them, and participants who reach for the mouse first were stuck looking at a
// screen that only answered to the keyboard. A study computer's mouse is the
// thing a participant has their hand on — the keyboard is for the two text
// boxes. So every advance screen now takes either.
//
// This lives in one place because the *filter* is the subtle part, and it was
// previously written out by hand in both DyadTaskMain and VideoTaskMain, with
// a real risk of the two drifting:
//
//   - `event.repeat` is a held-down key auto-repeating, not a decision. Without
//     this, leaning on the space bar blows through every instruction screen.
//   - a lone Shift/Control/Alt/Meta is somebody reaching for a shortcut, not an
//     answer to the prompt.
//   - a keypress inside a text field belongs to the text field. (No advance
//     screen has one today; this is here so adding one cannot break it.)
//
// Clicks are filtered too: a click on a button, link or form control is that
// control's click, and must not *also* advance the screen — otherwise the
// "← Previous" button on an instruction screen would go back and immediately
// forward again.

import { useEffect } from "react";

/** True for a keypress that means "yes, move on". */
export function isAdvanceKey(event: KeyboardEvent): boolean {
  if (event.repeat) return false;
  if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return false;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return false;
  return true;
}

/** True for a click on the page background rather than on some control. */
export function isAdvanceClick(event: MouseEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return true;
  return !target.closest("button, a, input, textarea, select, label, [role='button']");
}

/**
 * Advances a screen on any deliberate keypress or background click.
 *
 * `enabled` exists for the screens that hold themselves shut for a few seconds
 * (PerspectiveNotice's dwell): pass false and neither input does anything.
 */
export function useAdvance(onAdvance: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isAdvanceKey(event)) return;
      event.preventDefault();
      onAdvance();
    };
    const onClick = (event: MouseEvent) => {
      if (!isAdvanceClick(event)) return;
      onAdvance();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("click", onClick);
    };
  }, [onAdvance, enabled]);
}

/**
 * The click half on its own.
 *
 * For a screen that already owns a window keydown handler and cannot give it
 * up — DyadTaskMain's, which has to arbitrate between the instruction screens,
 * Tab-submits-the-writing-screen, and the perspective announcement that
 * swallows keys entirely. Adding the full hook there would run the instruction
 * advance twice per keypress, once from each listener.
 */
export function useAdvanceOnClick(onAdvance: () => void, enabled: boolean = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onClick = (event: MouseEvent) => {
      if (!isAdvanceClick(event)) return;
      onAdvance();
    };
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [onAdvance, enabled]);
}
