import { useEffect, useRef, useState } from 'react'

// The continuous feelings slider, ported from the lab suite's rating station.
//
// The value is where the pointer is along the visible track, 0 at the left end
// to 100 at the right (clamped). No click or drag: moving the mouse moves the
// handle, so the participant keeps their eyes on the video. The pointer is
// hidden over the track and the large handle is the only feedback.
//
// The value is measured against the track element itself, and the end labels
// sit at the true ends of that same track, so pointer, handle, labels and the
// recorded number all share one axis.
//
// `onChange` fires on every mouse move (the parent keeps it in a ref and samples
// it on its own clock); the handle repaints at most once per frame.

export function MouseSlider({
  onChange,
  resetKey,
  disabled = false,
  leftLabel = 'Very negative',
  rightLabel = 'Very positive',
  ariaLabel = 'Feelings from very negative to very positive',
}: {
  onChange: (value: number) => void
  /** Changing this puts the handle back to the middle (a new part starts). */
  resetKey?: string | number
  disabled?: boolean
  leftLabel?: string
  rightLabel?: string
  ariaLabel?: string
}) {
  const [position, setPosition] = useState(50)
  const positionRef = useRef(50)
  const frame = useRef<number | null>(null)
  const track = useRef<HTMLDivElement>(null)
  // The listener must survive parent re-renders, or it would be torn down and
  // re-attached in the middle of a measurement.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  useEffect(() => {
    positionRef.current = 50
    setPosition(50)
  }, [resetKey])

  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (disabledRef.current) return
      const rect = track.current?.getBoundingClientRect()
      const raw =
        rect && rect.width > 0
          ? ((event.clientX - rect.left) / rect.width) * 100
          : (event.clientX / window.innerWidth) * 100
      const value = Math.min(100, Math.max(0, raw))
      positionRef.current = value
      onChangeRef.current(value)
      if (frame.current === null) {
        frame.current = window.requestAnimationFrame(() => {
          frame.current = null
          setPosition(positionRef.current)
        })
      }
    }
    window.addEventListener('mousemove', move)
    return () => {
      window.removeEventListener('mousemove', move)
      if (frame.current !== null) window.cancelAnimationFrame(frame.current)
    }
  }, [])

  return (
    <div
      className={`mouse-slider ${disabled ? 'disabled' : ''}`}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position)}
      aria-disabled={disabled}
    >
      <div className="mouse-slider-labels">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
      <div className="mouse-slider-track" ref={track}>
        <div className="mouse-slider-handle" style={{ left: `clamp(0.75rem, ${position}%, calc(100% - 0.75rem))` }} />
      </div>
    </div>
  )
}
