import type { GridType } from './types.ts'

export type { GridType }

// Page geometry shared by the print preview and the PDF generator, so that what
// the browser shows and what the server prints cannot drift apart.
// All positions are millimetres on the map plane; (0,0) is the image's top-left.

export interface Paper {
  id: string
  label: string
  w: number
  h: number
}

const inch = (w: number, h: number) => ({ w: w * 25.4, h: h * 25.4 })

export const PAPERS: Paper[] = [
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'a3', label: 'A3', w: 297, h: 420 },
  { id: 'a2', label: 'A2', w: 420, h: 594 },
  { id: 'a1', label: 'A1', w: 594, h: 841 },
  { id: 'a0', label: 'A0', w: 841, h: 1189 },
  { id: 'letter', label: 'Letter', ...inch(8.5, 11) },
  { id: 'legal', label: 'Legal', ...inch(8.5, 14) },
  { id: 'tabloid', label: 'Tabloid', ...inch(11, 17) },
  { id: 'ledger', label: 'Ledger', ...inch(17, 11) },
  { id: 'government-letter', label: 'Government letter', ...inch(8, 10.5) },
  { id: 'junior-legal', label: 'Junior legal', ...inch(5, 8) },
  { id: 'poster-18x24', label: 'Poster / blueprint 18×24″', ...inch(18, 24) },
  { id: 'poster-24x36', label: 'Poster / blueprint 24×36″', ...inch(24, 36) },
  { id: 'blueprint-30x42', label: 'Blueprint 30×42″', ...inch(30, 42) },
  { id: 'blueprint-36x48', label: 'Blueprint 36×48″', ...inch(36, 48) },
]

export type Orientation = 'auto' | 'portrait' | 'landscape'

export interface PageSpec {
  paperW: number
  paperH: number
  orientation: Orientation
  marginMm: number
  overlapMm: number
  /** Physical length of one square, or the width of one hex. */
  squareMm: number
  /** Shrink each page to whole squares so seams fall on grid lines. */
  seamsOnGrid: boolean
  /** Spread spare sheet area evenly around the map instead of leaving it all at the far edge. */
  centered?: boolean
}

export interface Plane {
  w: number
  h: number
  /** First grid line, in mm from the image's left and top edges. */
  offsetX: number
  offsetY: number
}

/** A sheet of paper: `x,y,w,h` is the printed area, `sheetW,sheetH` the whole sheet. */
export interface Page {
  x: number
  y: number
  w: number
  h: number
  sheetW: number
  sheetH: number
}

const EPSILON = 0.01

function axis(length: number, offset: number, printable: number, spec: PageSpec) {
  const { overlapMm: overlap, squareMm: square, seamsOnGrid } = spec
  let step = printable - overlap
  if (seamsOnGrid) {
    const whole = Math.floor((step + EPSILON) / square)
    if (whole >= 1) step = whole * square
  }
  if (step <= 0) return { start: 0, step: 0, size: 0, count: 0 }
  const size = step + overlap
  const phase = seamsOnGrid ? ((offset % square) + square) % square : 0
  let start = phase > EPSILON && square - phase > EPSILON ? phase - square : 0
  let count = Math.max(1, Math.ceil((length - start - overlap - EPSILON) / step))
  if (spec.centered) {
    start = (length - (count * step + overlap)) / 2
    if (seamsOnGrid) {
      start = phase + Math.round((start - phase) / square) * square
      if (start > EPSILON) start -= square
      if (start + count * step + overlap < length - EPSILON) count++
    }
  }
  return { start, step, size, count }
}

function layoutFor(plane: Plane, spec: PageSpec, sheetW: number, sheetH: number) {
  const x = axis(plane.w, plane.offsetX, sheetW - spec.marginMm * 2, spec)
  const y = axis(plane.h, plane.offsetY, sheetH - spec.marginMm * 2, spec)
  return { x, y, sheetW, sheetH, count: x.count * y.count }
}

function bestLayout(plane: Plane, spec: PageSpec) {
  const short = Math.min(spec.paperW, spec.paperH)
  const long = Math.max(spec.paperW, spec.paperH)
  const portrait = layoutFor(plane, spec, short, long)
  const landscape = layoutFor(plane, spec, long, short)
  if (spec.orientation === 'portrait') return portrait
  if (spec.orientation === 'landscape') return landscape
  return landscape.count < portrait.count ? landscape : portrait
}

export function generatePages(plane: Plane, spec: PageSpec): Page[] {
  const { x, y, sheetW, sheetH, count } = bestLayout(plane, spec)
  if (!count) return []
  const pages: Page[] = []
  for (let row = 0; row < y.count; row++) {
    for (let col = 0; col < x.count; col++) {
      pages.push({
        x: x.start + col * x.step,
        y: y.start + row * y.step,
        w: x.size,
        h: y.size,
        sheetW,
        sheetH,
      })
    }
  }
  return pages
}

/** Lays sheets over just `crop`, keeping seams on the map's own grid lines. */
export function generatePagesIn(crop: Rect, plane: Plane, spec: PageSpec): Page[] {
  const local = { w: crop.w, h: crop.h, offsetX: plane.offsetX - crop.x, offsetY: plane.offsetY - crop.y }
  return generatePages(local, spec).map((p) => ({ ...p, x: p.x + crop.x, y: p.y + crop.y }))
}

export const FOG_TAB_MM = 6

export interface FogPiece {
  page: Page
  /** Whether a glue tab runs along this edge for the next piece to sit on. */
  tabRight: boolean
  tabBottom: boolean
}

/** Splits a fog area across sheets; `x,y` of each page are relative to the area. */
export function fogPieces(area: Rect, sheetW: number, sheetH: number, marginMm: number, squareMm: number): FogPiece[] {
  const spec: PageSpec = {
    paperW: sheetW, paperH: sheetH, orientation: 'auto', marginMm, overlapMm: FOG_TAB_MM, squareMm, seamsOnGrid: false,
  }
  return generatePages({ w: area.w, h: area.h, offsetX: 0, offsetY: 0 }, spec).map((piece) => ({
    page: { ...piece, w: Math.min(piece.w, area.w - piece.x), h: Math.min(piece.h, area.h - piece.y) },
    tabRight: piece.x + piece.w < area.w - EPSILON,
    tabBottom: piece.y + piece.h < area.h - EPSILON,
  }))
}

export function sheetCount(plane: Plane, spec: PageSpec): number {
  return bestLayout(plane, spec).count
}

/** Spreadsheet-style name of the n-th sheet in a row of `columns`: A1, B1, … */
export function pageLabel(index: number, columns: number): string {
  const col = index % columns
  const row = Math.floor(index / columns)
  return `${col < 26 ? String.fromCharCode(65 + col) : `C${col + 1}`}${row + 1}`
}

export function columnsOf(pages: Page[]): number {
  if (!pages.length) return 1
  const y = pages[0].y
  let n = 0
  while (n < pages.length && pages[n].y === y) n++
  return n
}

export function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const r = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  return r - x > EPSILON && bottom - y > EPSILON ? { x, y, w: r - x, h: bottom - y } : null
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Segment = [x1: number, y1: number, x2: number, y2: number]

/** The whole sheet of paper on the map plane: the printed area sits centred on it. */
export function paperOf(page: Page): Rect {
  return { x: page.x - (page.sheetW - page.w) / 2, y: page.y - (page.sheetH - page.h) / 2, w: page.sheetW, h: page.sheetH }
}

/** What a sheet really shows: its printed area cut down to the image and the crop. */
export function contentOf(page: Rect, image: Rect, crop?: Rect | null): Rect | null {
  const shown = intersect(page, image)
  return shown && crop ? intersect(shown, crop) : shown
}

export type Side = 'top' | 'right' | 'bottom' | 'left'

export interface Edge {
  side: Side
  /**
   * Sheets join by overlapping, so each needs only two cuts: an edge facing an
   * earlier sheet (or the outside of the map) is cut, and an edge facing a later
   * sheet keeps its margin for that sheet's cut edge to lie on.
   */
  action: 'cut' | 'keep'
  /** Index of the sheet across this edge, or -1 on the map's outer edge. */
  neighbour: number
  /** The join line: the cut itself, or on a kept edge the neighbour's cut, which lies inside this sheet when sheets overlap. */
  at: number
  /** How far the two sheets' content overlaps across this edge. */
  overlap: number
}

export interface SheetPlan {
  content: Rect
  /** Top, right, bottom, left. */
  edges: Edge[]
}

/**
 * How much of the other axis `next` shares with `prev` if it continues it along
 * `axis` (starts inside `prev` or right at its end), else 0.
 */
function follows(prev: Rect, next: Rect, axis: 'x' | 'y'): number {
  const [p, n] = axis === 'x' ? [prev, next] : [swapRect(prev), swapRect(next)]
  if (n.x <= p.x + EPSILON || n.x > p.x + p.w + EPSILON) return 0
  const shared = Math.min(p.y + p.h, n.y + n.h) - Math.max(p.y, n.y)
  return shared > EPSILON ? shared : 0
}

/** The sheet that shares the longest stretch of edge, or -1. */
function closest(contents: (Rect | null)[], skip: number, shared: (other: Rect) => number): number {
  let best = -1
  let most = 0
  contents.forEach((other, j) => {
    const length = other && j !== skip ? shared(other) : 0
    if (length > most + EPSILON) [best, most] = [j, length]
  })
  return best
}

/**
 * Which edges of each sheet to cut and which to keep. Found from where sheets lie
 * rather than their order, so hand-placed sheets work too. Null where a sheet
 * shows nothing of the map.
 */
export function assemblyPlan(pages: Rect[], image: Rect, crop?: Rect | null): (SheetPlan | null)[] {
  const contents = pages.map((p) => contentOf(p, image, crop))
  return contents.map((c, i) => {
    if (!c) return null
    const cut = (side: 'top' | 'left', axis: 'x' | 'y'): Edge => {
      const n = closest(contents, i, (o) => follows(o, c, axis))
      const o = contents[n]
      const at = axis === 'x' ? c.x : c.y
      return { side, action: 'cut', neighbour: n, at, overlap: o ? (axis === 'x' ? o.x + o.w : o.y + o.h) - at : 0 }
    }
    const keep = (side: 'right' | 'bottom', axis: 'x' | 'y'): Edge => {
      const n = closest(contents, i, (o) => follows(c, o, axis))
      const o = contents[n]
      const end = axis === 'x' ? c.x + c.w : c.y + c.h
      if (!o) return { side, action: 'cut', neighbour: -1, at: end, overlap: 0 }
      const at = axis === 'x' ? o.x : o.y
      return { side, action: 'keep', neighbour: n, at, overlap: end - at }
    }
    return { content: c, edges: [cut('top', 'y'), keep('right', 'x'), keep('bottom', 'y'), cut('left', 'x')] }
  })
}

/**
 * An edge's line carried through the margins from just off the content's corners
 * out to the paper's edge, never over the map. Unlike corner ticks it survives the
 * perpendicular cut, because the kept margins always hold one end of it.
 */
export function edgeLines(paper: Rect, content: Rect, edge: Edge, gap = 1, shortest = 1): Segment[] {
  const vertical = edge.side === 'left' || edge.side === 'right'
  const [p, c] = vertical ? [swapRect(paper), swapRect(content)] : [paper, content]
  const lines: Segment[] = []
  if (c.x - gap - p.x >= shortest) lines.push([p.x, edge.at, c.x - gap, edge.at])
  if (p.x + p.w - (c.x + c.w + gap) >= shortest) lines.push([c.x + c.w + gap, edge.at, p.x + p.w, edge.at])
  return vertical ? lines.map(([a, b, d, e]): Segment => [b, a, e, d]) : lines
}

export interface HexCell {
  cx: number
  cy: number
  col: number
  row: number
}

/** Flat-top hex rows; `size` is the corner-to-corner width. */
function hexCells(rect: Rect, size: number, ox: number, oy: number): HexCell[] {
  const dx = size * 0.75
  const dy = (size * Math.sqrt(3)) / 2
  const cells: HexCell[] = []
  const firstCol = Math.floor((rect.x - ox) / dx) - 1
  const lastCol = Math.ceil((rect.x + rect.w - ox) / dx) + 1
  const firstRow = Math.floor((rect.y - oy) / dy) - 1
  const lastRow = Math.ceil((rect.y + rect.h - oy) / dy) + 1
  for (let col = firstCol; col <= lastCol; col++) {
    for (let row = firstRow; row <= lastRow; row++) {
      cells.push({ cx: ox + col * dx, cy: oy + (row + (col & 1 ? 0.5 : 0)) * dy, col, row })
    }
  }
  return cells
}

const hexRatio = 2 / Math.sqrt(3)
const swapRect = (r: Rect): Rect => ({ x: r.y, y: r.x, w: r.h, h: r.w })

function flatHexSegments(rect: Rect, size: number, ox: number, oy: number): Segment[] {
  const segments: Segment[] = []
  const r = size / 2
  const h = (size * Math.sqrt(3)) / 4
  for (const { cx, cy } of hexCells(rect, size, ox, oy)) {
    const corners: [number, number][] = [
      [cx - r, cy], [cx - r / 2, cy - h], [cx + r / 2, cy - h],
      [cx + r, cy], [cx + r / 2, cy + h], [cx - r / 2, cy + h],
    ]
    // Three edges per cell are enough; neighbours draw the rest.
    for (let i = 0; i < 3; i++) {
      const [a, b] = [corners[i], corners[i + 1]]
      segments.push([a[0], a[1], b[0], b[1]])
    }
  }
  return segments
}

/** Line segments covering `rect`; callers clip to it. `size` is a cell's width across the map. */
export function gridSegments(type: GridType, rect: Rect, size: number, ox: number, oy: number): Segment[] {
  if (type === 'hex') return flatHexSegments(rect, size, ox, oy)
  // A pointy-top grid is a flat-top one on its side, measured across its flats.
  if (type === 'hexPointy') {
    return flatHexSegments(swapRect(rect), size * hexRatio, oy, ox).map(([a, b, c, d]): Segment => [b, a, d, c])
  }
  const segments: Segment[] = []
  const right = rect.x + rect.w
  const bottom = rect.y + rect.h
  for (let x = ox + Math.ceil((rect.x - ox) / size) * size; x <= right; x += size) {
    segments.push([x, rect.y, x, bottom])
  }
  for (let y = oy + Math.ceil((rect.y - oy) / size) * size; y <= bottom; y += size) {
    segments.push([rect.x, y, right, y])
  }
  return segments
}

const COMMON_PPS = [140, 100, 70, 150, 200, 120, 72, 300, 280, 256, 128, 160, 250, 75, 50]

/** Plausible grids for a map with no evidence: common export sizes that divide it evenly first. */
export function gridCandidates(width: number, height: number): { pps: number; cols: number; rows: number }[] {
  return COMMON_PPS
    .map((pps) => ({ pps, cols: width / pps, rows: height / pps }))
    .filter((c) => c.cols >= 8 && c.rows >= 8 && c.cols <= 150 && c.rows <= 150)
    .map((c) => ({ ...c, misfit: Math.abs(c.cols - Math.round(c.cols)) + Math.abs(c.rows - Math.round(c.rows)) }))
    .sort((a, b) => a.misfit - b.misfit)
    .slice(0, 4)
    .map(({ pps, cols, rows }) => ({ pps, cols, rows }))
}

/** BattleTech-style CCRR labels, positioned just below each hex's top edge. */
export function hexNumbers(rect: Rect, size: number, ox: number, oy: number) {
  const labels: { x: number; y: number; text: string }[] = []
  for (const { cx, cy, col, row } of hexCells(rect, size, ox, oy)) {
    if (col < 0 || row < 0) continue
    const y = cy - (size * Math.sqrt(3)) / 4 + size * 0.09
    if (cx < rect.x || cx > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) continue
    labels.push({ x: cx, y, text: `${String(col + 1).padStart(2, '0')}${String(row + 1).padStart(2, '0')}` })
  }
  return labels
}
