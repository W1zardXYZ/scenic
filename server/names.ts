// Reads what creators encode in file and folder names.

import { levelOf } from '../shared/levels.ts'
import { DEFAULT_RULES, nameMatcher, type ScanRules, wordMatcher } from '../shared/rules.ts'
import type { VariantKind } from '../shared/types.ts'

export { levelOf }

export interface ParsedName {
  /** Words of the name without size, ppi, version and grid markers. */
  tokens: string[]
  version: string
  /** `tokens` without label markers; equal keys mean the same underlying map. */
  key: string
  cols: number | null
  rows: number | null
  ppi: number | null
  grid: boolean | null
  labelled: boolean
}

const MAX_SQUARES = 400
const SIZE = /(?<![\d.])(\d{1,3})\s*[x×]\s*(\d{1,3})(?![\d.])/i
const PPI = /(?<![\d.])(\d{2,3})\s*(?:ppi|dpi|pps|px(?:\s*\/\s*(?:sq|square))?)\b/i
const GRID_PPI = /\b((?:grid(?:ded|less)?|ng|gl)[\s_-]*)(\d{2,3})\s*$/i
const VERSION = /^v?\d+(?:\.\d+)+[a-z]?$|^v\d+[a-z]?$/i
const NO_GRID = /(?:\b(?:no|without|non)[\s_-]*grid(?:ded|s)?\b|\bgrid[\s_-]*less\b|\bun[\s_-]*gridded\b|(?<![a-z])(?:ng|gl)(?![a-z]))/i
const GRID = /(?:\bgrid(?:ded|s)?\b|\bgrided\b|(?<![a-z])gr(?![a-z]))/i
const UNLABELLED = /\b(?:un[\s_-]*(?:labell?ed|keyed|numbered)|no[\s_-]*(?:labels?|text|numbers?))\b/i
const LABELLED = /\b(?:labell?ed|keyed|numbered)\b/i

/** The size a name states in squares, however small: overlays can be a single square across. */
export function statedSize(stem: string): { cols: number; rows: number } | null {
  const size = SIZE.exec(stem)
  if (!size) return null
  const [cols, rows] = [Number(size[1]), Number(size[2])]
  return cols >= 1 && rows >= 1 && cols <= MAX_SQUARES && rows <= MAX_SQUARES ? { cols, rows } : null
}

interface Compiled {
  skipFolder: RegExp | null
  skipFile: RegExp | null
  include: RegExp | null
  gridded: RegExp | null
  gridless: RegExp | null
  labelled: RegExp | null
  unlabelled: RegExp | null
  variants: Set<string>
  overlays: RegExp | null
}

const compile = (rules: ScanRules): Compiled => ({
  skipFolder: nameMatcher(rules.skipFolders),
  skipFile: wordMatcher(rules.skipFiles),
  include: wordMatcher(rules.include),
  gridded: wordMatcher(rules.gridded),
  gridless: wordMatcher(rules.gridless),
  labelled: wordMatcher(rules.labelled),
  unlabelled: wordMatcher(rules.unlabelled),
  variants: new Set(rules.variants.flatMap((w) => w.toLowerCase().split(/[\s_-]+/)).filter(Boolean)),
  overlays: wordMatcher(rules.overlays),
})

let current = compile(DEFAULT_RULES)

/** Every later reading of names follows these rules. */
export function useRules(rules: ScanRules): void {
  current = compile(rules)
}

const test = (pattern: RegExp | null, text: string) => !!pattern && pattern.test(text)
const strip = (pattern: RegExp | null, text: string) => (pattern ? text.replace(new RegExp(pattern.source, 'giu'), ' ') : text)

export function parseName(stem: string, dirs: string[] = []): ParsedName {
  let text = stem
  const size = SIZE.exec(text)
  let cols = null, rows = null
  if (size) {
    const [a, b] = [Number(size[1]), Number(size[2])]
    if (a >= 4 && b >= 4 && a <= MAX_SQUARES && b <= MAX_SQUARES) { cols = a; rows = b }
    text = text.replace(SIZE, ' ')
  }
  const ppiMatch = PPI.exec(text)
  let ppi: number | null = ppiMatch ? Number(ppiMatch[1]) : null
  if (ppiMatch) text = text.replace(PPI, ' ')

  let normalised = text.replace(/_/g, ' ')
  // Creators often append the resolution straight after the marker: Keep_no_grid_72.
  const attached = GRID_PPI.exec(normalised)
  if (attached) {
    ppi ??= Number(attached[2])
    normalised = normalised.replace(GRID_PPI, '$1')
  }
  const { gridded, gridless, labelled: labelWords, unlabelled: unlabelWords } = current
  const isGridless = (s: string) => NO_GRID.test(s) || test(gridless, s)
  const isGridded = (s: string) => GRID.test(s) || test(gridded, s)
  const isUnlabelled = (s: string) => UNLABELLED.test(s) || test(unlabelWords, s)
  const isLabelled = (s: string) => LABELLED.test(s) || test(labelWords, s)

  let grid: boolean | null = null
  if (isGridless(normalised)) grid = false
  else if (isGridded(normalised)) grid = true
  // Gridless words first: "no grid" contains "grid".
  text = strip(gridded, strip(gridless, normalised.replace(NO_GRID, ' ')).replace(GRID, ' '))

  const folder = dirs.join('/').replace(/_/g, ' ')
  if (grid === null && isGridless(folder)) grid = false
  else if (grid === null && isGridded(folder)) grid = true

  const labelled = !isUnlabelled(text) && (isLabelled(text) || (!isUnlabelled(folder) && isLabelled(folder)))
  // Label words stay out of the key, so labelled and unlabelled copies share it.
  const unlabelledText = strip(labelWords, strip(unlabelWords, text))
  const words = text.split(/[\s[\](){},]+|\s-\s/).filter((t) => /[\p{L}\p{N}]/u.test(t))
  const version = words.find((t) => VERSION.test(t)) ?? ''
  const tokens = words.filter((t) => !VERSION.test(t))
  const key = unlabelledText.split(/[\s[\](){},]+|\s-\s/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t) && !VERSION.test(t) && !LABELLED.test(t) && !UNLABELLED.test(t))
    .join(' ')
    .toLowerCase()
  return { tokens, version, key, cols, rows, ppi, grid, labelled }
}

const PLATFORMS = new Set(['patreon', 'ko-fi', 'kofi', 'gumroad', 'itch', 'itch.io', 'dmsguild', 'drivethrurpg'])
const GENERIC = new Set([
  ...PLATFORMS, 'maps', 'map', 'battlemaps', 'battlemap', 'battle maps', 'battle map', 'downloads', 'download',
  'dnd', 'd&d', 'dnd maps', 'd&d maps', 'ttrpg', 'vtt', 'vtts', 'rpg', 'assets', 'library', 'media', 'files',
  'archive', 'volume1', 'share', 'new folder', 'foundry', 'foundryvtt', 'roll20', 'fantasy grounds', 'dd2vtt',
  'uvtt', 'universal vtt', 'ready-to-play', 'jpg', 'jpeg', 'png', 'webp', 'variants', 'variations', 'print',
  'hi res', 'hires', 'high res', 'low res', 'labelled', 'unlabelled', 'labeled', 'unlabeled', 'players', 'gm',
  'other', 'others', 'misc', 'miscellaneous', 'various', 'overlay', 'overlays',
])
/** Resolution and format notes, as in "Maps - 300 DPI (Print)": what is left of such a folder decides whether it names anything. */
const FORMAT_NOTE = /\([^)]*\)|\[[^\]]*\]|\b\d{2,4}\s*(?:dpi|ppi|pps|px)\b|\b(?:print|printable|vtt|hd|uhd|4k|8k|hi[\s-]?res|high[\s-]?res(?:olution)?|low[\s-]?res(?:olution)?|digital)\b/gi
const NOT_A_NAME = /^(?:(?:19|20)\d\d|\d{2,4}\s*(?:ppi|dpi|pps|px)|\d{3,5}\s*x\s*\d{3,5}|\d+k|(?:with|no|without)?[\s_-]*grid(?:s|ded|less)?)$/i

/** Folders like "01 Hunt for Haldraxis" sort a release; the number is not part of its name. */
export const cleanFolder = (name: string) => name.replace(/^(?:\d{1,3}(?:\s*-\s+|[\s._]+|$)|\d{2,3}-(?=\S))/, '').replace(/[_\s]+/g, ' ').trim()

/** A folder that only sorts or describes files, such as "Maps - 300 DPI (Print)" or "02 NO GRID". */
function isStructure(name: string): boolean {
  const bare = name.replace(FORMAT_NOTE, ' ').replace(/[\s\-–_.,]+/g, ' ').trim().toLowerCase()
  return !bare || GENERIC.has(bare) || NOT_A_NAME.test(bare)
}

export interface FolderChain {
  /** Folders that name something, outermost first; structure such as "02 NO GRID" drops out. */
  names: string[]
  underPlatform: boolean
}

export function folderChain(segments: string[]): FolderChain {
  const names: string[] = []
  let underPlatform = false
  for (const segment of segments) {
    const name = cleanFolder(segment)
    const lower = name.toLowerCase()
    if (PLATFORMS.has(lower)) underPlatform = true
    if (!name || GENERIC.has(lower) || NOT_A_NAME.test(name) || isStructure(name)) continue
    if (names.at(-1)?.toLowerCase() !== lower) names.push(name)
  }
  return { names, underPlatform }
}

const nameWords = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3)

export const mentions = (folder: string, fileName: string) => {
  const inFile = new Set(nameWords(fileName))
  return nameWords(folder).some((w) => inFile.has(w))
}

/**
 * Two named folders read as creator then project. A lone folder is a project when
 * its files echo its name ("Butterskull/Butterskull Ranch.jpg") and a creator otherwise.
 */
export function provenance(chain: FolderChain, shareMentioningFolder: number): { creator: string; pack: string } {
  const [first = '', second = ''] = chain.names
  if (second) return { creator: first, pack: second }
  return !chain.underPlatform && shareMentioningFolder >= 1 / 3 ? { creator: '', pack: first } : { creator: first, pack: '' }
}

const SYSTEM_DIR = /^__macosx$/i

/** Packs bundle tokens, covers and art with the maps; the scan rules keep those out of the library. */
export function isLikelyMap(dirs: string[], stem: string): boolean {
  if (dirs.some((d) => SYSTEM_DIR.test(d))) return false
  const name = stem.replace(/_/g, ' ')
  const skipped = dirs.some((d) => test(current.skipFolder, d.replace(/_/g, ' ').trim())) || test(current.skipFile, name)
  return !skipped || dirs.some((d) => test(current.include, d.replace(/_/g, ' '))) || test(current.include, name)
}

/** Overlays are pieces laid over a map, such as an opened roof or a moved wall; they belong to its scene. */
export function isOverlay(dirs: string[], stem: string): boolean {
  return dirs.some((d) => test(current.overlays, d.replace(/_/g, ' '))) || test(current.overlays, stem.replace(/_/g, ' '))
}

const KEYWORDS: Record<string, string[]> = {
  Forest: ['forest', 'woods', 'woodland', 'grove', 'jungle', 'glade', 'thicket', 'treetop', 'mushroom'],
  Grassland: ['meadow', 'field', 'plains', 'grassland', 'farm', 'hill', 'hills', 'prairie', 'garden', 'pasture'],
  Mountain: ['mountain', 'cliff', 'canyon', 'peak', 'pass', 'ravine', 'gorge', 'quarry'],
  Desert: ['desert', 'dune', 'dunes', 'oasis', 'sand', 'wasteland', 'badlands'],
  Arctic: ['snow', 'ice', 'frozen', 'glacier', 'arctic', 'tundra', 'winter'],
  Swamp: ['swamp', 'bog', 'marsh', 'mire', 'bayou', 'fen'],
  Coast: ['coast', 'beach', 'shore', 'harbor', 'harbour', 'dock', 'docks', 'port', 'pier', 'island', 'lighthouse'],
  Water: ['river', 'lake', 'waterfall', 'underwater', 'sea', 'ocean', 'ship', 'boat', 'reef', 'sunken'],
  Cave: ['cave', 'cavern', 'grotto', 'underdark', 'mine', 'tunnel', 'lair', 'spiral'],
  Dungeon: ['dungeon', 'crypt', 'tomb', 'catacomb', 'catacombs', 'sewer', 'prison', 'vault', 'labyrinth', 'hold'],
  Castle: ['castle', 'keep', 'fortress', 'fort', 'citadel', 'throne', 'palace', 'tower', 'stronghold'],
  Town: ['town', 'city', 'village', 'street', 'market', 'square', 'alley', 'tavern', 'inn', 'shop', 'camp'],
  Temple: ['temple', 'shrine', 'church', 'monastery', 'chapel', 'cathedral', 'altar', 'ruins', 'ruin'],
  Arcane: ['wizard', 'arcane', 'laboratory', 'library', 'planar', 'astral', 'feywild', 'magic', 'void', 'hell', 'infernal'],
}
const TIMES: Record<string, string[]> = {
  Day: ['day', 'daytime', 'noon'],
  Night: ['night', 'nighttime', 'midnight', 'moonlit'],
  Dusk: ['dusk', 'sunset', 'evening', 'twilight'],
  Dawn: ['dawn', 'sunrise', 'morning'],
}
const WEATHERS: Record<string, string[]> = {
  Rain: ['rain', 'rainy', 'storm', 'stormy', 'thunderstorm'],
  Fog: ['fog', 'foggy', 'mist', 'misty'],
  Snow: ['snow', 'snowy', 'blizzard', 'winter'],
  Fire: ['fire', 'burning', 'burnt', 'lava', 'ember', 'inferno'],
}

const CONDITION_WORDS = new Set([
  ...Object.values(TIMES).flat(), ...Object.values(WEATHERS).flat(), 'floor', 'level', 'lvl', 'storey', 'story', 'deck',
  'clean', 'empty', 'furnished', 'unfurnished', 'labelled', 'labeled', 'unlabelled', 'unlabeled', 'keyed',
  'outside', 'outdoors', 'roofless', 'cutaway', 'open', 'closed',
])

/** Whether these words only describe a state of a map rather than a different place. */
export function describesCondition(words: string[]): boolean {
  return words.every((w, i) => {
    const lower = w.toLowerCase()
    return CONDITION_WORDS.has(lower) || current.variants.has(lower) || levelOf([lower]) !== null || (/^\d+$/.test(lower) && levelOf(words.slice(i - 1, i + 1)) !== null)
  })
}

export function variantKind(words: string[], labelled: boolean): VariantKind {
  if (levelOf(words) !== null) return 'level'
  const seen = new Set(words.map((w) => w.toLowerCase()))
  if (matches(TIMES, seen).length) return 'lighting'
  if (matches(WEATHERS, seen).length) return 'weather'
  return labelled ? 'labels' : 'other'
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z]+/).filter(Boolean))
}

function matches(table: Record<string, string[]>, seen: Set<string>): string[] {
  return Object.keys(table).filter((k) => table[k].some((w) => seen.has(w)))
}

export function classify(name: string, path: string) {
  const own = words(name)
  return {
    time: matches(TIMES, own)[0] ?? '',
    weather: matches(WEATHERS, own)[0] ?? '',
    biomes: matches(KEYWORDS, words(`${path} ${name}`)),
  }
}
