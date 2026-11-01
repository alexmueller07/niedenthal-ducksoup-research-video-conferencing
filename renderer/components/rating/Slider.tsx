import { useEffect, useRef, useState } from "react";

// The continuous valence slider.
//
// MEASUREMENT — do not change without talking to Randy. The recorded value is
// the pointer's position along the visible track, 0 at the left end to 100 at
// the right (clamped), pushed into the parent's ref on every mouse move and
// sampled there every 100 ms. Still a 0-100 float in ratings.csv.
//
// Alex, 2026-08-10 — two changes from the pilot implementation, both flagged
// for Randy's sign-off in this commit:
//   - Geometry. The value was `clientX / window width`, but the track is inset
//     ~40px by the parent's px-10, so the handle and the anchor labels sat up
//     to ~40px off the pointer, and "Very Negative"/"Very Positive" hung over
//     values ≈4 and ≈96 rather than 0 and 100. The value is now measured
//     against the track element itself, so pointer, handle, labels and the
//     recorded number all refer to the same axis.
//   - Cadence. This component used to deposit the value on its own 100 ms
//     interval while DyadTaskMain sampled on another — two free-running
//     clocks, adding 0-100 ms of random staleness to every sample. The parent
//     ref is now updated directly from the mousemove handler (one ref write
//     per event) and the parent's loop is the only clock.
//
// Layout (Randy, 2026-07-30: "the words on the slider still aren't centered").
// The track spans the same width as the labels above it, so the anchors sit at
// the true ends of the track — and since the value is measured against that
// same track, they also sit at the true 0 and 100 of the recorded scale.
//
// The track is bare as of 2026-08-29, at the lab's request: the tick marks at
// 0/25/50/75/100 and the "Neutral" label at the midpoint are both gone. They
// were landmarks on a scale that is meant to be judged continuously, and a
// participant who aims for a mark is answering a different question than the
// one being asked. The ends stay labelled because the scale still needs a
// direction.
//
// The pointer is hidden while this runs (`cursor-none`), so the handle is the
// participant's only feedback: it is drawn large.

interface SliderProps {
  resetTrigger?: number;
  onSample?: (value: number) => void;
}

function Slider({ resetTrigger, onSample }: SliderProps) {
  const [sliderPosition, setSliderPosition] = useState(50);
  const sliderRef = useRef(50);
  const frameRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // The mousemove listener below must survive a parent re-render untouched: if
  // the effect depended on `onSample` directly, a new inline callback would
  // tear the listener down and re-attach it mid-measurement.
  const onSampleRef = useRef(onSample);
  onSampleRef.current = onSample;

  useEffect(() => {
    if (resetTrigger !== undefined) {
      setSliderPosition(50);
      sliderRef.current = 50;
      // Push the reset to the parent's ref too: with no interval re-depositing
      // the value, a new block would otherwise be sampled at the previous
      // block's final position until the first mouse move.
      onSampleRef.current?.(50);
    }
  }, [resetTrigger]);

  useEffect(() => {
    // The parent's ref is updated on every mouse event because it is what gets
    // sampled; the visible handle is repainted at most once per frame. Painting
    // on every mousemove was doing far more React work than the 100 ms sampler
    // needs.
    const handleMouseMove = (event: MouseEvent) => {
      // Measured against the track itself, clamped to its ends — see the
      // MEASUREMENT note at the top of this file. The window-width fallback
      // only covers a mousemove arriving before the track has laid out.
      const rect = trackRef.current?.getBoundingClientRect();
      const raw =
        rect && rect.width > 0
          ? ((event.clientX - rect.left) / rect.width) * 100
          : (event.clientX / window.innerWidth) * 100;
      const position = Math.min(100, Math.max(0, raw));
      sliderRef.current = position;
      onSampleRef.current?.(position);
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          setSliderPosition(sliderRef.current);
        });
      }
    };

    window.addEventListener("mousemove", handleMouseMove);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, []);

  return (
    <div className="w-full">
      <div className="relative mb-5 h-8">
        <span className="absolute left-0 top-0 text-white text-2xl">Very Negative</span>
        <span className="absolute right-0 top-0 text-white text-2xl">Very Positive</span>
      </div>

      <div ref={trackRef} className="relative h-3 w-full rounded-full bg-white cursor-none">
        <div
          className="absolute top-1/2 h-9 w-6 rounded-full border-2 border-black bg-white cursor-none"
          style={{
            // Clamped so the handle stays fully on screen at either extreme;
            // the value behind it is not clamped.
            left: `clamp(0.75rem, ${sliderPosition}%, calc(100% - 0.75rem))`,
            transform: "translateX(-50%) translateY(-50%)",
          }}
        />
      </div>
    </div>
  );
}

export default Slider;
