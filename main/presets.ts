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
// Alpha is now a fraction of each participant's OWN calibrated maximum: 1.0
// moves their mouth exactly as far as their biggest real smile (or frown) and
// never further, so the same preset produces a proportionate change on a small
// mouth and a wide one. The values below were rescaled to that meaning when
// calibration landed — they aim to keep the visible effect roughly where the
// old fixed-geometry values put it, rather than to mean the same numbers.
//
// Because the cap is on the TOTAL, a preset also delivers less than its number
// while the participant is already smiling: their real expression has taken
// part of the budget. effect_state_<seat>.csv records what was actually
// applied, which is the number to analyse.
//
// Still pilot settings. No psychophysical validation (detection threshold,
// naturalness, believability) has been run — see docs §12.

export interface ModificationPreset {
  id: string
  label: string
  description: string
  /**
   * Smile intensity as a fraction of this participant's calibrated maximum.
   * 0 neutral, 1 their biggest real smile, −1 their biggest real frown.
   */
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
    alpha: 0,
    voiceSemitones: 0,
    isControl: true,
  },
  {
    id: 'smile-subtle',
    label: 'Smile (subtle)',
    description: 'Adds a fifth of their own maximum smile. Often below conscious detection.',
    alpha: 0.2,
    voiceSemitones: 0,
  },
  {
    id: 'smile-strong',
    label: 'Smile (strong)',
    description: 'Adds half of their own maximum smile. Clearly visible.',
    alpha: 0.5,
    voiceSemitones: 0,
  },
  {
    id: 'frown-subtle',
    label: 'Frown (subtle)',
    description: 'Adds a quarter of their own maximum frown.',
    alpha: -0.25,
    voiceSemitones: 0,
  },
  {
    id: 'frown-strong',
    label: 'Frown (strong)',
    description: 'Adds just over half of their own maximum frown.',
    alpha: -0.55,
    voiceSemitones: 0,
  },
  {
    id: 'warm-voice',
    label: 'Lower voice',
    description: 'Subtle smile lift paired with a slightly lower voice.',
    alpha: 0.15,
    voiceSemitones: -2,
  },
  {
    id: 'bright-voice',
    label: 'Higher voice',
    description: 'Subtle smile lift paired with a slightly higher voice.',
    alpha: 0.15,
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
