// Scan rules: the words that decide which files are maps and what their names mean.
// Editable in Settings; the defaults are what Scenic has always used.

export interface ScanRules {
  /** A folder whose whole name matches is not scanned. */
  skipFolders: string[]
  /** A file whose name contains one of these is not scanned. */
  skipFiles: string[]
  /** Kept even when a skip rule matches: words in any folder name or the file name. */
  include: string[]
  /** Extra words for each meaning, on top of the built-in ones such as "no grid" and "keyed". */
  gridded: string[]
  gridless: string[]
  labelled: string[]
  unlabelled: string[]
  /** Words that describe a version of the same place, such as "cutaway"; files differing only by these group into one scene. */
  variants: string[]
  /** Files in a folder named with one of these, or named with one, are overlays of a map in the same scene. */
  overlays: string[]
}

export const DEFAULT_RULES: ScanRules = {
  skipFolders: [
    'token', 'portrait', 'music', 'audio', 'sound', 'pdf', 'handout', 'art', 'artwork', 'asset', 'sprite', 'icon',
    '* monster', 'stat block', 'statblock', 'npc',
  ],
  skipFiles: [
    'stat block', 'statblock', 'stats', 'character sheet', 'preview', 'thumb', 'thumbnail', 'cover', 'promo', 'poster',
    'banner', 'watermark', 'watermarked', 'logo', 'credit',
  ],
  include: [],
  gridded: [],
  gridless: [],
  labelled: [],
  unlabelled: [],
  variants: [],
  overlays: ['overlay'],
}

export const RULE_LISTS = Object.keys(DEFAULT_RULES) as (keyof ScanRules)[]

export const MAX_RULE_WORDS = 500
export const MAX_RULE_LENGTH = 100

/** Splits typed text into rules: one per line or comma, trimmed, without repeats. */
export function parseRuleText(text: string): string[] {
  const seen = new Set<string>()
  return text.split(/[\n,]/).map((w) => w.trim()).filter((w) => {
    const key = w.toLowerCase()
    if (!w || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Takes stored or submitted rules and fills anything missing or malformed from the defaults. */
export function normaliseRules(input: unknown): ScanRules {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const rules = { ...DEFAULT_RULES }
  for (const list of RULE_LISTS) {
    const value = source[list]
    if (Array.isArray(value)) {
      rules[list] = parseRuleText(value.filter((w) => typeof w === 'string' && w.length <= MAX_RULE_LENGTH).join('\n')).slice(0, MAX_RULE_WORDS)
    }
  }
  return rules
}

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')

const WORD = '[\\p{L}\\p{N}]'

/**
 * One word of a rule. `*` stands for any text, and a plain word also matches
 * its plural, so "token" finds "Tokens".
 */
function wordPattern(word: string): string {
  const body = escape(word).replace(/\*/g, '.*?')
  return word.endsWith('*') ? body : `${body}(?:e?s)?`
}

/** Words separated by spaces, underscores or dashes in a rule match any such separators in a name. */
function phrasePattern(phrase: string): string {
  return phrase.trim().split(/[\s_-]+/).filter(Boolean).map(wordPattern).join('[\\s_-]*')
}

/** Matches whole words anywhere in a name: "cover" finds "Pack Cover", not "Covered Bridge". */
export function wordMatcher(phrases: string[]): RegExp | null {
  const parts = phrases.map(phrasePattern).filter(Boolean)
  return parts.length ? new RegExp(`(?<!${WORD})(?:${parts.join('|')})(?!${WORD})`, 'iu') : null
}

/** Matches a whole folder name; leading numbering such as "02 " is ignored. */
export function nameMatcher(phrases: string[]): RegExp | null {
  const parts = phrases.map(phrasePattern).filter(Boolean)
  return parts.length ? new RegExp(`^(?:\\d{1,3}[\\s._-]+)?(?:${parts.join('|')})$`, 'iu') : null
}
