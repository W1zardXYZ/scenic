import { type Rect, PAPERS } from '../../shared/layout.ts'
import { FADE_MAX_MM } from '../../shared/fade.ts'
import { type Fog, NEW_FOG } from '../../shared/fog.ts'
import { type Look } from '../../shared/look.ts'
import { invalidFilter, NEW_FILTER } from '../../shared/tone.ts'
import type { MapRecord } from '../../shared/types.ts'
import type { Prefs } from '../filters.ts'
import type { Filter, Grid, LabeledPage, Marks, Overlay } from './types.ts'

export type PaperPrefs = Pick<Prefs, 'squareMm' | 'paperId' | 'orientation' | 'marginMm' | 'overlapMm' | 'seamsOnGrid' | 'centered'>
export interface Output {
  format: 'pdf' | 'png'
  quality: 'high' | 'balanced' | 'small'
}

/** Everything about a print that is the user's choice, as saved for a map and as copied between sessions. */
export interface Snapshot {
  grid: Grid
  overlay: Overlay
  filter: Filter
  marks: Marks
  fadeMm: number
  /** Shares of the map rather than millimetres, so they hold when the scale changes. */
  fogShare: Fog
  cropShare: Rect | null
  /** Hand-arranged sheets; null while they follow the layout. */
  manual: LabeledPage[] | null
  output: Output
  paper: PaperPrefs
  /** The look this map's tones started from, if any. */
  lookId: number | null
}

export const DEFAULT_MARKS: Marks = { cut: true, labels: true, overview: true }
export const DEFAULT_OUTPUT: Output = { format: 'pdf', quality: 'high' }

export const measuredGrid = (map: MapRecord): Grid => ({
  type: map.gridType, cols: map.width / map.ppsX, rows: map.height / map.ppsY, offsetX: map.offsetX, offsetY: map.offsetY,
})

export const defaultOverlay = (map: MapRecord): Overlay => ({ show: !map.hasGrid, color: '#000000', opacity: 0.35, widthMm: 0.2, numbering: false })

export const paperOf = ({ squareMm, paperId, orientation, marginMm, overlapMm, seamsOnGrid, centered }: Prefs): PaperPrefs =>
  ({ squareMm, paperId, orientation, marginMm, overlapMm, seamsOnGrid, centered })

export const lookOf = (s: Pick<Snapshot, 'filter' | 'fadeMm'>): Look => ({ filter: s.filter, fadeMm: s.fadeMm })

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown, min = -1e9, max = 1e9): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

/**
 * Settings from the server back into a snapshot. Anything missing or unusable, such
 * as a field a newer version added, falls back to `base`, so old copies keep loading.
 */
export function readSnapshot(raw: unknown, base: Snapshot): Snapshot {
  if (!isObject(raw)) return base
  const { grid, overlay, filter, marks, fadeMm, fogShare, cropShare, manual, output, paper, lookId } = raw
  const fog = isObject(fogShare) && Array.isArray(fogShare.items) ? ({ ...NEW_FOG, ...fogShare } as Fog) : base.fogShare
  const box = isObject(cropShare) && num(cropShare.x) && num(cropShare.y) && num(cropShare.w, 0) && num(cropShare.h, 0) ? (cropShare as unknown as Rect) : null
  const paperPrefs = isObject(paper) ? paper : {}
  return {
    grid: isObject(grid) && num(grid.cols, 0.1, 5000) && num(grid.rows, 0.1, 5000) && num(grid.offsetX) && num(grid.offsetY) && ['square', 'hex', 'hexPointy'].includes(grid.type as string)
      ? (grid as unknown as Grid) : base.grid,
    overlay: isObject(overlay) ? { ...base.overlay, ...overlay } : base.overlay,
    filter: isObject(filter) && !invalidFilter(filter as unknown as Filter) ? (filter as unknown as Filter) : NEW_FILTER,
    marks: isObject(marks) ? { ...base.marks, ...marks } : base.marks,
    fadeMm: num(fadeMm, 0, FADE_MAX_MM) ? fadeMm : 0,
    fogShare: fog,
    cropShare: box,
    manual: Array.isArray(manual) && manual.length ? (manual as LabeledPage[]) : null,
    output: isObject(output) && ['pdf', 'png'].includes(output.format as string) && ['high', 'balanced', 'small'].includes(output.quality as string) ? (output as unknown as Output) : base.output,
    paper: {
      squareMm: num(paperPrefs.squareMm, 1, 500) ? paperPrefs.squareMm : base.paper.squareMm,
      paperId: PAPERS.some((p) => p.id === paperPrefs.paperId) ? (paperPrefs.paperId as string) : base.paper.paperId,
      orientation: ['auto', 'portrait', 'landscape'].includes(paperPrefs.orientation as string) ? (paperPrefs.orientation as Prefs['orientation']) : base.paper.orientation,
      marginMm: num(paperPrefs.marginMm, 0, 100) ? paperPrefs.marginMm : base.paper.marginMm,
      overlapMm: num(paperPrefs.overlapMm, 0, 100) ? paperPrefs.overlapMm : base.paper.overlapMm,
      seamsOnGrid: typeof paperPrefs.seamsOnGrid === 'boolean' ? paperPrefs.seamsOnGrid : base.paper.seamsOnGrid,
      centered: typeof paperPrefs.centered === 'boolean' ? paperPrefs.centered : base.paper.centered,
    },
    lookId: typeof lookId === 'number' ? lookId : null,
  }
}
