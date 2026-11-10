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
}

export const NEUTRAL_LEVELS: Levels = { black: 0, white: 255, gamma: 1 }
export const STRAIGHT: [number, number][] = [[0, 0], [255, 255]]
export const HUES = ['Reds', 'Yellows', 'Greens', 'Cyans', 'Blues', 'Magentas'] as const
export const NO_HUES = HUES.map(() => 0)
export const MAX_CURVE_POINTS = 16
export const MAX_BANDS = 8

export const NEW_FILTER: Filter = { mode: 'color', amount: 0.3, levels: NEUTRAL_LEVELS, curve: STRAIGHT, bands: [], hues: NO_HUES }

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

/**
 * The part of the filter that looks at whole pixels rather than one value at a
 * time, in place: hue families, then grey in the grey modes. `printTable` does
 * the rest, on each channel.
 */
export function prepareColours(data: Uint8Array | Uint8ClampedArray, channels: 3 | 4, filter: Filter) {
  shiftHues(data, channels, filter.hues)
  if (!isGrey(filter)) return
  for (let i = 0; i < data.length; i += channels) data[i] = data[i + 1] = data[i + 2] = greyOf(data[i], data[i + 1], data[i + 2])
}

/** Whether `prepareColours` changes anything. */
export const needsPreparing = (filter: Filter) => isGrey(filter) || filter.hues.some((h) => h !== 0)

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
  filter.bands.every((b) => b.amount === 0) && filter.hues.every((h) => h === 0)
