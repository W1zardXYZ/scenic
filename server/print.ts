import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import yazl from 'yazl'
import {
  assemblyPlan, type Edge, edgeLines, FOG_TAB_MM, fogPieces, gridSegments, hexNumbers, intersect, type Page, paperOf, type Rect,
  type Segment, type Side,
} from '../shared/layout.ts'
import { fadeMask, fadeRegion } from '../shared/fade.ts'
import { bakedFog, type Fog, type FogItem, type FogPart, fogBounds, fogPath, inkOn, separateFog, touches } from '../shared/fog.ts'
import type { GridType } from '../shared/types.ts'
import { isNeutral, type Levels, toneCurve } from '../shared/tone.ts'
import { PIXEL_LIMIT } from './analyze.ts'
import type { FileRow } from './db.ts'
import { safeName } from './export.ts'
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
  filter: { mode: 'color' | 'grey' | 'light' | 'threshold'; amount: number; levels: Levels }
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
  if (!q.marks) return 'marks'
  if (!q.fog || !Array.isArray(q.fog.items) || q.fog.items.length > 100 || !q.fog.items.every(isFogItem) || !/^#[0-9a-f]{6}$/i.test(q.fog.fill)) return 'fog'
  if (q.crop && !isRect(q.crop)) return 'crop'
  if (q.fadeMm !== undefined && !finite(q.fadeMm, 0, 200)) return 'fade'
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
    if (filter.mode === 'light') image.linear(1 - filter.amount, 255 * filter.amount)
    if (filter.mode === 'grey' || filter.mode === 'threshold') {
      const { data, info } = await image.greyscale().raw().toBuffer({ resolveWithObject: true })
      const raw = { width: info.width, height: info.height, channels: 1 as const }
      if (!isNeutral(filter.levels)) {
        const curve = toneCurve(filter.levels)
        for (let i = 0; i < data.length; i++) data[i] = curve[data[i]]
      }
      const toned = sharp(data, { raw })
      if (filter.mode === 'threshold') toned.threshold(Math.round(filter.amount * 255), { greyscale: true })
      await toned.toFile(temp)
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
/** Roughly Helvetica's average advance, to fit notes the same way in the PDF and the PNG. */
const fitText = (text: string, mm: number) => {
  const room = Math.floor(mm / (NOTE_MM * 0.55))
  return text.length <= room ? text : room > 3 ? `${text.slice(0, room - 1).trimEnd()}…` : ''
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

function fogSheets(q: PrintRequest) {
  const reference = q.pages[0]
  return separateFog(q.fog).flatMap((item) => {
    const bounds = fogBounds(item)
    const pieces = fogPieces(bounds, reference.sheetW, reference.sheetH, q.marginMm, q.squareMm)
    return pieces.map((piece, i) => ({
      sheet: sheetOf({ ...piece.page, label: `${item.name} ${i + 1}` }),
      item,
      region: { x: bounds.x + piece.page.x, y: bounds.y + piece.page.y, w: piece.page.w, h: piece.page.h },
      tabRight: piece.tabRight,
      tabBottom: piece.tabBottom,
      name: `${item.name} — piece ${i + 1} of ${pieces.length}`,
    }))
  })
}

const escapeXml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
const CUT_LINE = 'stroke="#000" stroke-width="0.4"'
const fogSvgOpen = (view: Rect) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.x} ${view.y} ${view.w} ${view.h}">`

function fogName(item: FogItem, x: number, y: number, size: number, fill: string) {
  return `<text x="${x}" y="${y}" font-size="${Math.min(size, 14)}" font-family="sans-serif" text-anchor="middle" dominant-baseline="central" fill="${inkOn(fill)}">${escapeXml(item.name)}</text>`
}

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
  const names = covers.map((i) => {
    const b = fogBounds(i)
    return fogName(i, b.x + b.w / 2, b.y + b.h / 2, Math.min(b.w, b.h) * 0.14, q.fog.fill)
  }).join('')
  const edges = q.fog.outline ? covers.map((i) => `<path d="${fogPath(i)}" fill="none" ${CUT_LINE}/>`).join('') : ''
  return `${fogSvgOpen(region)}
    <mask id="f" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="${shows.length ? '#fff' : '#000'}"/>${shapes(shows, '#000')}${shapes(covers, '#fff')}</mask>
    <clipPath id="c"><rect x="${area.x}" y="${area.y}" width="${area.w}" height="${area.h}"/></clipPath>
    <g clip-path="url(#c)"><rect ${box} fill="${q.fog.fill}" mask="url(#f)"/>${edges}${names}</g></svg>`
}

/** One sheet of a cover printed on its own. Cut along the solid line; dashes mark where the next piece glues on. */
function pieceSvg(q: PrintRequest, fog: ReturnType<typeof fogSheets>[number], pad: number): string {
  const { item, region: r, tabRight, tabBottom } = fog
  const d = fogPath(item)
  const ink = inkOn(q.fog.fill)
  const glue = [
    tabRight ? `M${r.x + r.w - FOG_TAB_MM} ${r.y}v${r.h}` : '',
    tabBottom ? `M${r.x} ${r.y + r.h - FOG_TAB_MM}h${r.w}` : '',
  ].join('')
  // Every piece carries the name whole, so it fits the piece rather than the shape.
  const size = Math.min(r.w, r.h, (r.w / Math.max(1, item.name.length)) * 1.4) * 0.5
  return `${fogSvgOpen({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 })}
    <clipPath id="p"><rect x="${r.x - pad}" y="${r.y - pad}" width="${r.w + pad * 2}" height="${r.h + pad * 2}"/></clipPath>
    <clipPath id="s"><path d="${d}"/></clipPath>
    <clipPath id="r"><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/></clipPath>
    <g clip-path="url(#r)"><path d="${d}" fill="${q.fog.fill}"/></g>
    <g clip-path="url(#p)">
      <path d="${d}" fill="none" ${CUT_LINE}/>
      <g clip-path="url(#s)">
        <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#000" stroke-width="0.8"/>
        <path d="${glue}" fill="none" stroke="${ink}" stroke-opacity="0.6" stroke-width="0.2" stroke-dasharray="1.4 1"/>
      </g>
      ${fogName(item, r.x + r.w / 2, r.y + r.h / 2, size, q.fog.fill)}
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
const fogPad = ({ left, top }: Sheet) => Math.min(1, left, top)

function pieceLayer(q: PrintRequest, fog: ReturnType<typeof fogSheets>[number], pxPerMm: number) {
  const pad = fogPad(fog.sheet)
  return rasterSvg(pieceSvg(q, fog, pad), fog.region.w + pad * 2, fog.region.h + pad * 2, pxPerMm)
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

async function drawOverviewPage(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, title: string) {
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
  const steps = q.marks.cut ? assemblySteps(q) : []
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
    const size = Math.min(10, h * 0.3)
    doc.fontSize(size).fillColor('#ffffff').text(p.label, x, y + h / 2 - size / 2, { width: w, align: 'center', lineBreak: false, stroke: true, fill: true })
  }

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

async function drawFog(doc: PDFKit.PDFDocument, q: PrintRequest, fog: ReturnType<typeof fogSheets>[number]) {
  const { sheet, region, name } = fog
  const { page, left, top } = sheet
  const pad = fogPad(sheet)
  doc.image(await pieceLayer(q, fog, FOG_PX_PER_MM), (left - pad) * MM, (top - pad) * MM, { width: (region.w + pad * 2) * MM, height: (region.h + pad * 2) * MM })
  doc.fillColor('#555555').fontSize(6).text(name, left * MM, (top + page.h + 1) * MM, { lineBreak: false })
}

async function writePdf(q: PrintRequest, file: FileRow, raster: string, target: string, progress: (done: number) => void) {
  const title = `${file.name}`.replace(/\s+/g, ' ')
  const doc = new PDFDocument({ autoFirstPage: false, compress: true, info: { Title: title, Creator: 'Scenic' } })
  const out = doc.pipe(createWriteStream(target))
  if (q.marks.overview) await drawOverviewPage(doc, q, file, title)

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
  for (const fog of fogSheets(q)) {
    doc.addPage({ size: [fog.sheet.w * MM, fog.sheet.h * MM], margin: 0 })
    await drawFog(doc, q, fog)
  }
  doc.end()
  await finished(out)
}

function overlaySvg(q: PrintRequest, sheet: Sheet, overlay: Overlay): string {
  const { left, top } = sheet
  const path = (segments: Segment[]) => segments.map(([a, b, c, d]) => `M${a.toFixed(2)} ${b.toFixed(2)}L${c.toFixed(2)} ${d.toFixed(2)}`).join('')
  const numbers = overlay.numbers
    .map((n) => `<text x="${n.x.toFixed(2)}" y="${(n.y + q.squareMm * 0.1).toFixed(2)}" font-size="${(q.squareMm * 0.12).toFixed(2)}" text-anchor="middle" font-family="sans-serif">${n.text}</text>`)
    .join('')
  const notes = overlay.notes
    .map((n) => `<text transform="translate(${n.x.toFixed(2)} ${n.y.toFixed(2)}) rotate(${n.angle})" text-anchor="${n.anchor}" dominant-baseline="central">${escapeXml(n.text)}</text>`)
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
      <g font-family="Helvetica, Arial, sans-serif" font-size="${NOTE_MM.toFixed(3)}" fill="#555555">${notes}</g>
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
  for (const fog of fogSheets(q)) {
    const { sheet } = fog
    const pad = fogPad(sheet)
    const png = await sharp({
      create: { width: Math.round(sheet.w * pxPerMm), height: Math.round(sheet.h * pxPerMm), channels: 3, background: '#ffffff' },
    })
      .composite([{ input: await pieceLayer(q, fog, pxPerMm), left: Math.round((sheet.left - pad) * pxPerMm), top: Math.round((sheet.top - pad) * pxPerMm) }])
      .png()
      .toBuffer()
    zip.addBuffer(png, `${safeName(file.name)} ${safeName(sheet.page.label)}.png`, { compress: false })
  }
  zip.end()
  await finished(out)
}

export const printKey = (q: PrintRequest, file: FileRow) => `print|${file.path}|${file.entry}|${file.mtime}|${JSON.stringify(q)}`

export async function generate(q: PrintRequest, file: FileRow, progress: (done: number) => void): Promise<string> {
  const ext = q.output.format === 'pdf' ? '.pdf' : '.zip'
  return cached(cachePath(printKey(q, file), ext), async (temp) => {
    const raster = await preparedRaster(file, q.filter)
    if (q.output.format === 'pdf') await writePdf(q, file, raster, temp, progress)
    else await writePngZip(q, file, raster, temp, progress)
  })
}

