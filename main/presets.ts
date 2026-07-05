// Emotion-modification conditions (presets).
//
// These are the experiment's manipulation conditions. Keeping them as named,
// documented presets — rather than asking the RA to dial in raw numbers — makes
// the manipulation reproducible across sessions and removes a class of operator
// error. Each condition bundles a facial smile setting (alpha) and a voice pitch
// setting (semitones).
//
// Lives in main/ so the session server's rule engine can resolve a presetId to
// its effect values; the renderer re-exports from renderer/lib/presets.ts.
//
// Intensities were tamped down after the 2026-07 lab demo — the RAs reported the
// original values ("subtle" 1.6, "strong" 2.4, frown −0.5) read as too strong
// and often uncanny. These are starting points to calibrate with Randy.

export interface ModificationPreset {
  id: string
  label: string
  description: string
  /** Smile intensity. 1.0 neutral, >1 more smile, <1 toward a frown. */
  alpha: number
  /** Voice pitch shift in semitones. 0 = neutral. */
  voiceSemitones: number
  /** Whether this is the sham/control condition (no visible change). */
  isControl?: boolean
}

export const PRESETS: ModificationPreset[] = [
  {
    id: 'neutral',
    label: 'Neutral / Sham',
    description: 'Control condition. Pipeline runs identically but face and voice are unchanged.',
    alpha: 1.0,
    voiceSemitones: 0,
    isControl: true,
  },
  {
    id: 'smile-subtle',
    label: 'Smile + (subtle)',
    description: 'Mildly increases smile intensity. Often below conscious detection.',
    alpha: 1.35,
    voiceSemitones: 0,
  },
  {
    id: 'smile-strong',
    label: 'Smile + (strong)',
    description: 'Clearly increases smile intensity.',
    alpha: 1.9,
    voiceSemitones: 0,
  },
  {
    id: 'frown-subtle',
    label: 'Frown (subtle)',
    description: 'Mildly dampens the smile toward neutral/negative.',
    alpha: 0.6,
    voiceSemitones: 0,
  },
  {
    id: 'frown-strong',
    label: 'Frown (strong)',
    description: 'Clearly shifts the mouth toward a frown.',
    alpha: 0.1,
    voiceSemitones: 0,
  },
  {
    id: 'warm-voice',
    label: 'Warmer voice',
    description: 'Subtle smile lift paired with a slightly lower, warmer voice.',
    alpha: 1.25,
    voiceSemitones: -2,
  },
  {
    id: 'bright-voice',
    label: 'Brighter voice',
    description: 'Subtle smile lift paired with a slightly higher, brighter voice.',
    alpha: 1.25,
    voiceSemitones: 2,
  },
]

export const DEFAULT_PRESET_ID = 'neutral'

export function getPreset(id: string): ModificationPreset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]
}

/**
 * Suggest a counterbalanced condition order across dyads so conditions are
 * evenly distributed and not confounded with session order. Deterministic given
 * the same inputs (documented, reproducible — a lab requirement).
 */
export function counterbalanceConditions(presetIds: string[], nDyads: number): string[] {
  if (presetIds.length === 0) return []
  const order: string[] = []
  for (let k = 0; k < nDyads; k++) {
    order.push(presetIds[k % presetIds.length])
  }
  return order
}
