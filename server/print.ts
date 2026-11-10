import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import yazl from 'yazl'
import {
  FOG_TAB_MM, gridSegments, hexNumbers, intersect, type Page, type Rect, type Segment,
} from '../shared/layout.ts'
import {
  bakedFog, type Fog, type FogCard, type FogItem, type FogPart, type FogPlan, fogBounds, fogPath, fogPlan, inkOn, labelRoom, labelTone, touches,
} from '../shared/fog.ts'
import type { GridType } from '../shared/types.ts'
import { isNeutral, type Levels, toneCurve } from '../shared/tone.ts'
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

interface Overlay {
  /** Where the grid may draw, relative to the printed area. */
  clip: Rect
  grid: Segment[]
  numbers: { x: number; y: number; text: string }[]
  marks: Segment[]
  label: string
}

function overlayFor(q: PrintRequest, file: FileRow, sheet: Sheet): Overlay {
  const { page } = sheet
  const offsetX = (q.grid.offsetX / (file.width / q.grid.cols)) * q.squareMm
  const offsetY = (q.grid.offsetY / (file.height / q.grid.rows)) * q.squareMm
  const shift = ([a, b, c, d]: Segment): Segment => [a - page.x, b - page.y, c - page.x, d - page.y]
  const area = q.crop ? intersect(page, q.crop) : page
  const grid = q.overlay.show && area ? gridSegments(q.grid.type, area, q.squareMm, offsetX, offsetY).map(shift) : []
  const clip = area ? { ...area, x: area.x - page.x, y: area.y - page.y } : { x: 0, y: 0, w: 0, h: 0 }
  const numbers = q.overlay.show && q.grid.type === 'hex' && q.overlay.numbering
    ? hexNumbers(page, q.squareMm, offsetX, offsetY).map((n) => ({ ...n, x: n.x - page.x, y: n.y - page.y }))
    : []

  const marks: Segment[] = []
  const reach = Math.min(4, Math.min(sheet.left, sheet.top) - 1)
  if (q.marks.cut && reach > 0.5) {
    const gap = 0.5
    for (const x of [0, page.w]) {
      const out = x ? 1 : -1
      for (const y of [0, page.h]) {
        const down = y ? 1 : -1
        marks.push([x + out * gap, y, x + out * (gap + reach), y], [x, y + down * gap, x, y + down * (gap + reach)])
      }
    }
  }
  return { clip, grid, numbers, marks, label: page.label }
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
  const names = covers.filter((i) => i.name.trim()).map((i) => {
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
function cardLabels(q: PrintRequest, card: FogCard): Label[] {
  // Centred on the shape within this piece: a label off the shape would be cut away with the paper.
  const box = labelRoom(card.item, card.region) ?? card.region
  const color = labelTone(q.fog.fill)
  const name = card.item.name.trim()
  const room = box.w * 0.8
  const s = Math.min(6, box.h * 0.2, fitted(card.id, Infinity, room / 1.4, 'bold'), name ? fitted(name, Infinity, room) : Infinity)
  const [idCap, gap, nameCap] = [capHeight(s * 1.4, 'bold'), s * 0.6, name ? capHeight(s) : 0]
  const top = box.y + (box.h - idCap - (name ? gap + nameCap : 0)) / 2
  const x = box.x + box.w / 2
  const labels: Label[] = [{ text: card.id, x, y: top + idCap / 2, size: s * 1.4, weight: 'bold', color }]
  if (name) labels.push({ text: name, x, y: top + idCap + gap + nameCap / 2, size: s, weight: 'regular', color })
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
function placementLayout(q: PrintRequest) {
  const map = { x: 0, y: 0, w: q.grid.cols * q.squareMm, h: q.grid.rows * q.squareMm }
  const view = (q.crop && intersect(map, q.crop)) || map
  const { sheetW, sheetH } = q.pages[0]
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

type PlacementLayout = ReturnType<typeof placementLayout>

/** Every separate cover outlined where it goes, split ones with their seams, over a map drawn underneath. */
function placementSvg(plan: FogPlan, L: PlacementLayout, labels: Label[]): string {
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
    <rect x="${L.x}" y="${L.y}" width="${view.w * scale}" height="${view.h * scale}" fill="none" stroke="#000" stroke-width="0.2"/>
    ${labels.map(svgLabel).join('')}</svg>`
}

/** A heading, then each cover's mark on it; a split cover marks every piece, where that piece goes. */
function placementLabels(plan: FogPlan, L: PlacementLayout): Label[] {
  const width = L.sheetW - L.margin * 2
  const title = 'Fog placement'
  const intro = 'Cut out each fog card and lay it where its mark shows. Pieces of a split cover overlap on the dashed glue tabs.'
  const labels: Label[] = [
    { text: title, x: L.sheetW / 2, y: L.margin + 2.5, size: fitted(title, 7, width, 'bold'), weight: 'bold', color: '#111111' },
    { text: intro, x: L.sheetW / 2, y: L.margin + 9.5, size: fitted(intro, 3.4, width), weight: 'regular', color: '#555555' },
  ]
  const items = [...new Set(plan.cards.map((c) => c.item))]
  const marks = items.flatMap((item) => {
    const pieces = plan.cards.filter((c) => c.item === item)
    return pieces.length > 1
      ? pieces.map((c) => ({ text: c.id, box: labelRoom(item, c.region) }))
      : [{ text: pieces[0].mark, box: labelRoom(item, fogBounds(item)) }]
  })
  for (const { text, box } of marks) {
    const seen = box && intersect(box, L.view)
    if (!seen) continue
    const x = L.x + (seen.x + seen.w / 2 - L.view.x) * L.scale
    const y = L.y + (seen.y + seen.h / 2 - L.view.y) * L.scale
    labels.push({ text, x, y, size: 4, weight: 'bold', color: '#111111', halo: '#ffffff' })
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

const stroke = (doc: PDFKit.PDFDocument, segments: Segment[]) => {
  for (const [a, b, c, d] of segments) doc.moveTo(a * MM, b * MM).lineTo(c * MM, d * MM)
  doc.stroke()
}

function drawPdfOverlay(doc: PDFKit.PDFDocument, q: PrintRequest, sheet: Sheet, overlay: Overlay, title: string) {
  const { page, left, top } = sheet
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
  if (overlay.marks.length) {
    doc.save()
    origin()
    doc.strokeColor('#000000').lineWidth(0.25)
    stroke(doc, overlay.marks)
    doc.restore()
  }
  if (q.marks.labels && sheet.h - (top + page.h) >= 3) {
    doc.save()
    doc.fillColor('#555555').fontSize(6)
    const text = `${overlay.label}   ${title}`
    doc.text(text, left * MM, (top + page.h + 1) * MM, { lineBreak: false, width: page.w * MM, height: 8, ellipsis: true })
    doc.restore()
  }
}

async function drawOverviewPage(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, title: string) {
  const { sheetW, sheetH } = q.pages[0]
  const landscape = sheetW > sheetH
  doc.addPage({ size: [sheetW * MM, sheetH * MM], margin: 0 })
  const margin = Math.max(q.marginMm, 10)
  const mapW = (q.grid.cols * q.squareMm)
  const mapH = (q.grid.rows * q.squareMm)

  doc.fillColor('#111111').fontSize(16).text(title, margin * MM, margin * MM, { width: (sheetW - margin * 2) * MM, lineBreak: false, height: 20, ellipsis: true })
  const summary = `${q.pages.length} sheets   ${Math.round(q.grid.cols)} × ${Math.round(q.grid.rows)} squares   ${q.squareMm.toFixed(1)} mm per square   ${(mapW / 10).toFixed(1)} × ${(mapH / 10).toFixed(1)} cm`
  doc.fillColor('#555555').fontSize(9).text(summary, margin * MM, (margin + 8) * MM, { lineBreak: false })

  // Printing at "fit to page" is the classic mistake; this bar exposes it on the first sheet.
  const barY = sheetH - margin - 8
  doc.fillColor('#111111').rect(margin * MM, barY * MM, 25.4 * MM, 3 * MM).fill()
  doc.rect((margin + 40) * MM, barY * MM, 25 * MM, 3 * MM).fill()
  doc.fillColor('#555555').fontSize(7)
  doc.text('1 inch', margin * MM, (barY + 4) * MM, { lineBreak: false })
  doc.text('25 mm', (margin + 40) * MM, (barY + 4) * MM, { lineBreak: false })
  doc.text('Print at 100% / actual size. If these bars measure wrong, turn off "fit to page".', (margin + 72) * MM, barY * MM, {
    width: (sheetW - margin * 2 - 72) * MM,
  })

  const areaTop = margin + 16
  const areaH = barY - areaTop - 6
  const areaW = sheetW - margin * 2
  const bounds = q.pages.reduce(
    (b, p) => ({ x: Math.min(b.x, p.x), y: Math.min(b.y, p.y), r: Math.max(b.r, p.x + p.w), b: Math.max(b.b, p.y + p.h) }),
    { x: 0, y: 0, r: mapW, b: mapH },
  )
  const scale = Math.min(areaW / (bounds.r - bounds.x), areaH / (bounds.b - bounds.y))
  const ox = margin + (areaW - (bounds.r - bounds.x) * scale) / 2 - bounds.x * scale
  const oy = areaTop + (landscape ? 0 : (areaH - (bounds.b - bounds.y) * scale) / 2) - bounds.y * scale

  const preview = await sharp(thumbPath(file.id, 'large')).jpeg({ quality: 80 }).toBuffer()
  doc.image(preview, ox * MM, oy * MM, { width: mapW * scale * MM, height: mapH * scale * MM })
  const fog = await bakedLayer(q, { x: 0, y: 0, w: mapW, h: mapH }, FOG_PX_PER_MM * scale)
  if (fog) doc.image(fog, ox * MM, oy * MM, { width: mapW * scale * MM, height: mapH * scale * MM })
  for (const p of q.pages) {
    const [x, y, w, h] = [(ox + p.x * scale) * MM, (oy + p.y * scale) * MM, p.w * scale * MM, p.h * scale * MM]
    doc.rect(x, y, w, h).lineWidth(0.75).strokeColor('#ffffff').stroke()
    doc.rect(x, y, w, h).lineWidth(0.25).strokeColor('#000000').stroke()
    const size = Math.min(10, h * 0.3)
    doc.fontSize(size).fillColor('#ffffff').text(p.label, x, y + h / 2 - size / 2, { width: w, align: 'center', lineBreak: false, stroke: true, fill: true })
  }
}

async function drawPlacementPage(doc: PDFKit.PDFDocument, q: PrintRequest, file: FileRow, plan: FogPlan) {
  const L = placementLayout(q)
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

async function writePdf(q: PrintRequest, file: FileRow, raster: string, target: string, progress: (done: number) => void) {
  const title = `${file.name}`.replace(/\s+/g, ' ')
  // The bundled face rather than a PDF base font, so PDF text matches the outlined text in the raster layers.
  const doc = new PDFDocument({ autoFirstPage: false, compress: true, font: FONT_FILE.regular, info: { Title: title, Creator: 'Scenic' } })
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
    const fog = await bakedLayer(q, sheet.page, FOG_PX_PER_MM)
    if (fog) doc.image(fog, sheet.left * MM, sheet.top * MM, { width: sheet.page.w * MM, height: sheet.page.h * MM })
    progress(++done)
  }
  const plan = fogPlanFor(q)
  if (plan.sheets) await drawPlacementPage(doc, q, file, plan)
  for (const [i, cards] of cardsBySheet(plan).entries()) await drawFogSheet(doc, q, plan, cards, i, title)
  doc.end()
  await finished(out)
}

function overlaySvg(q: PrintRequest, sheet: Sheet, overlay: Overlay): string {
  const { page, left, top } = sheet
  const path = (segments: Segment[]) => segments.map(([a, b, c, d]) => `M${a.toFixed(2)} ${b.toFixed(2)}L${c.toFixed(2)} ${d.toFixed(2)}`).join('')
  const numbers = overlay.numbers
    .map((n) => `<text x="${n.x.toFixed(2)}" y="${(n.y + q.squareMm * 0.1).toFixed(2)}" font-size="${(q.squareMm * 0.12).toFixed(2)}" text-anchor="middle" font-family="sans-serif">${n.text}</text>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sheet.w} ${sheet.h}">
    <clipPath id="c"><rect x="${overlay.clip.x}" y="${overlay.clip.y}" width="${overlay.clip.w}" height="${overlay.clip.h}"/></clipPath>
    <g transform="translate(${left} ${top})">
      <g clip-path="url(#c)" fill="${q.overlay.color}" stroke="none" opacity="${q.overlay.opacity}">
        <path d="${path(overlay.grid)}" stroke="${q.overlay.color}" stroke-width="${q.overlay.widthMm}" fill="none"/>${numbers}
      </g>
      <path d="${path(overlay.marks)}" stroke="#000" stroke-width="0.1" fill="none"/>
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
      const fitted = await sharp(tile.data)
        .resize(Math.round(tile.w * pxPerMm), Math.round(tile.h * pxPerMm), { fit: 'fill' })
        .extract({
          left: Math.round((x - tile.x) * pxPerMm),
          top: Math.round((y - tile.y) * pxPerMm),
          width: Math.round(Math.min(tile.w - (x - tile.x), sheet.page.w - x) * pxPerMm),
          height: Math.round(Math.min(tile.h - (y - tile.y), sheet.page.h - y) * pxPerMm),
        })
        .toBuffer()
      layers.push({ input: fitted, left: Math.round((sheet.left + x) * pxPerMm), top: Math.round((sheet.top + y) * pxPerMm) })
    }
    const svg = await sharp(Buffer.from(overlaySvg(q, sheet, overlayFor(q, file, sheet))), { density: pxPerMm * 72 })
      .resize(width, height, { fit: 'fill' })
      .png()
      .toBuffer()
    layers.push({ input: svg })
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
    const L = placementLayout(q)
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

export const printKey = (q: PrintRequest, file: FileRow) => `print|${file.path}|${file.entry}|${file.mtime}|${JSON.stringify(q)}`

export async function generate(q: PrintRequest, file: FileRow, progress: (done: number) => void): Promise<string> {
  const ext = q.output.format === 'pdf' ? '.pdf' : '.zip'
  return cached(cachePath(printKey(q, file), ext), async (temp) => {
    const raster = await preparedRaster(file, q.filter)
    if (q.output.format === 'pdf') await writePdf(q, file, raster, temp, progress)
    else await writePngZip(q, file, raster, temp, progress)
  })
}

