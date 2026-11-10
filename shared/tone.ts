// How a map's colours and tones change on paper. Shared by the print preview
// and the renderer, so what the canvas shows is what the printer gets.

export interface Levels {
  /** Input values at or below `black` print black, at or above `white` print white (0-255). */
  black: number
  white: number
  /** Above 1 lifts the midtones, below 1 darkens them. */
  gamma: number
}

/** A brightness band to lighten (amount > 0) or darken (amount < 0), in input values 0-255. */
export interface Band {
  from: number
  to: number
  /** Width of the edge on each side, over which the change fades out. */
  soft: number
  /** Share of the edge width the band moves by: at 1 or -1 the edge on one side goes flat. */
  amount: number
}

export type FilterMode = 'color' | 'grey' | 'light' | 'threshold'

export interface Filter {
  mode: FilterMode
  /** How much the saver lightens, or the B&W cut-off, 0-1. */
  amount: number
  /** Only used by the grey modes. */
  levels: Levels
  /** Brightness in → brightness out, 0-255, inputs strictly increasing, ends included. */
  curve: [number, number][]
  bands: Band[]
  /** Lighten (> 0) or darken (< 0) one family of hues each, -1 to 1, in the order of `HUES`. */
  hues: number[]
  /** Colour range selections, applied in order like layers. */
  selections: Selection[]
}

/** A colour picked from the source map; a subtracting sample takes its colours back out. */
export interface Sample {
  color: string
  subtract: boolean
}

/** Pixels picked by source colour, as Photoshop's Color Range picks them, and how to change their brightness. */
export interface Selection {
  samples: Sample[]
  /** How far from a sample still counts, in OKLab distance × 100; the edge fades out softly. */
  fuzziness: number
  /** Brightness in → out for the selected pixels. */
  curve: [number, number][]
  /** After the curve: toward white (> 0) or black (< 0), -1 to 1. */
  amount: number
}

export const NEUTRAL_LEVELS: Levels = { black: 0, white: 255, gamma: 1 }
export const STRAIGHT: [number, number][] = [[0, 0], [255, 255]]
export const HUES = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'] as const
export const NO_HUES = HUES.map(() => 0)
export const MAX_CURVE_POINTS = 16
export const MAX_BANDS = 8
export const MAX_SELECTIONS = 8
export const MAX_SAMPLES = 16
export const FUZZINESS = { min: 1, max: 100, start: 12 }

export const NEW_FILTER: Filter = { mode: 'color', amount: 0.3, levels: NEUTRAL_LEVELS, curve: STRAIGHT, bands: [], hues: NO_HUES, selections: [] }
export const NEW_SELECTION: Selection = { samples: [], fuzziness: FUZZINESS.start, curve: STRAIGHT, amount: 0 }

export const CURVE_PRESETS: [string, [number, number][]][] = [
  ['Lighten shadows', [[0, 0], [64, 112], [255, 255]]],
  ['Ink saver', [[0, 72], [128, 184], [255, 255]]],
  ['Contrast', [[0, 0], [64, 48], [192, 208], [255, 255]]],
]

export const BAND_PRESETS = {
  shadows: { from: 0, to: 64, soft: 64 },
  midtones: { from: 96, to: 160, soft: 48 },
  highlights: { from: 192, to: 255, soft: 64 },
}

export const isNeutral = (l: Levels) => l.black === 0 && l.white === 255 && l.gamma === 1
export const isStraight = (curve: [number, number][]) => curve.every(([x, y]) => x === y)

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))

/** Levels at one input value, unrounded. */
export function levelsAt({ black, white, gamma }: Levels, v: number): number {
  return clamp((v - black) / (white - black), 0, 1) ** (1 / gamma) * 255
}

/** Output (0-255) for every input value. */
export function toneCurve(levels: Levels): Uint8Array {
  return Uint8Array.from({ length: 256 }, (_, v) => Math.round(levelsAt(levels, v)))
}

/**
 * The curve through `points` as a function. Monotone cubic (Fritsch-Butland),
 * so between two points it never overshoots or turns back; flat beyond the ends.
 */
export function curveFunction(points: [number, number][]): (x: number) => number {
  const n = points.length
  const h = points.slice(1).map(([x], i) => x - points[i][0])
  const d = points.slice(1).map(([, y], i) => (y - points[i][1]) / h[i])
  const m = points.map((_, i) => {
    if (i === 0) return d[0] ?? 0
    if (i === n - 1) return d[n - 2]
    const [a, b] = [d[i - 1], d[i]]
    if (a * b <= 0) return 0
    return (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / a + (h[i] + 2 * h[i - 1]) / b)
  })
  return (x) => {
    if (x <= points[0][0]) return points[0][1]
    if (x >= points[n - 1][0]) return points[n - 1][1]
    let i = 0
    while (x > points[i + 1][0]) i++
    return clamp(hermite(points[i], m[i], points[i + 1], m[i + 1], x), 0, 255)
  }
}

/** The cubic from `a` to `b` with the given slopes at either end. */
function hermite([x0, y0]: [number, number], m0: number, [x1, y1]: [number, number], m1: number, x: number) {
  const h = x1 - x0
  const t = (x - x0) / h
  const t2 = t * t
  const t3 = t2 * t
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m1
}

/** From `a` to `b`, leaving and arriving at slope 1 where that cannot make it turn back (Fritsch-Carlson). */
function edge(a: [number, number], b: [number, number], x: number) {
  const d = (b[1] - a[1]) / (b[0] - a[0])
  const r = 2 / (d * d)
  const m = d <= 0 ? 0 : r > 9 ? 3 / Math.sqrt(r) : 1
  return hermite(a, m, b, m, x)
}

/**
 * A band as a curve: tones inside it move up or down together, so they keep
 * their contrast, and the edges on either side take up the difference. The
 * move is at most the edge width, so tones never swap order.
 */
export function bandFunction({ from, to, soft, amount }: Band): (x: number) => number {
  if (!amount || !soft) return (x) => x
  const lift = amount * soft
  return (x) => {
    const y = x <= from - soft || x >= to + soft ? x
      : x < from ? edge([from - soft, from - soft], [from, from + lift], x)
      : x <= to ? x + lift
      : edge([to, to + lift], [to + soft, to + soft], x)
    return clamp(y, 0, 255)
  }
}

/** Pulls `v` toward white (amount > 0) or black (amount < 0). */
const push = (v: number, amount: number) => (amount > 0 ? v + amount * (255 - v) : v + amount * v)

const isGrey = (filter: Filter) => filter.mode === 'grey' || filter.mode === 'threshold'

/** What reaches the curve for every input value: levels (grey modes), then the brightness bands in turn. */
export function curveInputs(filter: Filter): Float64Array {
  const bands = filter.bands.map(bandFunction)
  return Float64Array.from({ length: 256 }, (_, v) => {
    let x = isGrey(filter) ? levelsAt(filter.levels, v) : v
    for (const band of bands) x = band(x)
    return x
  })
}

/**
 * One output value per input value: levels and bands, the curve, then the
 * saver or the B&W cut-off. Applied to each channel alike.
 */
export function printTable(filter: Filter): Uint8Array {
  const curve = curveFunction(filter.curve)
  const cutoff = Math.round(filter.amount * 255)
  return Uint8Array.from(curveInputs(filter), (x) => {
    let y = curve(x)
    if (filter.mode === 'light') y = y * (1 - filter.amount) + 255 * filter.amount
    y = Math.round(y)
    return filter.mode === 'threshold' ? (y >= cutoff ? 255 : 0) : y
  })
}

/** A colour counts fully toward its hue family from this chroma on; greys and near-greys barely at all. */
const FULL_CHROMA = 64

/**
 * Lightens or darkens pixels by hue family, in place. Each family fades out
 * toward its neighbours, so neighbouring families blend without seams.
 */
export function shiftHues(data: Uint8Array | Uint8ClampedArray, channels: 3 | 4, hues: number[]) {
  if (hues.every((h) => h === 0)) return
  for (let i = 0; i < data.length; i += channels) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const chroma = max - min
    if (!chroma) continue
    // Hue in sixths of the circle: 0 red, 1 yellow, 2 green, 3 cyan, 4 blue, 5 magenta.
    const hue = max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4
    const low = Math.floor(hue) % 6
    const share = hue - Math.floor(hue)
    const amount = (hues[low] * (1 - share) + hues[(low + 1) % 6] * share) * Math.min(1, chroma / FULL_CHROMA)
    if (!amount) continue
    data[i] = Math.round(push(r, amount))
    data[i + 1] = Math.round(push(g, amount))
    data[i + 2] = Math.round(push(b, amount))
  }
}

/** Grey value of an sRGB pixel, with the weights the histogram uses. */
export const greyOf = (r: number, g: number, b: number) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)

const LINEAR = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})

/** OKLab of an sRGB pixel, ×100 so that distances read like percentages. */
export function oklab(r: number, g: number, b: number): [number, number, number] {
  const [lr, lg, lb] = [LINEAR[r], LINEAR[g], LINEAR[b]]
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    (0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s) * 100,
    (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s) * 100,
    (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s) * 100,
  ]
}

export const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
export const rgbToHex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

const smooth = (t: number) => t * t * (3 - 2 * t)

/** How much a colour belongs to a selection, 0-1, from its OKLab values. */
export type Weigher = (L: number, A: number, B: number) => number

/** Full weight at a sample, fading smoothly to none at `fuzziness` away; subtracting samples take their share back out. */
export function selectionWeigher({ samples, fuzziness }: Selection): Weigher {
  const labs = samples.map((s) => ({ lab: oklab(...hexToRgb(s.color)), subtract: s.subtract }))
  const adds = labs.filter((s) => !s.subtract).map((s) => s.lab)
  const subs = labs.filter((s) => s.subtract).map((s) => s.lab)
  const near = (points: [number, number, number][], L: number, A: number, B: number) => {
    let best = 0
    for (const [l, a, b] of points) {
      const d = Math.hypot(L - l, A - a, B - b)
      if (d < fuzziness) best = Math.max(best, smooth(1 - d / fuzziness))
    }
    return best
  }
  return (L, A, B) => {
    const add = near(adds, L, A, B)
    return add && subs.length ? add * (1 - near(subs, L, A, B)) : add
  }
}


/** What a selection does to each value, rounded to whole values like the rest of the print. */
function selectionTable({ curve, amount }: Selection): Float64Array {
  const f = curveFunction(curve)
  return Float64Array.from({ length: 256 }, (_, v) => push(f(v), amount))
}

/**
 * Applies each selection to the pixels, in place and in order. Which pixels
 * belong is decided by their colour before anything else changes them.
 */
function applySelections(data: Uint8Array | Uint8ClampedArray, channels: 3 | 4, selections: Selection[], weights: Float32Array[]) {
  selections.forEach((selection, k) => {
    const table = selectionTable(selection)
    const w = weights[k]
    for (let i = 0, j = 0; i < data.length; i += channels, j++) {
      if (!w[j]) continue
      for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] + w[j] * (table[data[i + c]] - data[i + c]))
    }
  })
}

/** Each selection's weight for every pixel, 0-1. */
export function selectionWeights(data: Uint8Array | Uint8ClampedArray, channels: 3 | 4, selections: Selection[]): Float32Array[] {
  const pixels = data.length / channels
  const weighers = selections.map(selectionWeigher)
  const weights = selections.map(() => new Float32Array(pixels))
  if (!selections.some((s) => s.samples.some((x) => !x.subtract))) return weights
  // Maps are mostly a few colours repeated; most pixels match one seen before.
  const seen = new Map<number, number>()
  for (let i = 0, j = 0; i < data.length; i += channels, j++) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
    let at = seen.get(key)
    if (at === undefined) {
      if (seen.size > 1 << 18) seen.clear()
      at = j
      seen.set(key, j)
      const [L, A, B] = oklab(data[i], data[i + 1], data[i + 2])
      for (let k = 0; k < weighers.length; k++) weights[k][j] = weighers[k](L, A, B)
    } else for (let k = 0; k < weighers.length; k++) weights[k][j] = weights[k][at]
  }
  return weights
}

/**
 * The part of the filter that looks at whole pixels rather than one value at a
 * time, in place: colour selections (picked by source colour), hue families,
 * then grey in the grey modes. `printTable` does the rest, on each channel.
 */
export function prepareColours(data: Uint8Array | Uint8ClampedArray, channels: 3 | 4, filter: Filter) {
  const weights = filter.selections.length ? selectionWeights(data, channels, filter.selections) : []
  shiftHues(data, channels, filter.hues)
  applySelections(data, channels, filter.selections, weights)
  if (!isGrey(filter)) return
  for (let i = 0; i < data.length; i += channels) data[i] = data[i + 1] = data[i + 2] = greyOf(data[i], data[i + 1], data[i + 2])
}

const changes = (s: Selection) => s.amount !== 0 || !isStraight(s.curve)

/** Whether `prepareColours` changes anything. */
export const needsPreparing = (filter: Filter) => isGrey(filter) || filter.hues.some((h) => h !== 0) || filter.selections.some(changes)

/** The whole filter on raw RGB pixels. Returns one channel in the grey modes, three otherwise. */
export function filterPixels(rgb: Uint8Array, filter: Filter): { data: Uint8Array; channels: 1 | 3 } {
  prepareColours(rgb, 3, filter)
  const table = printTable(filter)
  if (isGrey(filter)) {
    const grey = new Uint8Array(rgb.length / 3)
    for (let j = 0; j < grey.length; j++) grey[j] = table[rgb[j * 3]]
    return { data: grey, channels: 1 }
  }
  for (let i = 0; i < rgb.length; i++) rgb[i] = table[rgb[i]]
  return { data: rgb, channels: 3 }
}

/** True when the filter leaves every pixel as it is. */
export const isPlain = (filter: Filter) => filter.mode === 'color' && isStraight(filter.curve) &&
  filter.bands.every((b) => b.amount === 0) && !needsPreparing(filter)
