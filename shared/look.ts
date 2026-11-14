// A look is how a map's tones are printed, apart from where and on what: the part
// of the print settings that can be carried from one map to another.

import { FADE_MAX_MM } from './fade.ts'
import { type Filter, invalidFilter, NEW_FILTER } from './tone.ts'

export interface Look {
  /** Ink mode, levels, curve, tone ranges, colour families and colour selections. */
  filter: Filter
  /** Edge fade, which saves ink on dark maps. */
  fadeMm: number
}

export const NEW_LOOK: Look = { filter: NEW_FILTER, fadeMm: 0 }

export const MAX_LOOKS = 100
export const MAX_LOOK_NAME = 60

/** Which part of a look from outside is unusable, or null when all of it is fine. */
export function invalidLook(look: Look | undefined): string | null {
  if (!look || typeof look !== 'object') return 'look'
  if (typeof look.fadeMm !== 'number' || !(look.fadeMm >= 0 && look.fadeMm <= FADE_MAX_MM)) return 'fade'
  return invalidFilter(look.filter)
}

export const cleanName = (name: unknown): string => (typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, MAX_LOOK_NAME) : '')

export const sameLook = (a: Look, b: Look) => JSON.stringify(a) === JSON.stringify(b)
