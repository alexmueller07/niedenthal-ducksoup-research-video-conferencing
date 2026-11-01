// A labelled integer scale: one clickable circle per point, the number printed
// under each circle, and an anchor word at each end.
//
// This is the shape Randy's paper questionnaires use (0 … 10 with "Not at all"
// and "Very much" under the ends), so the on-screen version has to look like the
// paper version — participants who did the pilot on paper should recognise it.
//
// Works for any integer range, including negative ones: the relative-talking
// item runs -5 … +5 with a third anchor in the middle.

interface NumberScaleProps {
  /** Question text shown above the scale. */
  label: string;
  min: number;
  max: number;
  /** Anchor under the leftmost point. */
  leftLabel: string;
  /** Anchor under the rightmost point. */
  rightLabel: string;
  /** Optional anchor under the midpoint (used by the relative-talking item). */
  centerLabel?: string;
  value: number | undefined;
  onChange: (value: number) => void;
  /**
   * True once the participant has tried to continue with this question blank.
   * Ben, 2026-09-19: the "are you sure" dialog said that something was missed
   * but not what, so a participant who scrolled past one question on a page of
   * twenty had to hunt. Marked rather than blocked — skipping is still allowed.
   */
  unanswered?: boolean;
}

export default function NumberScale({
  label,
  min,
  max,
  leftLabel,
  rightLabel,
  centerLabel,
  value,
  onChange,
  unanswered = false,
}: NumberScaleProps) {
  const points: number[] = [];
  for (let n = min; n <= max; n += 1) points.push(n);

  return (
    <div
      className={`border-b border-gray-600 py-6 last:border-b-0 ${
        unanswered ? "bg-red-950/30 -mx-4 px-4 rounded" : ""
      }`}
    >
      {/* The question sits inside the same column as the circles, centred over
          them. Randy, 2026-08-04: the question used to be left-aligned against
          the full width of the page frame while the scale was centred, so on a
          wide screen the two read as belonging to different questions. */}
      <div className="flex justify-center">
        <div className="w-full max-w-3xl">
          <p className="text-white text-xl mb-5 text-center">
            {unanswered && (
              <span className="text-red-400 font-bold mr-1" aria-label="Not answered">
                *
              </span>
            )}
            {label}
          </p>
          {unanswered && (
            <p className="text-red-400 text-sm mb-4 text-center">Not answered</p>
          )}

          <div className="flex items-start justify-between gap-1">
            {points.map((point) => (
              <button
                key={point}
                type="button"
                onClick={() => onChange(point)}
                aria-pressed={value === point}
                aria-label={`${label} — ${point}`}
                className="flex flex-1 flex-col items-center gap-1.5 group"
              >
                <span
                  className={`w-8 h-8 rounded-full border-2 transition-colors ${
                    value === point
                      ? "bg-white border-white"
                      : "bg-transparent border-white group-hover:bg-gray-600"
                  }`}
                />
                <span className="text-white text-sm">{point}</span>
              </button>
            ))}
          </div>

          {/* Anchors sit under the scale, each centred on the point it labels,
              so "Not at all" reads as belonging to the first circle rather than
              floating somewhere left of it. Each cell keeps the width of its
              column and the text is absolutely centred inside it, so a long
              anchor overhangs symmetrically instead of stretching the row. */}
          <div className="relative mt-2 flex items-start justify-between gap-1">
            {points.map((point, index) => {
              const isCenter =
                centerLabel !== undefined && index === (points.length - 1) / 2;
              const text =
                index === 0
                  ? leftLabel
                  : index === points.length - 1
                    ? rightLabel
                    : isCenter
                      ? centerLabel
                      : "";
              return (
                <span key={point} className="relative h-10 flex-1">
                  {text && (
                    <span className="absolute left-1/2 top-0 w-40 -translate-x-1/2 text-center text-sm leading-tight text-gray-300">
                      {text}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
