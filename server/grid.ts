export interface AxisGrid { period: number; phase: number; score: number }
export interface GridDetection { x: AxisGrid; y: AxisGrid }

const MIN_PERIOD = 24
const MAX_PERIOD = 600
const MIN_NOISE = 0.05
const PEAK_OVER_NOISE = 4
const RIDGE_RADIUS = 3
const SCANLINES = 400
const CLIP = 140

/**
 * Printed gridlines are thin lines spanning the whole image, so a signed ridge
 * filter averaged along the line keeps them and cancels map detail. The averaged
 * profile is then a comb whose spacing is the grid period.
 */
function ridgeProfile(px: Uint8Array, w: number, h: number, horizontal: boolean): Float64Array {
  const len = horizontal ? h : w
  const across = horizontal ? w : h
  const stride = horizontal ? w : 1
  const lineStep = horizontal ? 1 : w
  const out = new Float64Array(len)
  const step = Math.max(1, Math.floor(across / SCANLINES))
  let lines = 0
  for (let a = 0; a < across; a += step) {
    const base = a * lineStep
    for (let i = RIDGE_RADIUS; i < len - RIDGE_RADIUS; i++) {
      const p = base + i * stride
      const d = px[p] - (px[p - RIDGE_RADIUS * stride] + px[p + RIDGE_RADIUS * stride]) / 2
      out[i] += d > CLIP ? CLIP : d < -CLIP ? -CLIP : d
    }
    lines++
  }
  for (let i = 0; i < len; i++) out[i] = Math.abs(out[i] / lines)
  return out
}

function detectAxis(profile: Float64Array): AxisGrid | null {
  const n = profile.length
  const maxLag = Math.min(MAX_PERIOD, Math.floor(n / 4))
  if (maxLag <= MIN_PERIOD) return null

  const sorted = Float64Array.from(profile).sort()
  const noise = Math.max(sorted[n >> 1], MIN_NOISE)

  // Keep only local maxima well above the noise floor: the ridge filter's side
  // lobes would otherwise show up as false teeth RIDGE_RADIUS away from each line.
  const s = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = profile[i]
    if (v < noise * PEAK_OVER_NOISE) continue
    let isMax = true
    for (let j = Math.max(0, i - RIDGE_RADIUS - 1); j <= Math.min(n - 1, i + RIDGE_RADIUS + 1); j++) {
      if (profile[j] > v || (profile[j] === v && j < i)) { isMax = false; break }
    }
    if (isMax) s[i] = v
  }

  const peaks: number[] = []
  for (let i = 0; i < n; i++) if (s[i] > 0) peaks.push(i)
  if (peaks.length < 4) return null

  // Vote on the spacing between peaks (allowing a pixel of rounding either side);
  // the most popular short spacing is the fundamental.
  const votes = new Float64Array(maxLag + 2)
  for (let a = 0; a < peaks.length; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const lag = peaks[b] - peaks[a]
      if (lag > maxLag) break
      const weight = Math.min(s[peaks[a]], s[peaks[b]])
      votes[lag] += weight
      votes[lag + 1] += weight / 2
      votes[lag - 1] += weight / 2
    }
  }
  let best = 0
  for (let lag = MIN_PERIOD; lag <= maxLag; lag++) best = Math.max(best, votes[lag])
  if (best <= 0) return null
  let lag = 0
  for (let l = MIN_PERIOD; l <= maxLag; l++) {
    if (votes[l] >= best * 0.6 && votes[l] >= votes[l - 1] && votes[l] >= votes[l + 1]) { lag = l; break }
  }
  if (!lag) return null

  let phase = 0
  let phaseScore = -1
  for (let p = 0; p < lag; p++) {
    let sum = 0
    for (let i = p; i < n; i += lag) sum += s[Math.min(n - 1, i)] + s[Math.min(n - 1, i + 1)] + s[Math.max(0, i - 1)]
    if (sum > phaseScore) { phaseScore = sum; phase = p }
  }

  // Least-squares fit through the comb teeth gives sub-pixel period and phase.
  const window = Math.max(2, Math.round(lag * 0.04))
  let period = lag
  let hits = 0
  let teeth = 0
  for (let pass = 0; pass < 3; pass++) {
    let sk = 0, sx = 0, skk = 0, skx = 0
    hits = 0
    teeth = 0
    for (let k = -Math.floor(phase / period); ; k++) {
      const expected = phase + k * period
      if (expected >= n - RIDGE_RADIUS) break
      teeth++
      let peak = 0, at = -1
      for (let i = Math.max(0, Math.round(expected) - window); i <= Math.min(n - 1, Math.round(expected) + window); i++) {
        if (s[i] > peak) { peak = s[i]; at = i }
      }
      if (at < 0) continue
      sk += k; sx += at; skk += k * k; skx += k * at; hits++
    }
    const det = hits * skk - sk * sk
    if (hits < 3 || det === 0) return null
    period = (hits * skx - sk * sx) / det
    phase = (sx - period * sk) / hits
  }
  phase = ((phase % period) + period) % period

  // A real grid fills the comb and accounts for nearly all surviving peaks.
  const onComb = hits / peaks.length
  return { period, phase, score: (hits / teeth) * Math.min(1, onComb * 1.5) }
}

/** `px` is an 8-bit greyscale image. Returns null when no regular grid is present. */
export function detectGrid(px: Uint8Array, w: number, h: number): GridDetection | null {
  const x = detectAxis(ridgeProfile(px, w, h, false))
  const y = detectAxis(ridgeProfile(px, w, h, true))
  return x && y ? { x, y } : null
}

/** Unrelated map detail never produces the same spacing on both axes, so agreement offsets a weak axis. */
export function isConfident({ x, y }: GridDetection): boolean {
  if (Math.abs(x.period / y.period - 1) >= 0.01) return false
  const weak = Math.min(x.score, y.score)
  return weak >= 0.3 || (weak >= 0.12 && Math.max(x.score, y.score) >= 0.5)
}
