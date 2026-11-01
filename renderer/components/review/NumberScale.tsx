// A labelled integer scale: one circle per point with its number under it, and
// anchor words under the ends (and optionally the middle). Ported from the lab
// suite. Numbers and anchors share one equal-width grid, and each anchor is
// centred on the point it labels, so "0" sits exactly under the middle anchor
// and never runs into its neighbours -1 and 1.

export function NumberScale({
  label,
  min,
  max,
  leftLabel,
  rightLabel,
  centerLabel,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  min: number
  max: number
  leftLabel: string
  rightLabel: string
  centerLabel?: string
  value: number | null | undefined
  onChange: (value: number) => void
  disabled?: boolean
}) {
  const points: number[] = []
  for (let n = min; n <= max; n += 1) points.push(n)
  const middle = (points.length - 1) / 2
  const anchorFor = (index: number) =>
    index === 0 ? leftLabel : index === points.length - 1 ? rightLabel : centerLabel !== undefined && index === middle ? centerLabel : ''
  return (
    <div className="num-scale" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
      {points.map((point) => (
        <button
          key={point}
          type="button"
          role="radio"
          aria-checked={value === point}
          aria-label={`${point}`}
          disabled={disabled}
          className={`num-scale-point ${value === point ? 'selected' : ''}`}
          onClick={() => onChange(point)}
        >
          <i />
          <span>{point}</span>
        </button>
      ))}
      {points.map((point, index) => (
        <span key={`anchor-${point}`} className="num-scale-anchor">
          {anchorFor(index) && <span>{anchorFor(index)}</span>}
        </span>
      ))}
    </div>
  )
}
