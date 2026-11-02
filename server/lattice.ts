// Finds repeating 2D structure with an autocorrelation of the image's fine lines.
// Hex grids have no straight full-span lines for grid.ts to find, and regular
// floor tiles reveal a map's scale even when no grid is drawn.
// Map detail can mimic a hex lattice, so callers must only trust `hex` on files
// already known to carry a grid.

export interface Lattice {
  hex: { size: number; pointy: boolean; score: number } | null
  tile: { period: number; score: number } | null
}

const MAX_SIDE = 1024
const LINE_CLIP = 48
const MIN_RADIUS = 24
const MAX_RADIUS = 320
const HEX_MARGIN = 0.01
const HEX_MIN_POINTS = 12
const TILE_STRENGTH = 0.2
const MIN_TILE = 40

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const [wr, wi] = [Math.cos(angle), Math.sin(angle)]
    for (let i = 0; i < n; i += len) {
      let [cr, ci] = [1, 0]
      for (let k = 0; k < len / 2; k++) {
        const [u, v] = [i + k, i + k + len / 2]
        const tr = re[v] * cr - im[v] * ci
        const ti = re[v] * ci + im[v] * cr
        re[v] = re[u] - tr
        im[v] = im[u] - ti
        re[u] += tr
        im[u] += ti
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, n: number): void {
  const [r, i] = [new Float64Array(n), new Float64Array(n)]
  for (let y = 0; y < n; y++) {
    r.set(re.subarray(y * n, y * n + n))
    i.set(im.subarray(y * n, y * n + n))
    fft(r, i)
    re.set(r, y * n)
    im.set(i, y * n)
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      r[y] = re[y * n + x]
      i[y] = im[y * n + x]
    }
    fft(r, i)
    for (let y = 0; y < n; y++) {
      re[y * n + x] = r[y]
      im[y * n + x] = i[y]
    }
  }
}

function autocorrelation(px: Uint8Array, w: number, h: number, n: number) {
  const left = (w - n) >> 1
  const top = (h - n) >> 1
  const re = new Float64Array(n * n)
  const im = new Float64Array(n * n)
  let mean = 0
  for (let y = 1; y < n - 1; y++) {
    for (let x = 1; x < n - 1; x++) {
      const p = (y + top) * w + x + left
      const c = px[p]
      const line = Math.max(Math.abs(2 * c - px[p - 1] - px[p + 1]), Math.abs(2 * c - px[p - w] - px[p + w]))
      re[y * n + x] = Math.min(line, LINE_CLIP)
      mean += re[y * n + x]
    }
  }
  mean /= re.length
  for (let i = 0; i < re.length; i++) re[i] -= mean
  fft2(re, im, n)
  for (let i = 0; i < re.length; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i]
    im[i] = 0
  }
  fft2(re, im, n)
  const zero = re[0]
  return (x: number, y: number) => re[(((y % n) + n) % n) * n + ((x % n) + n) % n] / zero
}

/** Compares a whole hex lattice of offsets against the same lattice turned 15°, where nothing should line up. */
function findHex(at: (x: number, y: number) => number, limit: number): Lattice['hex'] {
  const radial = new Float64Array(limit + 2)
  const counts = new Float64Array(limit + 2)
  for (let y = 0; y <= limit; y += 2) {
    for (let x = -limit; x <= limit; x += 2) {
      const r = Math.round(Math.hypot(x, y))
      if (r <= limit) {
        radial[r] += at(x, y)
        counts[r]++
      }
    }
  }
  for (let r = 0; r <= limit; r++) radial[r] /= counts[r] || 1
  const residual = (x: number, y: number) => {
    const r = Math.round(Math.hypot(x, y))
    let best = -Infinity
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) best = Math.max(best, at(Math.round(x) + dx, Math.round(y) + dy))
    }
    return best - radial[r]
  }
  const combAverage = (size: number, degrees: number) => {
    const a = (degrees * Math.PI) / 180
    const b = a + Math.PI / 3
    const [ax, ay, bx, by] = [size * Math.cos(a), size * Math.sin(a), size * Math.cos(b), size * Math.sin(b)]
    let sum = 0
    let count = 0
    for (let i = -8; i <= 8; i++) {
      for (let j = -8; j <= 8; j++) {
        const [x, y] = [i * ax + j * bx, i * ay + j * by]
        const r = Math.hypot(x, y)
        if (r < size / 2 || r > limit || y < 0) continue
        sum += residual(x, y)
        count++
      }
    }
    return count >= HEX_MIN_POINTS ? sum / count : -Infinity
  }
  let found: Lattice['hex'] = null
  for (let size = MIN_RADIUS; size <= limit / 2; size += 0.25) {
    for (const base of [0, 30]) {
      const score = combAverage(size, base) - combAverage(size, base + 15)
      if (Number.isFinite(score) && score >= HEX_MARGIN && (!found || score > found.score)) found = { size, pointy: base === 0, score }
    }
  }
  return found
}

function findTile(at: (x: number, y: number) => number, limit: number): Lattice['tile'] {
  const peak = (x: number, y: number) => {
    const v = at(x, y)
    for (let d = -3; d <= 3; d++) {
      if (!d) continue
      if ((x ? at(x + d, y) : at(x, y + d)) > v) return 0
    }
    return v
  }
  for (let p = MIN_TILE; p <= limit; p++) {
    for (const q of [p, p + 1]) {
      const score = Math.min(peak(p, 0), peak(0, q))
      if (score >= TILE_STRENGTH) return { period: (p + q) / 2, score }
    }
  }
  return null
}

/** `px` is an 8-bit greyscale image. */
export function findLattice(px: Uint8Array, w: number, h: number): Lattice {
  const n = 2 ** Math.floor(Math.log2(Math.min(w, h, MAX_SIDE)))
  if (n < 256) return { hex: null, tile: null }
  const at = autocorrelation(px, w, h, n)
  const limit = Math.min(MAX_RADIUS, n / 3)
  return { hex: findHex(at, limit), tile: findTile(at, limit) }
}
