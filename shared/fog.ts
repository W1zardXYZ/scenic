import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping'
import { intersect, type Rect } from './layout.ts'

/** A point on a closed curve; its handles are relative to it, in the same units. */
export interface CurvePoint {
  x: number
  y: number
  inX: number
  inY: number
  outX: number
  outY: number
}

export type FogShape = { box: Rect; points?: undefined } | { points: CurvePoint[]; box?: undefined }

/** One shape of a fog. Parts apply in order, each adding to or cutting from those before it. */
export type FogPart = FogShape & { subtract: boolean }

export interface FogItem {
  id: number
  name: string
  on: boolean
  /** `cover` hides the inside; `show` keeps the inside and covers everything else. */
  mode: 'cover' | 'show'
  parts: FogPart[]
}

export interface Fog {
  /** Turns every item off without forgetting which ones were on. */
  on: boolean
  items: FogItem[]
  fill: string
  /** Prints covers on their own sheets, to cut out, rather than on the map. */
  separate: boolean
  /** Draws cover edges on the map sheets; separate sheets always have them, for cutting. */
  outline: boolean
}

export const NEW_FOG: Fog = { on: true, items: [], fill: '#ffffff', separate: false, outline: true }

export const liveFog = (fog: Fog) => (fog.on ? fog.items.filter((item) => item.on && fogPath(item)) : [])

/** What goes on the map sheets. `show` is always baked in: its cover has a hole, not a shape to cut. */
export const bakedFog = (fog: Fog) => liveFog(fog).filter((item) => !fog.separate || item.mode === 'show')

export const separateFog = (fog: Fog) => (fog.separate ? liveFog(fog).filter((item) => item.mode === 'cover') : [])

export function scaleFog(fog: Fog, sx: number, sy: number): Fog {
  const scalePart = (part: FogPart): FogPart => (part.box
    ? { ...part, box: { x: part.box.x * sx, y: part.box.y * sy, w: part.box.w * sx, h: part.box.h * sy } }
    : {
        ...part,
        points: part.points.map((p) => ({ x: p.x * sx, y: p.y * sy, inX: p.inX * sx, inY: p.inY * sy, outX: p.outX * sx, outY: p.outY * sy })),
      })
  return { ...fog, items: fog.items.map((item) => ({ ...item, parts: item.parts.map(scalePart) })) }
}

const n = (v: number) => v.toFixed(2)

export function curvePath(points: CurvePoint[]): string {
  const parts = [`M${n(points[0].x)} ${n(points[0].y)}`]
  points.forEach((a, i) => {
    const b = points[(i + 1) % points.length]
    parts.push(`C${n(a.x + a.outX)} ${n(a.y + a.outY)} ${n(b.x + b.inX)} ${n(b.y + b.inY)} ${n(b.x)} ${n(b.y)}`)
  })
  return `${parts.join('')}Z`
}

export const partPath = (part: FogShape) => (part.box
  ? `M${n(part.box.x)} ${n(part.box.y)}h${n(part.box.w)}v${n(part.box.h)}h${n(-part.box.w)}Z`
  : curvePath(part.points))

function pointOn(a: CurvePoint, b: CurvePoint, t: number) {
  const u = 1 - t
  const at = (p0: number, p1: number, p2: number, p3: number) => u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  return { x: at(a.x, a.x + a.outX, b.x + b.inX, b.x), y: at(a.y, a.y + a.outY, b.y + b.inY, b.y) }
}

const SAMPLES = 16

/** Takes out one part; whatever then comes first has nothing to subtract from, so it adds. */
export const withoutPart = (parts: FogPart[], index: number) =>
  parts.filter((_, i) => i !== index).map((part, i) => (i === 0 ? { ...part, subtract: false } : part))

const curved = (a: CurvePoint, b: CurvePoint) => !!(a.outX || a.outY || b.inX || b.inY)

/** The outline as straight lines; a sharp edge needs no more points than its two ends. */
function flatten(part: FogShape): Ring {
  if (part.box) {
    const { x, y, w, h } = part.box
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
  }
  return part.points.flatMap((a, i) => {
    const b = part.points[(i + 1) % part.points.length]
    return Array.from({ length: curved(a, b) ? SAMPLES : 1 }, (_, s): [number, number] => {
      const p = pointOn(a, b, s / SAMPLES)
      return [p.x, p.y]
    })
  })
}

export function partBounds(part: FogShape): Rect {
  if (part.box) return part.box
  const ring = flatten(part)
  const xs = ring.map((p) => p[0])
  const ys = ring.map((p) => p[1])
  const [x, y] = [Math.min(...xs), Math.min(...ys)]
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

function combine(parts: FogPart[]): MultiPolygon {
  return parts.reduce<MultiPolygon>((shape, part) => {
    const added: MultiPolygon = [[flatten(part)]]
    if (part.subtract) return shape.length ? polygonClipping.difference(shape, added) : []
    return shape.length ? polygonClipping.union(shape, added) : polygonClipping.union(added)
  }, [])
}

interface Region {
  /** Holes run the opposite way to outlines, so this fills correctly with the default fill rule. */
  path: string
  bounds: Rect
}

const NOTHING: Region = { path: '', bounds: { x: 0, y: 0, w: 0, h: 0 } }
const regions = new WeakMap<FogItem, Region>()

function measure(item: FogItem): Region {
  if (item.parts.length === 1 && !item.parts[0].subtract) return { path: partPath(item.parts[0]), bounds: partBounds(item.parts[0]) }
  let rings: Ring[]
  try {
    rings = combine(item.parts).flat()
  } catch {
    // The clipper can give up on a badly tangled lasso; the parts still draw, just not combined.
    return { path: item.parts.filter((p) => !p.subtract).map(partPath).join(''), bounds: partBounds(item.parts[0]) }
  }
  if (!rings.length) return NOTHING
  const corners = rings.flat()
  const xs = corners.map((p) => p[0])
  const ys = corners.map((p) => p[1])
  const [x, y] = [Math.min(...xs), Math.min(...ys)]
  return {
    path: rings.map((ring) => `M${ring.map((p) => `${n(p[0])} ${n(p[1])}`).join('L')}Z`).join(''),
    bounds: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y },
  }
}

function regionOf(item: FogItem): Region {
  let region = regions.get(item)
  if (!region) regions.set(item, region = measure(item))
  return region
}

/** The finished outline of a fog with its parts combined; empty if nothing is left. */
export const fogPath = (item: FogItem) => regionOf(item).path

export const fogBounds = (item: FogItem) => regionOf(item).bounds

export const touches = (item: FogItem, area: Rect) => !!intersect(fogBounds(item), area)

type Point = { x: number; y: number }

/** Ramer-Douglas-Peucker: keeps the points that actually shape a hand-drawn line. */
export function simplify(line: Point[], tolerance: number): Point[] {
  if (line.length < 3) return line
  const [a, b] = [line[0], line.at(-1)!]
  const length = Math.hypot(b.x - a.x, b.y - a.y)
  let far = 0
  let index = 0
  for (let i = 1; i < line.length - 1; i++) {
    const p = line[i]
    const d = length ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length : Math.hypot(p.x - a.x, p.y - a.y)
    if (d > far) [far, index] = [d, i]
  }
  if (far <= tolerance) return [a, b]
  return [...simplify(line.slice(0, index + 1), tolerance).slice(0, -1), ...simplify(line.slice(index), tolerance)]
}

/** Gives each point smooth handles, so the closed curve runs through all of them. */
export function smoothCurve(points: Point[]): CurvePoint[] {
  return points.map((p, i) => {
    const before = points[(i - 1 + points.length) % points.length]
    const after = points[(i + 1) % points.length]
    const tx = (after.x - before.x) / 6
    const ty = (after.y - before.y) / 6
    return { x: p.x, y: p.y, inX: -tx, inY: -ty, outX: tx, outY: ty }
  })
}

/** A shape of straight lines and sharp corners. */
export const sharpCurve = (points: Point[]): CurvePoint[] => points.map((p) => ({ x: p.x, y: p.y, inX: 0, inY: 0, outX: 0, outY: 0 }))

/** Turns a pen stroke into a closed smooth shape, or nothing if it is too small to be one. */
export function curveFromStroke(stroke: Point[], tolerance: number): CurvePoint[] | null {
  const kept = simplify([...stroke, stroke[0]], tolerance).slice(0, -1)
  return kept.length >= 3 ? smoothCurve(kept) : null
}

export function circleCurve(cx: number, cy: number, radius: number): CurvePoint[] {
  return smoothCurve(Array.from({ length: 8 }, (_, i) => ({
    x: cx + radius * Math.cos((i * Math.PI) / 4),
    y: cy + radius * Math.sin((i * Math.PI) / 4),
  })))
}

/** Finds where on the curve a spot is nearest: the segment that starts at `index`, and how far along. */
export function nearestOnCurve(points: CurvePoint[], spot: Point): { index: number; t: number } {
  let best = { index: 0, t: 0 }
  let least = Infinity
  points.forEach((a, index) => {
    const b = points[(index + 1) % points.length]
    for (let s = 0; s <= SAMPLES; s++) {
      const p = pointOn(a, b, s / SAMPLES)
      const d = Math.hypot(p.x - spot.x, p.y - spot.y)
      if (d < least) [least, best] = [d, { index, t: s / SAMPLES }]
    }
  })
  return best
}

/** De Casteljau: adds a point at `t` on a segment without changing the curve. */
export function splitCurve(points: CurvePoint[], index: number, t: number): CurvePoint[] {
  const a = points[index]
  const next = (index + 1) % points.length
  const b = points[next]
  const mix = (p: Point, q: Point) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
  const [p0, p1, p2, p3] = [a, { x: a.x + a.outX, y: a.y + a.outY }, { x: b.x + b.inX, y: b.y + b.inY }, b]
  const [q0, q1, q2] = [mix(p0, p1), mix(p1, p2), mix(p2, p3)]
  const [r0, r1] = [mix(q0, q1), mix(q1, q2)]
  const s = mix(r0, r1)
  const added: CurvePoint = { x: s.x, y: s.y, inX: r0.x - s.x, inY: r0.y - s.y, outX: r1.x - s.x, outY: r1.y - s.y }
  const copy = [...points]
  copy[index] = { ...a, outX: q0.x - a.x, outY: q0.y - a.y }
  copy[next] = { ...b, inX: q2.x - b.x, inY: q2.y - b.y }
  copy.splice(index + 1, 0, added)
  return copy
}

/** Black or white, whichever reads on the colour. */
export function inkOn(fill: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(fill.slice(i, i + 2), 16))
  return r * 0.2126 + g * 0.7152 + b * 0.0722 > 128 ? '#000000' : '#ffffff'
}
