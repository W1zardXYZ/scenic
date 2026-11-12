import { type Orientation, PAPERS, type PageSpec, sheetCount } from '../shared/layout.ts'
import type { Library, MapGroup, MapRecord } from '../shared/types.ts'
import { inScope, type Scope } from './scope.ts'

export interface Prefs {
  paperId: string
  orientation: Orientation
  marginMm: number
  overlapMm: number
  squareMm: number
  seamsOnGrid: boolean
  centered: boolean
  showSheets: boolean
  units: 'metric' | 'imperial'
  /** Single-letter keys in the print canvas, the map viewer and library search. */
  shortcuts: boolean
}

export const DEFAULT_PREFS: Prefs = {
  paperId: 'a4',
  orientation: 'auto',
  marginMm: 6.35,
  overlapMm: 0,
  squareMm: 25.4,
  seamsOnGrid: true,
  centered: false,
  showSheets: false,
  units: 'metric',
  shortcuts: true,
}

export function pageSpec(prefs: Prefs): PageSpec {
  const paper = PAPERS.find((p) => p.id === prefs.paperId) ?? PAPERS[0]
  return { ...prefs, paperW: paper.w, paperH: paper.h }
}

export interface Facts {
  cols: number
  rows: number
  ppi: number
  grade: string
  size: string
  shape: string
  ink: string
  sheets: number
}

export function grade(ppi: number): string {
  return ppi >= 130 ? 'Excellent' : ppi >= 90 ? 'Good' : ppi >= 60 ? 'Fair' : 'Low'
}

export function factsOf(m: MapRecord, spec: PageSpec): Facts {
  const cols = m.width / m.ppsX
  const rows = m.height / m.ppsY
  const ppi = m.ppsX / (spec.squareMm / 25.4)
  const longest = Math.max(cols, rows)
  const aspect = cols / rows
  return {
    cols,
    rows,
    ppi,
    grade: grade(ppi),
    size: longest <= 20 ? 'Small' : longest <= 40 ? 'Medium' : longest <= 70 ? 'Large' : 'Huge',
    shape: aspect > 1.15 ? 'Landscape' : aspect < 0.87 ? 'Portrait' : 'Square',
    ink: m.ink < 0.45 ? 'Light' : m.ink < 0.75 ? 'Medium' : 'Heavy',
    sheets: sheetCount(
      { w: cols * spec.squareMm, h: rows * spec.squareMm, offsetX: (m.offsetX / m.ppsX) * spec.squareMm, offsetY: (m.offsetY / m.ppsY) * spec.squareMm },
      spec,
    ),
  }
}

export const FACETS = {
  creator: { label: 'Creator', values: (m: MapRecord) => (m.creator ? [m.creator] : []) },
  pack: { label: 'Project', values: (m: MapRecord) => (m.pack ? [m.pack] : []) },
  biome: { label: 'Tags', values: (m: MapRecord) => m.biomes },
  time: { label: 'Time of day', values: (m: MapRecord) => (m.time ? [m.time] : []) },
  weather: { label: 'Weather', values: (m: MapRecord) => (m.weather ? [m.weather] : []) },
  grid: { label: 'Grid', values: (m: MapRecord) => [m.hasGrid ? 'Gridded' : 'Gridless'] },
  color: { label: 'Colour', values: (m: MapRecord) => m.colors },
  size: { label: 'Map size', values: (_: MapRecord, f: Facts) => [f.size] },
  shape: { label: 'Shape', values: (_: MapRecord, f: Facts) => [f.shape] },
  print: { label: 'Print quality', values: (_: MapRecord, f: Facts) => [f.grade] },
  ink: { label: 'Ink use', values: (_: MapRecord, f: Facts) => [f.ink] },
  format: { label: 'Format', values: (m: MapRecord) => [m.format.toUpperCase()] },
}

export type FacetKey = keyof typeof FACETS
export const FACET_KEYS = Object.keys(FACETS) as FacetKey[]

const VALUE_ORDER: Record<string, string[]> = {
  size: ['Small', 'Medium', 'Large', 'Huge'],
  print: ['Excellent', 'Good', 'Fair', 'Low'],
  ink: ['Light', 'Medium', 'Heavy'],
  shape: ['Square', 'Landscape', 'Portrait'],
  time: ['Day', 'Dawn', 'Dusk', 'Night'],
}

export type Sort = 'recent' | 'title' | 'largest' | 'resolution' | 'variants' | 'sheets'

export interface Filters {
  query: string
  selected: Partial<Record<FacetKey, string[]>>
  favorites: boolean
  vtt: boolean
  labelled: boolean
  unverified: boolean
  hidden: boolean
  maxSheets: number
  sort: Sort
}

export const NO_FILTERS: Filters = {
  query: '', selected: {}, favorites: false, vtt: false, labelled: false, unverified: false, hidden: false, maxSheets: 0, sort: 'recent',
}

export const activeCount = (f: Filters) =>
  Object.values(f.selected).reduce((n, v) => n + (v?.length ?? 0), 0) +
  [f.favorites, f.vtt, f.labelled, f.unverified, f.hidden, f.maxSheets > 0].filter(Boolean).length

export interface Index {
  byId: Map<number, MapRecord>
  facts: Map<number, Facts>
}

export function buildIndex(library: Library, spec: PageSpec): Index {
  return {
    byId: new Map(library.maps.map((m) => [m.id, m])),
    facts: new Map(library.maps.map((m) => [m.id, factsOf(m, spec)])),
  }
}

function mapPasses(m: MapRecord, facts: Facts, f: Filters, except?: FacetKey): boolean {
  if (m.hidden && !f.hidden) return false
  if (f.favorites && !m.favorite) return false
  if (f.vtt && !m.walls && !m.lights) return false
  if (f.labelled && !m.labelled) return false
  if (f.unverified && m.gridSource !== 'guess') return false
  if (f.maxSheets && facts.sheets > f.maxSheets) return false
  for (const key of FACET_KEYS) {
    const wanted = f.selected[key]
    if (!wanted?.length || key === except) continue
    const values = FACETS[key].values(m, facts)
    if (!values.some((v) => wanted.includes(v))) return false
  }
  return true
}

export interface GroupView {
  group: MapGroup
  /** The map to show first: the cover if it matches, else the best match. */
  pick: MapRecord
  facts: Facts
  /** One representative per variant, in display order, for hover scrubbing. */
  variants: MapRecord[]
}

/** The most useful single file of a variant: gridless and largest. */
export function bestVersion(maps: MapRecord[]): MapRecord {
  return [...maps].sort((a, b) => Number(a.hasGrid) - Number(b.hasGrid) || b.width - a.width || Number(a.format === 'jpg') - Number(b.format === 'jpg'))[0]
}

export function variantsOf(group: MapGroup, byId: Map<number, MapRecord>): MapRecord[] {
  const buckets = new Map<string, MapRecord[]>()
  for (const id of group.mapIds) {
    const m = byId.get(id)
    if (!m) continue
    const list = buckets.get(m.variant)
    if (list) list.push(m)
    else buckets.set(m.variant, [m])
  }
  return [...buckets.values()].map(bestVersion)
}

export interface Result {
  groups: GroupView[]
  facets: Record<FacetKey, [string, number][]>
}

export function applyFilters(library: Library, index: Index, f: Filters, scope: Scope = {}): Result {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean)
  const textMatches = library.groups.filter((g) => {
    if (!inScope(g, scope)) return false
    if (!words.length) return true
    const text = [g.title, g.pack, g.creator, g.description ?? '', ...(g.suggestedTags ?? []), ...g.mapIds.map((id) => `${index.byId.get(id)?.rel ?? ''} ${index.byId.get(id)?.variant ?? ''} ${index.byId.get(id)?.biomes.join(' ') ?? ''}`)].join(' ').toLowerCase()
    return words.every((w) => text.includes(w))
  })

  const counts = {} as Record<FacetKey, Map<string, number>>
  for (const key of FACET_KEYS) counts[key] = new Map()

  const groups: GroupView[] = []
  for (const group of textMatches) {
    const maps = group.mapIds.map((id) => index.byId.get(id)).filter((m) => m !== undefined)
    const passing = maps.filter((m) => mapPasses(m, index.facts.get(m.id)!, f))
    if (passing.length) {
      const cover = passing.find((m) => m.id === group.coverId) ?? bestVersion(passing)
      groups.push({ group, pick: cover, facts: index.facts.get(cover.id)!, variants: variantsOf(group, index.byId) })
    }
    for (const key of FACET_KEYS) {
      const seen = new Set<string>()
      for (const m of maps) {
        const facts = index.facts.get(m.id)!
        if (mapPasses(m, facts, f, key)) for (const v of FACETS[key].values(m, facts)) seen.add(v)
      }
      for (const v of seen) counts[key].set(v, (counts[key].get(v) ?? 0) + 1)
    }
  }

  const compare: Record<Sort, (a: GroupView, b: GroupView) => number> = {
    recent: (a, b) => b.pick.mtime - a.pick.mtime || a.group.title.localeCompare(b.group.title),
    title: (a, b) => a.group.title.localeCompare(b.group.title),
    largest: (a, b) => b.facts.cols * b.facts.rows - a.facts.cols * a.facts.rows,
    resolution: (a, b) => b.facts.ppi - a.facts.ppi,
    variants: (a, b) => b.variants.length - a.variants.length,
    sheets: (a, b) => a.facts.sheets - b.facts.sheets,
  }
  groups.sort(compare[f.sort])

  const facets = {} as Result['facets']
  for (const key of FACET_KEYS) {
    const order = VALUE_ORDER[key]
    facets[key] = [...counts[key].entries()].sort((a, b) =>
      order ? order.indexOf(a[0]) - order.indexOf(b[0]) : b[1] - a[1] || a[0].localeCompare(b[0]),
    )
  }
  return { groups, facets }
}
