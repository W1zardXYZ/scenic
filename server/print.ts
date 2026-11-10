import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import yazl from 'yazl'
import {
  assemblyPlan, type Edge, edgeLines, FOG_TAB_MM, PAPERS, gridSegments, hexNumbers, intersect, type Page, paperOf, type Rect,
  type Segment, type Side,
} from '../shared/layout.ts'
import { fadeMask, fadeRegion } from '../shared/fade.ts'
import {
  bakedFog, type Fog, type FogCard, type FogItem, type FogPart, type FogPlan, fogBounds, fogPath, fogPlan, inkOn, labelRoom, labelTone, separateFog,
  touches,
} from '../shared/fog.ts'
import type { GridType } from '../shared/types.ts'
import { type Filter, filterPixels, FUZZINESS, HUES, isPlain, MAX_BANDS, MAX_CURVE_POINTS, MAX_SAMPLES, MAX_SELECTIONS } from '../shared/tone.ts'
import { PIXEL_LIMIT } from './analyze.ts'
import type { FileRow } from './db.ts'
import { safeName } from './export.ts'
import { capHeight, FONT_FILE, textPath, textWidth, type Weight } from './font.ts'
import { thumbPath } from './scan.ts'
import { cached, cachePath, localImage } from './source.ts'

const MM = 72 / 25.4
const MAX_PPI = { high: 300, balanced: 200, small: 150 }
const JPEG_QUALITY = { high: 92, balanced: 82, small: 68 }
const PARALLEL_TILES = 3
/** Fog is flat colour and thin lines, so it needs no more than this however sharp the map is. */
const FOG_PX_PER_MM = 200 / 25.4
/** The fade is a slow ramp, so 100 ppi is already finer than any step in it could show. */
const FADE_PX_PER_MM = 100 / 25.4

export type LabeledPage = Page & { label: string }

export interface PrintRequest {
  mapId: number
  squareMm: number
  marginMm: number
  grid: { type: GridType; cols: number; rows: number; offsetX: number; offsetY: number }
  overlay: { show: boolean; color: string; opacity: number; widthMm: number; numbering: boolean }
  pages: LabeledPage[]
  filter: Filter
  marks: { cut: boolean; labels: boolean; overview: boolean }
  fog: Fog
  /** Prints only this part of the map, in mm on the map plane. */
  crop?: Rect
  /** Width of the band over which the printed area's outer edge fades to white; absent or 0 is off. */
  fadeMm?: number
  output: { format: 'pdf' | 'png'; quality: keyof typeof MAX_PPI }
}

const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
const isRect = (r: Rect) => [r?.x, r?.y].every((v) => finite(v, -1e6, 1e6)) && [r?.w, r?.h].every((v) => finite(v, 0.1, 1e6))
const isCurve = (points: FogPart['points']) => Array.isArray(points) && points.length >= 3 && points.length <= 2000 &&
  points.every((p) => [p?.x, p?.y, p?.inX, p?.inY, p?.outX, p?.outY].every((v) => finite(v, -1e6, 1e6)))
const isFogItem = (item: FogItem) => typeof item?.name === 'string' && item.name.length <= 60 && typeof item.on === 'boolean' &&
  ['cover', 'show'].includes(item.mode) && Array.isArray(item.parts) && item.parts.length >= 1 && item.parts.length <= 100 &&
  item.parts.every((part) => typeof part?.subtract === 'boolean' && (part.box ? isRect(part.box) : isCurve(part.points)))

const isToneCurve = (curve: Filter['curve']) => Array.isArray(curve) && curve.length >= 2 && curve.length <= MAX_CURVE_POINTS &&
  curve.every((p, i) => Array.isArray(p) && p.length === 2 && finite(p[0], 0, 255) && finite(p[1], 0, 255) && (i === 0 || p[0] > curve[i - 1][0]))
const isBand = (b: Filter['bands'][number]) => [b?.from, b?.to, b?.soft].every((v) => finite(v, 0, 255)) && b.from <= b.to && finite(b.amount, -1, 1)

const isSelection = (s: Filter['selections'][number]) => Array.isArray(s?.samples) && s.samples.length <= MAX_SAMPLES &&
  s.samples.every((x) => typeof x?.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) && typeof x.subtract === 'boolean') &&
  finite(s.fuzziness, FUZZINESS.min, FUZZINESS.max) && isToneCurve(s.curve) && finite(s.amount, -1, 1)

const MAX_FOG_CARDS = 1000

/**
 * At most how many cards the separate fog splits into, worked out cheaply. A
 * cover far larger than its paper would otherwise be split into millions of
 * pieces before anything could refuse it.
 */
function fogCardBound(q: PrintRequest): number {
  const covers = separateFog(q.fog)
  if (!covers.length) return 0
  const paper = PAPERS.find((p) => p.id === q.fog.paper) ?? { w: q.pages[0].sheetW, h: q.pages[0].sheetH }
  const step = Math.min(paper.w, paper.h) - q.marginMm * 2 - FOG_TAB_MM
  if (step < 1) return Infinity
  return covers.reduce((n, item) => {
    const { w, h } = fogBounds(item)
    return n + Math.max(1, Math.ceil(w / step)) * Math.max(1, Math.ceil(h / step))
  }, 0)
}

/** Everything here arrives from the browser and ends up in sharp, SVG or a PDF. */
export function validatePrint(q: PrintRequest): string | null {
  if (!finite(q?.mapId, 1, 2 ** 53)) return 'mapId'
  if (!finite(q.squareMm, 1, 500) || !finite(q.marginMm, 0, 100)) return 'scale'
  if (!q.grid || !['square', 'hex', 'hexPointy'].includes(q.grid.type) || !finite(q.grid.cols, 0.1, 5000) || !finite(q.grid.rows, 0.1, 5000)) return 'grid'
  if (!finite(q.grid.offsetX, -1e6, 1e6) || !finite(q.grid.offsetY, -1e6, 1e6)) return 'grid offset'
  if (!q.overlay || !/^#[0-9a-f]{6}$/i.test(q.overlay.color) || !finite(q.overlay.opacity, 0, 1) || !finite(q.overlay.widthMm, 0, 10)) return 'overlay'
  if (!Array.isArray(q.pages) || !q.pages.length || q.pages.length > 2000) return 'pages'
  if (!q.pages.every((p) => isRect(p) && finite(p.sheetW, 10, 2000) && finite(p.sheetH, 10, 2000) && typeof p.label === 'string' && p.label.length <= 16)) return 'pages'
  if (!q.filter || !['color', 'grey', 'light', 'threshold'].includes(q.filter.mode) || !finite(q.filter.amount, 0, 1)) return 'filter'
  const { black, white, gamma } = q.filter.levels ?? {}
  if (!finite(black, 0, 254) || !finite(white, 1, 255) || black >= white || !finite(gamma, 0.1, 10)) return 'levels'
  if (!isToneCurve(q.filter.curve)) return 'curve'
  if (!Array.isArray(q.filter.bands) || q.filter.bands.length > MAX_BANDS || !q.filter.bands.every(isBand)) return 'bands'
  if (!Array.isArray(q.filter.hues) || q.filter.hues.length !== HUES.length || !q.filter.hues.every((h) => finite(h, -1, 1))) return 'hues'
  if (!Array.isArray(q.filter.selections) || q.filter.selections.length > MAX_SELECTIONS || !q.filter.selections.every(isSelection)) return 'selections'
  if (!q.marks) return 'marks'
  if (!q.fog || !Array.isArray(q.fog.items) || q.fog.items.length > 100 || !q.fog.items.every(isFogItem) || !/^#[0-9a-f]{6}$/i.test(q.fog.fill) ||
    !['undefined', 'boolean'].includes(typeof q.fog.names) || (q.fog.paper !== undefined && !PAPERS.some((p) => p.id === q.fog.paper))) return 'fog'
  if (q.crop && !isRect(q.crop)) return 'crop'
  if (q.fadeMm !== undefined && !finite(q.fadeMm, 0, 200)) return 'fade'
  if (fogCardBound(q) > MAX_FOG_CARDS) return 'fog size'
  if (!q.output || !['pdf', 'png'].includes(q.output.format) || !(q.output.quality in MAX_PPI)) return 'output'
  return null
}

/**
 * Decodes the source into an uncompressed, memory-mapped file once. Every tile
 * after that is a cheap random-access crop rather than a fresh JPEG decode.
 */
function preparedRaster(file: FileRow, filter: PrintRequest['filter']): Promise<string> {
  const key = `raster|${file.path}|${file.entry}|${file.mtime}|${JSON.stringify(filter)}`
  return cached(cachePath(key, '.v'), async (temp) => {
    const image = sharp(await localImage(file), { limitInputPixels: PIXEL_LIMIT })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
    if (!isPlain(filter)) {
      const { data: rgb, info } = await image.removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const { data, channels } = filterPixels(rgb, filter)
      await sharp(data, { raw: { width: info.width, height: info.height, channels } }).toFile(temp)
      return
    }
    await image.toFile(temp)
  })
}

interface Sheet {
  w: number
  h: number
  /** Where the printed area sits on the sheet. */
  left: number
  top: number
  page: LabeledPage
}

function sheetOf(page: LabeledPage): Sheet {
  return { w: page.sheetW, h: page.sheetH, left: (page.sheetW - page.w) / 2, top: (page.sheetH - page.h) / 2, page }
}

interface Tile {
  data: Buffer
  /** Placement relative to the printed area, in mm. */
  x: number
  y: number
  w: number
  h: number
}

async function renderTile(raster: string, q: PrintRequest, file: FileRow, page: Page, encode: 'jpeg' | 'png'): Promise<Tile | null> {
  const pxPerMmX = file.width / q.grid.cols / q.squareMm
  const pxPerMmY = file.height / q.grid.rows / q.squareMm
  const image = { x: 0, y: 0, w: file.width / pxPerMmX, h: file.height / pxPerMmY }
  const visible = q.crop ? intersect(image, q.crop) : image
  const clip = visible && intersect(page, visible)
  if (!clip) return null
  const left = Math.max(0, Math.floor(clip.x * pxPerMmX))
  const top = Math.max(0, Math.floor(clip.y * pxPerMmY))
  const right = Math.min(file.width, Math.ceil((clip.x + clip.w) * pxPerMmX))
  const bottom = Math.min(file.height, Math.ceil((clip.y + clip.h) * pxPerMmY))
  if (right <= left || bottom <= top) return null

  const tile = sharp(raster, { limitInputPixels: PIXEL_LIMIT }).extract({ left, top, width: right - left, height: bottom - top })
  const ppi = pxPerMmX * 25.4
  const cap = MAX_PPI[q.output.quality]
  if (ppi > cap) tile.resize(Math.round(((right - left) * cap) / ppi))
  const data = encode === 'jpeg'
    ? await tile.jpeg({ quality: JPEG_QUALITY[q.output.quality], chromaSubsampling: '4:4:4' }).toBuffer()
    : await tile.png({ compressionLevel: 6 }).toBuffer()
  return {
    data,
    x: left / pxPerMmX - page.x,
    y: top / pxPerMmY - page.y,
    w: (right - left) / pxPerMmX,
    h: (bottom - top) / pxPerMmY,
  }
}

/** Renders tiles a few at a time while handing them out in page order. */
async function* tiles<T, R>(items: T[], render: (item: T) => Promise<R>): AsyncGenerator<[T, R]> {
  const running: Promise<[T, R]>[] = []
  for (const item of items) {
    running.push(render(item).then((result) => [item, result]))
    if (running.length >= PARALLEL_TILES) yield await running.shift()!
  }
  while (running.length) yield await running.shift()!
}

/** A line of text in a margin, centred on (x, y) or starting there, turned by `angle` degrees. */
interface Note {
  x: number
  y: number
  angle: number
  anchor: 'start' | 'middle'
  text: string
}

interface Overlay {
  /** Where the grid may draw, relative to the printed area. */
  clip: Rect
  grid: Segment[]
  numbers: { x: number; y: number; text: string }[]
  /** Solid hairlines to trim along. */
  cuts: Segment[]
  /** Dashed hairlines on kept edges, where the next sheet's cut edge goes. */
  joins: Segment[]
  notes: Note[]
}

const MARK_INK = '#808080'
const MARK_MM = 0.15
const MARK_DASH = [1.2, 0.8]
const NOTE_PT = 6
const NOTE_MM = (NOTE_PT * 25.4) / 72
/** Shortens a note to `mm` using the bundled font's real advances, so the PDF and the PNG agree. */
const fitText = (text: string, mm: number) => {
  if (textWidth(text, NOTE_MM) <= mm) return text
  for (let n = text.length - 1; n > 3; n--) {
    const short = `${text.slice(0, n).trimEnd()}…`
    if (textWidth(short, NOTE_MM) <= mm) return short
  }
  return ''
}

const imageRect = (q: PrintRequest): Rect => ({ x: 0, y: 0, w: q.grid.cols * q.squareMm, h: q.grid.rows * q.squareMm })

/** Worked out once per request, since each sheet's plan depends on all the others. */
const plans = new WeakMap<PrintRequest, ReturnType<typeof assemblyPlan>>()
const planFor = (q: PrintRequest) => {
  if (!plans.has(q)) plans.set(q, assemblyPlan(q.pages, imageRect(q), q.crop))
  return plans.get(q)!
}
const planOf = (q: PrintRequest, page: Page) => planFor(q)[q.pages.indexOf(page as LabeledPage)] ?? null

/** What each margin says: cut or keep, and which sheet lies across it. */
function edgeNote(q: PrintRequest, edge: Edge): string {
  const other = q.pages[edge.neighbour]?.label
  const overlap = edge.overlap > 0.5 ? `${Math.round(edge.overlap)} mm overlap` : ''
  if (edge.action === 'keep') {
    return `KEEP  ·  ${other} goes on top${overlap ? `, edge on dashed line (${overlap})` : ''}`
  }
  return other ? `CUT  ·  lay over ${other}${overlap ? ` (${overlap})` : ''}` : 'CUT  ·  map edge'
}

function overlayFor(q: PrintRequest, file: FileRow, sheet: Sheet): Overlay {
  const { page } = sheet
  const offsetX = (q.grid.offsetX / (file.width / q.grid.cols)) * q.squareMm
  const offsetY = (q.grid.offsetY / (file.height / q.grid.rows)) * q.squareMm
  const shift = ([a, b, c, d]: Segment): Segment => [a - page.x, b - page.y, c - page.x, d - page.y]
  const plan = planOf(q, page)
  // The grid stops where the map does, leaving the margins to the marks.
  const area = plan?.content ?? null
  const grid = q.overlay.show && area ? gridSegments(q.grid.type, area, q.squareMm, offsetX, offsetY).map(shift) : []
  const clip = area ? { ...area, x: area.x - page.x, y: area.y - page.y } : { x: 0, y: 0, w: 0, h: 0 }
  const numbers = q.overlay.show && q.grid.type === 'hex' && q.overlay.numbering
    ? hexNumbers(page, q.squareMm, offsetX, offsetY).map((n) => ({ ...n, x: n.x - page.x, y: n.y - page.y }))
    : []

  const cuts: Segment[] = []
  const joins: Segment[] = []
  const notes: Note[] = []
  if (!plan) return { clip, grid, numbers, cuts, joins, notes }
  const paper = paperOf(page)
  const c = plan.content
  if (q.marks.cut) {
    for (const edge of plan.edges) (edge.action === 'cut' ? cuts : joins).push(...edgeLines(paper, c, edge).map(shift))
  }
  if (q.marks.labels) {
    // Notes sit just outside the content, inside the part of the margin a printer reaches.
    const room = { top: c.y - paper.y, bottom: paper.y + paper.h - c.y - c.h, left: c.x - paper.x, right: paper.x + paper.w - c.x - c.w }
    const away = (side: Side) => Math.min(3, room[side] / 2)
    const fits = (side: Side) => room[side] >= NOTE_MM + 1
    const cx = c.x + c.w / 2 - page.x
    const cy = c.y + c.h / 2 - page.y
    const title = `${page.label}   ${file.name.replace(/\s+/g, ' ')}`
    const labelW = Math.min(50, c.w * 0.25)
    for (const edge of plan.edges) {
      if (!fits(edge.side)) continue
      const along = edge.side === 'top' || edge.side === 'bottom' ? c.w - (edge.side === 'bottom' ? labelW * 2 + 6 : 4) : c.h - 4
      const text = fitText(edgeNote(q, edge), along)
      if (!text) continue
      const d = away(edge.side)
      if (edge.side === 'top') notes.push({ x: cx, y: c.y - d - page.y, angle: 0, anchor: 'middle', text })
      if (edge.side === 'bottom') notes.push({ x: cx, y: c.y + c.h + d - page.y, angle: 0, anchor: 'middle', text })
      if (edge.side === 'left') notes.push({ x: c.x - d - page.x, y: cy, angle: -90, anchor: 'middle', text })
      if (edge.side === 'right') notes.push({ x: c.x + c.w + d - page.x, y: cy, angle: 90, anchor: 'middle', text })
    }
    // Clear of the left edge's line, which runs down through this margin.
    const label = fitText(title, labelW)
    if (fits('bottom') && label) notes.push({ x: c.x + 1.5 - page.x, y: c.y + c.h + away('bottom') - page.y, angle: 0, anchor: 'start', text: label })
  }
  return { clip, grid, numbers, cuts, joins, notes }
}

/** Separate covers for this print, packed onto the same paper as the map. */
const fogPlanFor = (q: PrintRequest) => fogPlan(q.fog, q.pages[0].sheetW, q.pages[0].sheetH, q.marginMm, q.squareMm, q.crop)

const cardsBySheet = (plan: FogPlan) => Array.from({ length: plan.sheets }, (_, s) => plan.cards.filter((c) => c.placement.sheet === s))

const footprint = ({ region: r, placement }: FogCard) => (placement.rotated ? { w: r.h, h: r.w } : { w: r.w, h: r.h })

/** Where a point of the map lands on its card's sheet, turning with the card. */
function onSheet(q: PrintRequest, { region: r, placement: p }: FogCard, x: number, y: number): [number, number] {
  const [u, v] = [x - r.x, y - r.y]
  const [left, top] = [q.marginMm + p.x, q.marginMm + p.y]
  return p.rotated ? [left + r.h - v, top + u] : [left + u, top + v]
}

const CUT_LINE = 'stroke="#000" stroke-width="0.4"'
const fogSvgOpen = (view: Rect) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.w} ${view.h}">`

interface Label {
  text: string
  /** Centre of the text; `y` sits halfway up the capitals. */
  x: number
  y: number
  size: number
  weight: Weight
  color: string
  halo?: string
}

/** Text as outlines, since librsvg would look the font up through fontconfig and draw boxes on a bare server. */
const svgLabel = (l: Label) => {
  const d = textPath(l.text, l.x, l.y, l.size, l.weight)
  const halo = l.halo ? `<path d="${d}" fill="none" stroke="${l.halo}" stroke-width="${l.size * 0.3}" stroke-linejoin="round"/>` : ''
  return `${halo}<path d="${d}" fill="${l.color}"/>`
}

/** A label as real PDF text in the bundled font; `x,y` place it on the page when its own are in other units. */
function pdfLabel(doc: PDFKit.PDFDocument, l: Label, x = l.x, y = l.y, turned = false) {
  const size = l.size * MM
  const at = [-textWidth(l.text, size, l.weight) / 2, capHeight(size, l.weight) / 2] as const
  doc.save().translate(x * MM, y * MM)
  if (turned) doc.rotate(90)
  doc.font(FONT_FILE[l.weight]).fontSize(size)
  if (l.halo) {
    doc.lineWidth(size * 0.3).lineJoin('round').strokeColor(l.halo)
      .text(l.text, ...at, { baseline: 'alphabetic', lineBreak: false, stroke: true, fill: false })
  }
  doc.fillColor(l.color).text(l.text, ...at, { baseline: 'alphabetic', lineBreak: false })
  doc.restore().font(FONT_FILE.regular)
}

/** The largest size up to `size` at which `text` fits `width`. */
const fitted = (text: string, size: number, width: number, weight: Weight = 'regular') => Math.min(size, width / Math.max(1e-6, textWidth(text, 1, weight)))

/** Fog for part of the map, or null if none of it lands there. */
function bakedSvg(q: PrintRequest, region: Rect): string | null {
  const area = q.crop ? intersect(region, q.crop) : region
  if (!area) return null
  const items = bakedFog(q.fog)
  const shows = items.filter((i) => i.mode === 'show')
  const covers = items.filter((i) => i.mode === 'cover' && touches(i, area))
  if (!shows.length && !covers.length) return null
  const { x, y, w, h } = region
  const box = `x="${x}" y="${y}" width="${w}" height="${h}"`
  const shapes = (list: FogItem[], fill: string) => list.map((i) => `<path d="${fogPath(i)}" fill="${fill}"/>`).join('')
  const names = covers.filter((i) => q.fog.names && i.name.trim()).map((i) => {
    const b = fogBounds(i)
    const room = labelRoom(i, b) ?? b
    const text = i.name.trim()
    const size = fitted(text, Math.min(14, b.w * 0.14, b.h * 0.14, room.h * 0.5), room.w * 0.8)
    return svgLabel({ text, x: room.x + room.w / 2, y: room.y + room.h / 2, size, weight: 'regular', color: labelTone(q.fog.fill) })
  }).join('')
  const edges = q.fog.outline ? covers.map((i) => `<path d="${fogPath(i)}" fill="none" ${CUT_LINE}/>`).join('') : ''
  return `${fogSvgOpen(region)}
    <mask id="f" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="${shows.length ? '#fff' : '#000'}"/>${shapes(shows, '#000')}${shapes(covers, '#fff')}</mask>
    <clipPath id="c"><rect x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}"/></clipPath>
    <g clip-path="url(#c)"><rect ${box} fill="${q.fog.fill}" mask="url(#f)"/>${edges}${names}</g></svg>`
}

/** The mark is what gets matched against the placement page, so it leads; the name confirms it. */
/** A card's ID, small along the bottom of the shape so it reads on the table without drawing the eye; its name only when asked for. */
function cardLabels(q: PrintRequest, card: FogCard): Label[] {
  // Inside the shape within this piece, and off its glue tabs: a label there would be cut away or covered by the next piece.
  const { region: r, tabRight, tabBottom } = card
  const clear = { ...r, w: r.w - (tabRight ? FOG_TAB_MM : 0), h: r.h - (tabBottom ? FOG_TAB_MM : 0) }
  const box = labelRoom(card.item, clear) ?? clear
  const color = labelTone(q.fog.fill)
  const name = q.fog.names ? card.item.name.trim() : ''
  const room = box.w * 0.9
  const idSize = Math.min(3, box.h * 0.12, fitted(card.id, Infinity, room, 'bold'))
  const nameSize = name ? Math.min(idSize, fitted(name, Infinity, room)) : 0
  const x = box.x + box.w / 2
  const bottom = box.y + box.h - Math.min(3, box.h * 0.08)
  const idY = bottom - capHeight(idSize, 'bold') / 2
  const labels: Label[] = [{ text: card.id, x, y: idY, size: idSize, weight: 'bold', color }]
  if (name) labels.push({ text: name, x, y: idY - capHeight(idSize, 'bold') / 2 - nameSize * 0.5 - capHeight(nameSize) / 2, size: nameSize, weight: 'regular', color })
  return labels
}

/** One card on its own footprint, turned with it. Cut along the solid line; dashes mark where the next piece glues on. */
function cardSvg(q: PrintRequest, card: FogCard, pad: number, labels: Label[]): string {
  const { item, region: r, tabRight, tabBottom, placement } = card
  const { w, h } = footprint(card)
  const d = fogPath(item)
  const ink = inkOn(q.fog.fill)
  const glue = [
    tabRight ? `M${r.x + r.w - FOG_TAB_MM} ${r.y}v${r.h}` : '',
    tabBottom ? `M${r.x} ${r.y + r.h - FOG_TAB_MM}h${r.w}` : '',
  ].join('')
  const turn = `${placement.rotated ? `translate(${r.h} 0) rotate(90) ` : ''}translate(${-r.x} ${-r.y})`
  return `${fogSvgOpen({ x: -pad, y: -pad, w: w + pad * 2, h: h + pad * 2 })}
    <clipPath id="p"><rect x="${r.x - pad}" y="${r.y - pad}" width="${r.w + pad * 2}" height="${r.h + pad * 2}"/></clipPath>
    <clipPath id="s"><path d="${d}"/></clipPath>
    <clipPath id="r"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/></clipPath>
    <g transform="${turn}">
      <g clip-path="url(#r)"><path d="${d}" fill="${q.fog.fill}"/></g>
      <g clip-path="url(#p)">
        <path d="${d}" fill="none" ${CUT_LINE}/>
        <g clip-path="url(#s)">
          <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#000" stroke-width="0.8"/>
          <path d="${glue}" fill="none" stroke="${ink}" stroke-opacity="0.6" stroke-width="0.2" stroke-dasharray="1.4 1"/>
        </g>
        ${labels.map(svgLabel).join('')}
      </g>
    </g></svg>`
}

const rasterSvg = (svg: string, w: number, h: number, pxPerMm: number) => sharp(Buffer.from(svg), { density: pxPerMm * 72 })
  .resize(Math.max(1, Math.round(w * pxPerMm)), Math.max(1, Math.round(h * pxPerMm)), { fit: 'fill' })
  .png()
  .toBuffer()

function bakedLayer(q: PrintRequest, region: Rect, pxPerMm: number): Promise<Buffer> | null {
  const svg = bakedSvg(q, region)
  return svg ? rasterSvg(svg, region.w, region.h, pxPerMm) : null
}

/** Room for the outline at the sheet's edge, where there is margin to give it. */
const fogPad = (q: PrintRequest) => Math.min(1, q.marginMm)

function cardLayer(q: PrintRequest, card: FogCard, pxPerMm: number, labels: Label[]) {
  const pad = fogPad(q)
  const { w, h } = footprint(card)
  return rasterSvg(cardSvg(q, card, pad, labels), w + pad * 2, h + pad * 2, pxPerMm)
}

const PLACE_INK = '#d81b60'

/** Where the printed part of the map sits on the placement page, turned whichever way shows it largest. */
function placementLayout(q: PrintRequest, plan: FogPlan) {
  const map = { x: 0, y: 0, w: q.grid.cols * q.squareMm, h: q.grid.rows * q.squareMm }
  const view = (q.crop && intersect(map, q.crop)) || map
  const { sheetW, sheetH } = plan
  const margin = Math.max(q.marginMm, 10)
  const head = 16
  const fit = (w: number, h: number) => {
    const area = { w: w - margin * 2, h: h - margin * 2 - head }
    const scale = Math.min(area.w / view.w, area.h / view.h)
    return { sheetW: w, sheetH: h, margin, view, scale, x: margin + (area.w - view.w * scale) / 2, y: margin + head }
  }
  const [given, turned] = [fit(sheetW, sheetH), fit(sheetH, sheetW)]
  return turned.scale > given.scale * 1.001 ? turned : given
}

/** Where a stretch of the map (`view`) lands on a page, in page mm. */
interface MapPlacement {
  sheetW: number
  sheetH: number
  view: Rect
  scale: number
  x: number
  y: number
}

type PlacementLayout = ReturnType<typeof placementLayout>

/** Every separate cover outlined where it goes, split ones with their seams, over a map drawn underneath. */
function placementSvg(plan: FogPlan, L: MapPlacement, labels: Label[], frame = true): string {
  const { view, scale } = L
  const items = [...new Set(plan.cards.map((c) => c.item))]
  // Widths in page mm, so lines read the same however small the map is drawn; the white halo carries them over dark maps.
  const mm = (v: number) => v / scale
  const outlines = items.map((item) => `<path d="${fogPath(item)}" fill="${PLACE_INK}" fill-opacity="0.15" stroke="#fff" stroke-width="${mm(1.2)}" stroke-linejoin="round"/>
    <path d="${fogPath(item)}" fill="none" stroke="${PLACE_INK}" stroke-width="${mm(0.45)}" stroke-linejoin="round"/>`).join('')
  const seams = items.map((item, n) => {
    const d = plan.cards.filter((c) => c.item === item).map(({ region: r, tabRight, tabBottom }) => [
      tabRight ? `M${r.x + r.w - FOG_TAB_MM} ${r.y}v${r.h}` : '',
      tabBottom ? `M${r.x} ${r.y + r.h - FOG_TAB_MM}h${r.w}` : '',
    ].join('')).join('')
    if (!d) return ''
    return `<clipPath id="s${n}"><path d="${fogPath(item)}"/></clipPath><g clip-path="url(#s${n})">
      <path d="${d}" fill="none" stroke="#fff" stroke-width="${mm(1)}"/>
      <path d="${d}" fill="none" stroke="${PLACE_INK}" stroke-width="${mm(0.35)}" stroke-dasharray="${mm(1.5)} ${mm(1)}"/></g>`
  }).join('')
  return `${fogSvgOpen({ x: 0, y: 0, w: L.sheetW, h: L.sheetH })}
    <clipPath id="v"><rect x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}"/></clipPath>
    <g transform="translate(${L.x} ${L.y}) scale(${scale}) translate(${-view.x} ${-view.y})"><g clip-path="url(#v)">${outlines}${seams}</g></g>
    ${frame ? `<rect x="${L.x}" y="${L.y}" width="${view.w * scale}" height="${view.h * scale}" fill="none" stroke="#000" stroke-width="0.2"/>` : ''}
    ${labels.map(svgLabel).join('')}</svg>`
}

const FOG_HOWTO = 'Cut out each fog card and lay it where its mark shows. Pieces of a split cover overlap on the dashed glue tabs.'

/** A heading, then each cover's mark on it. */
function placementLabels(plan: FogPlan, L: PlacementLayout): Label[] {
  const width = L.sheetW - L.margin * 2
  const title = 'Fog placement'
  return [
    { text: title, x: L.sheetW / 2, y: L.margin + 2.5, size: fitted(title, 7, width, 'bold'), weight: 'bold', color: '#111111' },
    { text: FOG_HOWTO, x: L.sheetW / 2, y: L.margin + 9.5, size: fitted(FOG_HOWTO, 3.4, width), weight: 'regular', color: '#555555' },
    ...coverMarks(plan, L, 4),
  ]
}

/** Each cover's mark where it goes; a split cover marks every piece. `size` is in page mm. */
function coverMarks(plan: FogPlan, L: MapPlacement, size: number): Label[] {
  const labels: Label[] = []
  const items = [...new Set(plan.cards.map((c) => c.item))]
  // The overview is the GM's key, so it always names each area; a split cover names it on its first piece.
  const marks = items.flatMap((item) => {
    const pieces = plan.cards.filter((c) => c.item === item)
    const name = item.name.trim()
    return pieces.length > 1
      ? pieces.map((c, i) => ({ text: c.id, name: i ? '' : name, box: labelRoom(item, c.region) }))
      : [{ text: pieces[0].mark, name, box: labelRoom(item, fogBounds(item)) }]
  })
  for (const { text, name, box } of marks) {
    const seen = box && intersect(box, L.view)
    if (!seen) continue
    const x = L.x + (seen.x + seen.w / 2 - L.view.x) * L.scale
    const y = L.y + (seen.y + seen.h / 2 - L.view.y) * L.scale
    const nameSize = name ? Math.max(1.6, fitted(name, size * 0.62, seen.w * L.scale * 0.92)) : 0
    const shift = name ? (capHeight(size, 'bold') * 0.5 + capHeight(nameSize) * 0.5 + size * 0.25) / 2 : 0
    labels.push({ text, x, y: y - shift, size, weight: 'bold', color: '#111111', halo: '#ffffff' })
    if (name) labels.push({ text: name, x, y: y + shift, size: nameSize, weight: 'regular', color: '#111111', halo: '#ffffff' })
  }
  return labels
}

/** The thumbnail, cut to the printed part of the map. */
async function placementMap(q: PrintRequest, file: FileRow, { view }: PlacementLayout): Promise<Buffer> {
  const thumb = thumbPath(file.id, 'large')
  const { width = 1, height = 1 } = await sharp(thumb).metadata()
  const [sx, sy] = [width / (q.grid.cols * q.squareMm), height / (q.grid.rows * q.squareMm)]
  const left = Math.min(width - 1, Math.max(0, Math.floor(view.x * sx)))
  const top = Math.min(height - 1, Math.max(0, Math.floor(view.y * sy)))
  const right = Math.min(width, Math.ceil((view.x + view.w) * sx))
  const bottom = Math.min(height, Math.ceil((view.y + view.h) * sy))
  return sharp(thumb)
    .extract({ left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82 })
    .toBuffer()
}

/**
 * The white veil over map and grid on `area` of the map plane, as a PNG, or
 * null when none of it is veiled. Past the faded edge it is solid, which also
 * hides the grid on blank paper and the sliver of whole source pixels a tile
 * can overhang a crop by. Fog goes on top, so it stays whole.
 */
async function fadeLayer(q: PrintRequest, area: Rect, pxPerMm: number): Promise<Buffer | null> {
  const region = q.fadeMm ? fadeRegion(q.grid.cols * q.squareMm, q.grid.rows * q.squareMm, q.crop) : null
  if (!region) return null
  const width = Math.max(1, Math.round(area.w * pxPerMm))
  const height = Math.max(1, Math.round(area.h * pxPerMm))
  const alpha = fadeMask(region, q.fadeMm!, area, width, height)
  if (!alpha) return null
  const pixels = Buffer.alloc(width * height * 4, 255)
  for (let i = 0; i < alpha.length; i++) pixels[i * 4 + 3] = alpha[i]
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer()
}

const stroke = (doc: PDFKit.PDFDocument, segments: Segment[]) => {
  for (const [a, b, c, d] of segments) doc.moveTo(a * MM, b * MM).lineTo(c * MM, d * MM)
  doc.stroke()
}

/** `_title` is unused: overlayFor names the sheet itself, so the PNG export says the same. */
function drawPdfOverlay(doc: PDFKit.PDFDocument, q: PrintRequest, sheet: Sheet, overlay: Overlay, _title: string) {
  const { left, top } = sheet
  const origin = () => doc.translate(left * MM, top * MM)
  if (overlay.grid.length) {
    doc.save()
    origin()
    doc.rect(overlay.clip.x * MM, overlay.clip.y * MM, overlay.clip.w * MM, overlay.clip.h * MM).clip()
    doc.strokeColor(q.overlay.color).strokeOpacity(q.overlay.opacity).lineWidth(q.overlay.widthMm * MM)
    stroke(doc, overlay.grid)
    if (overlay.numbers.length) {
      doc.fillColor(q.overlay.color).fillOpacity(q.overlay.opacity).fontSize(q.squareMm * MM * 0.12)
      for (const n of overlay.numbers) {
        doc.text(n.text, (n.x - q.squareMm / 2) * MM, n.y * MM, { width: q.squareMm * MM, align: 'center', lineBreak: false })
      }
    }
    doc.restore()
  }
  if (overlay.cuts.length || overlay.joins.length) {
    doc.save()
    origin()
    doc.strokeColor(MARK_INK).lineWidth(MARK_MM * MM).lineCap('butt')
    if (overlay.cuts.length) stroke(doc, overlay.cuts)
    if (overlay.joins.length) {
      doc.dash(MARK_DASH[0] * MM, { space: MARK_DASH[1] * MM })
      stroke(doc, overlay.joins)
      doc.undash()
    }
    doc.restore()
  }
  for (const note of overlay.notes) {
    doc.save()
    origin()
    doc.translate(note.x * MM, note.y * MM).rotate(note.angle)
    doc.fillColor('#555555').fontSize(NOTE_PT)
    const width = doc.widthOfString(note.text)
    doc.text(note.text, note.anchor === 'middle' ? -width / 2 : 0, 0, { lineBreak: false, baseline: 'middle' })
    doc.restore()
  }
}

const RULER_MM = 100
const RULER_IN = 4
/** Room for the ruler and its unit labels. */
const RULER_W = RULER_IN * 25.4 + 7
const RULER_H = 16

/**
 * A two-sided scale on one baseline: millimetres above, inches below. Printing
 * at "fit to page" is the classic mistake, and a ruler shows it on the first sheet.
 */
function drawRuler(doc: PDFKit.PDFDocument, x: number, y: number) {
  const tick = (at: number, length: number) => doc.moveTo((x + at) * MM, y * MM).lineTo((x + at) * MM, (y + length) * MM)
  doc.save().strokeColor('#111111').lineWidth(0.1 * MM).lineCap('butt')
  doc.moveTo(x * MM, y * MM).lineTo((x + RULER_IN * 25.4) * MM, y * MM)
  for (let mm = 0; mm <= RULER_MM; mm++) tick(mm, -(mm % 10 === 0 ? 4 : mm % 5 === 0 ? 2.8 : 1.6))
  for (let sixteenth = 0; sixteenth <= RULER_IN * 16; sixteenth++) {
    const length = sixteenth % 16 === 0 ? 4 : sixteenth % 8 === 0 ? 3.2 : sixteenth % 4 === 0 ? 2.4 : sixteenth % 2 === 0 ? 1.8 : 1.2
    tick((sixteenth * 25.4) / 16, length)
  }
  doc.stroke()
  doc.fillColor('#333333').fontSize(6)
  const label = (text: string, at: number, ty: number, baseline: 'bottom' | 'top') => {
    const width = doc.widthOfString(text)
    doc.text(text, (x + at) * MM - width / 2, ty * MM, { lineBreak: false, baseline })
  }
  for (let mm = 0; mm <= RULER_MM; mm += 10) label(String(mm), mm, y - 4.6, 'bottom')
  for (let inch = 0; inch <= RULER_IN; inch++) label(String(inch), inch * 25.4, y + 4.6, 'top')
  doc.text('mm', (x + RULER_IN * 25.4 + 2) * MM, (y - 1) * MM, { lineBreak: false, baseline: 'bottom' })
  doc.text('in', (x + RULER_IN * 25.4 + 2) * MM, (y + 1) * MM, { lineBreak: false, baseline: 'top' })
  doc.restore()
}

/** Short how-to for the cut-and-overlap marks on the map sheets. */
function assemblySteps(q: PrintRequest): string[] {
  const first = q.pages[0]?.label ?? 'A1'
  const overlap = planFor(q).some((p) => p?.edges.some((e) => e.overlap > 0.5))
  return [
    '1.  Cut each sheet on its solid lines only (CUT edges): usually just the top and left, plus the outer edges of the map. Leave the dashed KEEP margins on.',
    `2.  Lay down ${first}, then work left to right and row by row: lay each sheet's cut edge over the kept margin of the sheet before it, ${
      overlap ? 'right on that sheet\'s dashed line, so the overlapping strip of map lines up.' : 'right against that sheet\'s map edge.'}`,
    '3.  Tape the joins on the back.',
    'Every cut line runs out to the paper\'s edge, so the second cut still has its line after the first one.',
  ]
}

/** The map with its sheets and, when fog prints separately, where each fog card goes: one page for both. */
async function drawOverviewPage(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, title: string, plan: FogPlan) {
  const margin = Math.max(q.marginMm, 10)
  const mapW = q.grid.cols * q.squareMm
  const mapH = q.grid.rows * q.squareMm
  const bounds = q.pages.reduce(
    (b, p) => ({ x: Math.min(b.x, p.x), y: Math.min(b.y, p.y), r: Math.max(b.r, p.x + p.w), b: Math.max(b.b, p.y + p.h) }),
    { x: 0, y: 0, r: mapW, b: mapH },
  )
  const square = q.squareMm <= 40 ? q.squareMm : 0
  const checkW = RULER_W + (square ? 10 + Math.max(square, 24) : 0)
  const hint = 'Print at 100% / actual size, with "fit to page" turned off. The scale must measure 100 mm and 4 in'
    + (square ? ', and the box one grid square.' : '.')
  const fogNote = `Fog cards: ${FOG_HOWTO.charAt(0).toLowerCase()}${FOG_HOWTO.slice(1)} The pink outlines above show where each one goes.`
  const steps = [...(q.marks.cut ? assemblySteps(q) : []), ...(plan.sheets ? [fogNote] : [])]
  const textH = (text: string, width: number, size: number) => doc.fontSize(size).heightOfString(text, { width: width * MM, lineGap: 1 }) / MM
  const stepsH = (width: number) => steps.length ? 5 + steps.reduce((h, s) => h + textH(s, width, 7.5) + 1, 0) : 0

  // The map need not lie the way the sheets do. Turn the page with the map, unless
  // the other way shows it clearly larger (the notes take more room beside it).
  const short = Math.min(q.pages[0].sheetW, q.pages[0].sheetH)
  const long = Math.max(q.pages[0].sheetW, q.pages[0].sheetH)
  const layouts = [[short, long], [long, short]].map(([w, h]) => {
    const besideW = w - margin * 2 - checkW - 10
    const beside = besideW >= 80
    const stepsW = beside ? besideW : w - margin * 2
    const checkH = Math.max(RULER_H + 3 + textH(hint, RULER_W, 7), square ? square + 6 : 0)
    const footerH = beside ? Math.max(checkH, stepsH(stepsW)) : checkH + (steps.length ? stepsH(stepsW) + 6 : 0)
    const area = { x: margin, y: margin + 18, w: w - margin * 2, h: h - margin * 2 - 18 - footerH - 6 }
    const scale = Math.min(area.w / (bounds.r - bounds.x), area.h / (bounds.b - bounds.y))
    return { w, h, beside, stepsW, checkH, footerH, area, scale }
  })
  const [a, b] = bounds.r - bounds.x > bounds.b - bounds.y ? [layouts[1], layouts[0]] : layouts
  const { w: sheetW, h: sheetH, beside, stepsW, checkH, footerH, area, scale } = b.scale > a.scale * 1.15 ? b : a
  doc.addPage({ size: [sheetW * MM, sheetH * MM], margin: 0 })

  doc.fillColor('#111111').fontSize(16).text(title, margin * MM, margin * MM, { width: (sheetW - margin * 2) * MM, lineBreak: false, height: 20, ellipsis: true })
  const summary = `${q.pages.length} sheets   ${Math.round(q.grid.cols)} × ${Math.round(q.grid.rows)} squares   ${q.squareMm.toFixed(1)} mm per square   ${(mapW / 10).toFixed(1)} × ${(mapH / 10).toFixed(1)} cm`
    + (q.crop ? `   printing ${(q.crop.w / 10).toFixed(1)} × ${(q.crop.h / 10).toFixed(1)} cm of it` : '')
    + (plan.sheets ? `   ${plan.cards.length} fog cards on ${plan.sheets} ${plan.sheets === 1 ? 'sheet' : 'sheets'}` : '')
  doc.fillColor('#555555').fontSize(9).text(summary, margin * MM, (margin + 8) * MM, { lineBreak: false })

  const ox = area.x + (area.w - (bounds.r - bounds.x) * scale) / 2 - bounds.x * scale
  const oy = area.y + (area.h - (bounds.b - bounds.y) * scale) / 2 - bounds.y * scale
  const at = (r: Rect) => [(ox + r.x * scale) * MM, (oy + r.y * scale) * MM, r.w * scale * MM, r.h * scale * MM] as const
  const preview = await sharp(thumbPath(file.id, 'large')).jpeg({ quality: 80 }).toBuffer()
  doc.image(preview, ox * MM, oy * MM, { width: mapW * scale * MM, height: mapH * scale * MM })
  // The whole map, so that outside a crop it is as blank as the sheets will be.
  const fade = await fadeLayer(q, { x: 0, y: 0, w: mapW, h: mapH }, FADE_PX_PER_MM * scale)
  if (fade) doc.image(fade, ox * MM, oy * MM, { width: mapW * scale * MM, height: mapH * scale * MM })
  const fog = await bakedLayer(q, { x: 0, y: 0, w: mapW, h: mapH }, FOG_PX_PER_MM * scale)
  if (fog) doc.image(fog, ox * MM, oy * MM, { width: mapW * scale * MM, height: mapH * scale * MM })
  if (q.crop) {
    // Fade what is left out, so the printed part reads at a glance.
    doc.save()
    doc.rect(...at({ x: 0, y: 0, w: mapW, h: mapH })).rect(...at(q.crop)).fillColor('#ffffff').fillOpacity(0.6).fill('even-odd')
    doc.restore()
    doc.save().rect(...at(q.crop)).lineWidth(0.6).strokeColor('#d02020').dash(3, { space: 2 }).stroke().restore()
  }
  for (const p of q.pages) {
    const [x, y, w, h] = at(p)
    doc.rect(x, y, w, h).lineWidth(0.75).strokeColor('#ffffff').stroke()
    doc.rect(x, y, w, h).lineWidth(0.25).strokeColor('#000000').stroke()
  }
  const view = (q.crop && intersect({ x: 0, y: 0, w: mapW, h: mapH }, q.crop)) || { x: 0, y: 0, w: mapW, h: mapH }
  const placed: MapPlacement = { sheetW, sheetH, view, scale, x: ox + view.x * scale, y: oy + view.y * scale }
  if (plan.sheets) {
    const lines = await rasterSvg(placementSvg(plan, placed, [], false), sheetW, sheetH, FOG_PX_PER_MM)
    doc.image(lines, 0, 0, { width: sheetW * MM, height: sheetH * MM })
  }
  for (const p of q.pages) {
    if (plan.sheets) {
      // Fog marks take the middle of the map, so sheet names step aside to a corner of their sheet.
      const size = Math.min(2.6, p.h * scale * 0.2)
      const x = ox + p.x * scale + 1.2 + textWidth(p.label, size, 'bold') / 2
      pdfLabel(doc, { text: p.label, x, y: oy + p.y * scale + 1.2 + size / 2, size, weight: 'bold', color: '#111111', halo: '#ffffff' })
      continue
    }
    const [x, y, w, h] = at(p)
    const size = Math.min(10, h * 0.3)
    doc.fontSize(size).fillColor('#ffffff').text(p.label, x, y + h / 2 - size / 2, { width: w, align: 'center', lineBreak: false, stroke: true, fill: true })
  }
  for (const label of coverMarks(plan, placed, 3.2)) pdfLabel(doc, label)

  const footerY = sheetH - margin - footerH
  if (steps.length) {
    let y = footerY
    const x = beside ? margin + checkW + 10 : margin
    doc.fillColor('#111111').fontSize(9).text('Putting it together', x * MM, y * MM, { lineBreak: false })
    y += 5
    doc.fillColor('#333333')
    for (const step of steps) {
      doc.fontSize(7.5).text(step, x * MM, y * MM, { width: stepsW * MM, lineGap: 1 })
      y += textH(step, stepsW, 7.5) + 1
    }
  }
  const checkY = beside ? footerY : sheetH - margin - checkH
  drawRuler(doc, margin, checkY + 7)
  doc.fillColor('#555555').fontSize(7).text(hint, margin * MM, (checkY + RULER_H + 1) * MM, { width: RULER_W * MM, lineGap: 1 })
  if (square) {
    const sx = margin + RULER_W + 10
    doc.save().rect(sx * MM, (checkY + 1) * MM, square * MM, square * MM).lineWidth(0.15 * MM).strokeColor('#111111').stroke().restore()
    const name = q.grid.type === 'square' ? 'square' : 'hex across'
    doc.fillColor('#555555').fontSize(6).text(`1 ${name} = ${q.squareMm.toFixed(1)} mm`, sx * MM, (checkY + square + 2.5) * MM, { lineBreak: false })
  }
}

async function drawPlacementPage(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, plan: FogPlan) {
  const L = placementLayout(q, plan)
  doc.addPage({ size: [L.sheetW * MM, L.sheetH * MM], margin: 0 })
  doc.image(await placementMap(q, file, L), L.x * MM, L.y * MM, { width: L.view.w * L.scale * MM, height: L.view.h * L.scale * MM })
  const lines = await rasterSvg(placementSvg(plan, L, []), L.sheetW, L.sheetH, FOG_PX_PER_MM)
  doc.image(lines, 0, 0, { width: L.sheetW * MM, height: L.sheetH * MM })
  for (const label of placementLabels(plan, L)) pdfLabel(doc, label)
}

async function drawFogSheet(doc: PDFKit.PDFDocument, q: PrintRequest, plan: FogPlan, cards: FogCard[], index: number, title: string) {
  doc.addPage({ size: [plan.sheetW * MM, plan.sheetH * MM], margin: 0 })
  const pad = fogPad(q)
  for (const card of cards) {
    const { w, h } = footprint(card)
    const [x, y] = [q.marginMm + card.placement.x, q.marginMm + card.placement.y]
    const layer = await cardLayer(q, card, FOG_PX_PER_MM, [])
    doc.image(layer, (x - pad) * MM, (y - pad) * MM, { width: (w + pad * 2) * MM, height: (h + pad * 2) * MM })
    for (const label of cardLabels(q, card)) pdfLabel(doc, label, ...onSheet(q, card, label.x, label.y), card.placement.rotated)
  }
  if (q.marginMm >= 3) {
    const caption = `Fog ${index + 1} of ${plan.sheets}   ${cards.map((c) => c.id).join('  ')}   ${title}`
    doc.fillColor('#555555').fontSize(6).text(caption, q.marginMm * MM, (plan.sheetH - q.marginMm + 1) * MM, {
      lineBreak: false, width: (plan.sheetW - q.marginMm * 2) * MM, height: 8, ellipsis: true,
    })
  }
}

/** A PDF in the bundled face rather than a PDF base font, so its text matches the outlined text in the raster layers. */
async function writeDoc(target: string, title: string, draw: (doc: PDFKit.PDFDocument) => Promise<void>) {
  const doc = new PDFDocument({ autoFirstPage: false, compress: true, font: FONT_FILE.regular, info: { Title: title, Creator: 'Scenic' } })
  const out = doc.pipe(createWriteStream(target))
  await draw(doc)
  doc.end()
  await finished(out)
}

async function drawMapSheets(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, raster: string, title: string, progress: (done: number) => void) {
  let done = 0
  for await (const [sheet, tile] of tiles(q.pages.map(sheetOf), (s) => renderTile(raster, q, file, s.page, 'jpeg'))) {
    doc.addPage({ size: [sheet.w * MM, sheet.h * MM], margin: 0 })
    if (tile) {
      doc.save()
      doc.rect(sheet.left * MM, sheet.top * MM, sheet.page.w * MM, sheet.page.h * MM).clip()
      doc.image(tile.data, (sheet.left + tile.x) * MM, (sheet.top + tile.y) * MM, { width: tile.w * MM, height: tile.h * MM })
      doc.restore()
    }
    drawPdfOverlay(doc, q, sheet, overlayFor(q, file, sheet), title)
    const fade = await fadeLayer(q, sheet.page, FADE_PX_PER_MM)
    if (fade) doc.image(fade, sheet.left * MM, sheet.top * MM, { width: sheet.page.w * MM, height: sheet.page.h * MM })
    const fog = await bakedLayer(q, sheet.page, FOG_PX_PER_MM)
    if (fog) doc.image(fog, sheet.left * MM, sheet.top * MM, { width: sheet.page.w * MM, height: sheet.page.h * MM })
    progress(++done)
  }
}

async function drawFogCards(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, plan: FogPlan, title: string) {
  // The overview already shows where the fog goes; without one, the cards bring their own placement page.
  if (!q.marks.overview) await drawPlacementPage(doc, q, file, plan)
  for (const [i, cards] of cardsBySheet(plan).entries()) await drawFogSheet(doc, q, plan, cards, i, title)
}

function overlaySvg(q: PrintRequest, sheet: Sheet, overlay: Overlay): string {
  const { left, top } = sheet
  const path = (segments: Segment[]) => segments.map(([a, b, c, d]) => `M${a.toFixed(2)} ${b.toFixed(2)}L${c.toFixed(2)} ${d.toFixed(2)}`).join('')
  const numbers = overlay.numbers
    .map((n) => {
      const size = q.squareMm * 0.12
      return `<path d="${textPath(n.text, n.x, n.y + q.squareMm * 0.1 - capHeight(size) / 2, size)}"/>`
    })
    .join('')
  const notes = overlay.notes
    .map((n) => {
      const x = n.anchor === 'start' ? textWidth(n.text, NOTE_MM) / 2 : 0
      return `<path transform="translate(${n.x.toFixed(2)} ${n.y.toFixed(2)}) rotate(${n.angle})" d="${textPath(n.text, x, 0, NOTE_MM)}"/>`
    })
    .join('')
  const marks = `stroke="${MARK_INK}" stroke-width="${MARK_MM}" fill="none"`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sheet.w} ${sheet.h}">
    <clipPath id="c"><rect x="${overlay.clip.x}" y="${overlay.clip.y}" width="${overlay.clip.w}" height="${overlay.clip.h}"/></clipPath>
    <g transform="translate(${left} ${top})">
      <g clip-path="url(#c)" fill="${q.overlay.color}" stroke="none" opacity="${q.overlay.opacity}">
        <path d="${path(overlay.grid)}" stroke="${q.overlay.color}" stroke-width="${q.overlay.widthMm}" fill="none"/>${numbers}
      </g>
      <path d="${path(overlay.cuts)}" ${marks}/>
      <path d="${path(overlay.joins)}" ${marks} stroke-dasharray="${MARK_DASH.join(' ')}"/>
      <g fill="#555555">${notes}</g>
    </g></svg>`
}

async function writePngZip(q: PrintRequest, file: FileRow, raster: string, target: string, progress: (done: number) => void) {
  const zip = new yazl.ZipFile()
  const out = zip.outputStream.pipe(createWriteStream(target))
  const dpi = Math.min(MAX_PPI[q.output.quality], (file.width / q.grid.cols / q.squareMm) * 25.4)
  const pxPerMm = dpi / 25.4
  let done = 0
  const render = async (sheet: Sheet) => {
    const tile = await renderTile(raster, q, file, sheet.page, 'png')
    const width = Math.round(sheet.w * pxPerMm)
    const height = Math.round(sheet.h * pxPerMm)
    const layers: { input: Buffer; left?: number; top?: number }[] = []
    if (tile) {
      const x = Math.max(0, tile.x)
      const y = Math.max(0, tile.y)
      const [fitW, fitH] = [Math.round(tile.w * pxPerMm), Math.round(tile.h * pxPerMm)]
      const left = Math.round((x - tile.x) * pxPerMm)
      const top = Math.round((y - tile.y) * pxPerMm)
      // Rounding each side separately can ask for a pixel past the resized tile.
      const fitted = await sharp(tile.data)
        .resize(fitW, fitH, { fit: 'fill' })
        .extract({
          left,
          top,
          width: Math.min(fitW - left, Math.round(Math.min(tile.w - (x - tile.x), sheet.page.w - x) * pxPerMm)),
          height: Math.min(fitH - top, Math.round(Math.min(tile.h - (y - tile.y), sheet.page.h - y) * pxPerMm)),
        })
        .toBuffer()
      layers.push({ input: fitted, left: Math.round((sheet.left + x) * pxPerMm), top: Math.round((sheet.top + y) * pxPerMm) })
    }
    const svg = await sharp(Buffer.from(overlaySvg(q, sheet, overlayFor(q, file, sheet))), { density: pxPerMm * 72 })
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer()
    layers.push({ input: svg })
    const fade = await fadeLayer(q, sheet.page, pxPerMm)
    if (fade) layers.push({ input: fade, left: Math.round(sheet.left * pxPerMm), top: Math.round(sheet.top * pxPerMm) })
    const fog = await bakedLayer(q, sheet.page, pxPerMm)
    if (fog) layers.push({ input: fog, left: Math.round(sheet.left * pxPerMm), top: Math.round(sheet.top * pxPerMm) })
    return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).composite(layers).png({ compressionLevel: 6 }).toBuffer()
  }
  for await (const [sheet, png] of tiles(q.pages.map(sheetOf), render)) {
    zip.addBuffer(png, `${safeName(file.name)} ${sheet.page.label}.png`, { compress: false })
    progress(++done)
  }
  const blank = (w: number, h: number, px: number) => sharp({ create: { width: Math.round(w * px), height: Math.round(h * px), channels: 3, background: '#ffffff' } })
  const plan = fogPlanFor(q)
  if (plan.sheets) {
    // Only a guide, never cut out, so it can be sharper than a low-resolution map.
    const px = Math.max(pxPerMm, FOG_PX_PER_MM)
    const L = placementLayout(q, plan)
    const map = await sharp(await placementMap(q, file, L))
      .resize(Math.round(L.view.w * L.scale * px), Math.round(L.view.h * L.scale * px), { fit: 'fill' })
      .toBuffer()
    const lines = await rasterSvg(placementSvg(plan, L, placementLabels(plan, L)), L.sheetW, L.sheetH, px)
    const png = await blank(L.sheetW, L.sheetH, px)
      .composite([{ input: map, left: Math.round(L.x * px), top: Math.round(L.y * px) }, { input: lines }])
      .png()
      .toBuffer()
    zip.addBuffer(png, `${safeName(file.name)} Fog placement.png`, { compress: false })
  }
  // Cards keep the map's resolution so every sheet in the zip prints at the same scale.
  const pad = fogPad(q)
  for (const [i, cards] of cardsBySheet(plan).entries()) {
    const layers = await Promise.all(cards.map(async (card) => ({
      input: await cardLayer(q, card, pxPerMm, cardLabels(q, card)),
      left: Math.round((q.marginMm + card.placement.x - pad) * pxPerMm),
      top: Math.round((q.marginMm + card.placement.y - pad) * pxPerMm),
    })))
    const png = await blank(plan.sheetW, plan.sheetH, pxPerMm).composite(layers).png().toBuffer()
    zip.addBuffer(png, `${safeName(file.name)} Fog sheet ${i + 1}.png`, { compress: false })
  }
  zip.end()
  await finished(out)
}

/** Bump whenever the same request should print differently, so cached files from older layouts are not served. */
const PRINT_LAYOUT = 7

export const printKey = (q: PrintRequest, file: FileRow) => `print|${PRINT_LAYOUT}|${file.path}|${file.entry}|${file.mtime}|${JSON.stringify(q)}`

export type PrintPart = 'overview' | 'sheets' | 'fog' | 'all'

export interface PrintFile {
  part: PrintPart
  path: string
  pages: number
}

/**
 * A PDF comes as separate files for the overview, the map sheets and the fog
 * cards, so each can be left out or printed on its own paper and settings.
 * PNG sheets come as one zip. Each file is cached on its own.
 */
export async function generate(q: PrintRequest, file: FileRow, progress: (done: number) => void): Promise<PrintFile[]> {
  const key = printKey(q, file)
  const raster = () => preparedRaster(file, q.filter)
  if (q.output.format === 'png') {
    const path = await cached(cachePath(key, '.zip'), async (temp) => writePngZip(q, file, await raster(), temp, progress))
    return [{ part: 'all', path, pages: q.pages.length }]
  }
  const title = `${file.name}`.replace(/\s+/g, ' ')
  const plan = fogPlanFor(q)
  const files: PrintFile[] = []
  const pdf = async (part: PrintPart, pages: number, draw: (doc: PDFKit.PDFDocument) => Promise<void>) => {
    files.push({ part, pages, path: await cached(cachePath(`${key}|${part}`, '.pdf'), (temp) => writeDoc(temp, title, draw)) })
  }
  if (q.marks.overview) await pdf('overview', 1, (doc) => drawOverviewPage(doc, q, file, title, plan))
  await pdf('sheets', q.pages.length, async (doc) => drawMapSheets(doc, q, file, await raster(), title, progress))
  if (plan.sheets) await pdf('fog', plan.sheets + (q.marks.overview ? 0 : 1), (doc) => drawFogCards(doc, q, file, plan, title))
  return files
}

