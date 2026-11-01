// "There is more of this page below you."
//
// Ben, 2026-09-19: on the short-video task's partner page there is a fourth
// question under the fold, "and not everyone scrolled down every time and
// didn't see the last question". He suggested an arrow. He is right, and the
// problem is not limited to that page — every long questionnaire has the same
// shape, and the app now hides its scrollbar (App.css), which was the only
// thing telling anyone a page continued.
//
// So: one indicator, mounted against whichever element is doing the scrolling,
// visible only while there is genuinely something below, and gone the moment
// the participant reaches the bottom. It is deliberately not a button — the
// page is scrolled with the wheel, and an indicator that also scrolls for you
// invites clicking it repeatedly instead of reading. (It does scroll on click
// anyway, because a participant who taps an arrow expects *something*.)
//
// It is solid, not pulsing. Eddie and Randy, 2026-10-13: the flashing version
// drew the eye away from the questions; a quiet, steady indicator is enough to
// say the page continues.
//
// Why a poll rather than an IntersectionObserver sentinel: the content of these
// pages changes height as questions are answered (a race of radio buttons does
// not, but an "Other — please specify" field does), and a 300 ms poll on one
// element is cheaper than reasoning about which mutations need a re-measure.
// Nothing on this page is a measurement, so a frame of lag costs nothing.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** Pixels of remaining scroll below which "you are at the bottom" is true. */
const BOTTOM_SLACK = 24;

interface ScrollHintProps {
  /**
   * The scrolling element. Omit for the app's own scroll container (#root),
   * which is what every ordinary page scrolls inside — see utils/scroll.ts for
   * the same distinction.
   */
  containerRef?: RefObject<HTMLElement | null>;
  /** Bottom offset in pixels. Raised where a pinned Continue button sits. */
  bottomClass?: string;
  /**
   * Render in the normal document flow instead of pinned to the viewport.
   *
   * For a screen whose own bottom furniture is in flow rather than fixed — the
   * instruction screens, where the "press any key" prompt is a sibling of the
   * scrolling region. A pinned hint there would have to guess that prompt's
   * height, and guess again the next time its wording changed.
   */
  inline?: boolean;
}

export default function ScrollHint({
  containerRef,
  bottomClass = "bottom-8",
  inline = false,
}: ScrollHintProps) {
  const [visible, setVisible] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const measure = () => {
      const element =
        containerRef?.current ?? document.getElementById("rating-root") ?? null;
      elementRef.current = element;
      if (!element) {
        setVisible(false);
        return;
      }
      const remaining = element.scrollHeight - element.clientHeight - element.scrollTop;
      setVisible(remaining > BOTTOM_SLACK);
    };

    measure();
    const id = window.setInterval(measure, 300);
    const element = containerRef?.current ?? document.getElementById("rating-root");
    element?.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      window.clearInterval(id);
      element?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, [containerRef]);

  if (!visible) return null;

  const scrollDown = () => {
    const element = elementRef.current;
    if (!element) return;
    element.scrollBy({ top: element.clientHeight * 0.8, behavior: "smooth" });
  };

  // left-1/2 + translate rather than inset-x-0 on the pinned variant: centred
  // on the page, not on the space left of the Continue button in the corner.
  const position = inline
    ? "mx-auto"
    : `fixed ${bottomClass} left-1/2 -translate-x-1/2 z-40`;

  return (
    <button
      type="button"
      onClick={scrollDown}
      className={`${position} flex items-center gap-2 px-4 py-2 border border-gray-500 bg-black text-gray-300 text-sm hover:border-white hover:text-white transition-colors`}
    >
      <span aria-hidden>▼</span>
      <span>{inline ? "More below — scroll down" : "More questions below — scroll down"}</span>
    </button>
  );
}
