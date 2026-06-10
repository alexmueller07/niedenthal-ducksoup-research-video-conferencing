// Emotion-modification conditions (presets).
//
// These are the experiment's manipulation conditions. Keeping them as named,
// documented presets — rather than asking the RA to dial in raw numbers — makes
// the manipulation reproducible across sessions and removes a class of operator
// error. Each condition bundles a facial smile setting (alpha) and a voice pitch
// setting (semitones). Values are starting points to calibrate with Randy.

import type { ModificationPreset } from './types'

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
    alpha: 1.6,
    voiceSemitones: 0,
  },
  {
    id: 'smile-strong',
    label: 'Smile + (strong)',
    description: 'Clearly increases smile intensity.',
    alpha: 2.4,
    voiceSemitones: 0,
  },
  {
    id: 'frown-subtle',
    label: 'Smile − (subtle)',
    description: 'Mildly dampens smile toward neutral/negative.',
    alpha: 0.5,
    voiceSemitones: 0,
  },
  {
    id: 'frown-strong',
    label: 'Smile − (strong)',
    description: 'Clearly dampens smile toward a frown.',
    alpha: -0.5,
    voiceSemitones: 0,
  },
  {
    id: 'warm-voice',
    label: 'Warmer voice',
    description: 'Subtle smile lift paired with a slightly lower, warmer voice.',
    alpha: 1.4,
    voiceSemitones: -2,
  },
  {
    id: 'bright-voice',
    label: 'Brighter voice',
    description: 'Subtle smile lift paired with a slightly higher, brighter voice.',
    alpha: 1.4,
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
