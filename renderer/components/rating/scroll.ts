// Putting a new page at its top.
//
// #root is the scroll container, not the window (App.css pins html/body so the
// window itself cannot rubber-band). A scroll container keeps its scrollTop
// when the element inside it is swapped, so a participant who scrolled to the
// bottom of a long questionnaire and pressed Continue landed on the next page
// already scrolled down — sometimes past its first question, which is how a
// question gets skipped without anyone deciding to skip it.
//
// The reset therefore belongs to the page, not to the router: every screen the
// participant advances to calls it on mount.

import { useLayoutEffect } from "react";
import type { RefObject } from "react";

/** Puts the app's scroll container, and the window, back at the top. */
export function scrollToTop(): void {
  if (typeof document === "undefined") return;
  // `instant`, not `smooth`: this runs between two pages, and animating it
  // would show the outgoing page's scroll position on the incoming page.
  document.getElementById("rating-root")?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  window.scrollTo(0, 0);
}

/**
 * Scrolls to the top on mount, and again whenever `key` changes.
 *
 * useLayoutEffect rather than useEffect on purpose: the reset has to happen
 * before the browser paints, or the participant sees the new page flash at the
 * old page's offset and jump.
 *
 * Pass a `key` only for a screen that advances *in place* (Instructions, which
 * re-renders at a new index without unmounting). A screen that is already
 * keyed per trial, or is a distinct component per step, remounts anyway and
 * needs no argument.
 */
export function useScrollToTop(key?: unknown): void {
  useLayoutEffect(() => {
    scrollToTop();
  }, [key]);
}

/**
 * The same reset for a screen that scrolls *inside itself* rather than inside
 * #root — RatingOverlay, which is drawn over the video and owns its own
 * overflow. Scrolling #root would do nothing there.
 */
export function useScrollElementToTop(
  ref: RefObject<HTMLElement | null>,
  key?: unknown
): void {
  useLayoutEffect(() => {
    ref.current?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    // The ref is stable for the life of the element; `key` is what re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
