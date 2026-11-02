import test from 'node:test'
import assert from 'node:assert/strict'
import { detectGrid, isConfident, type AxisGrid } from './grid.ts'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

interface Options {
  w?: number
  h?: number
  seed?: number
  /** Mean grey level of the base texture. */
  base?: number
  /** Per-pixel noise amplitude (peak-to-peak). */
  noise?: number
  /** Blocky "painted" texture amplitude, on top of the noise. */
  blobs?: number
  /** Grid period in pixels (may be fractional); omit for no grid. */
  period?: number
  phaseX?: number
  phaseY?: number
  thickness?: number
  /** Grey level of the line pixels. */
  line?: number
}

function synth(o: Options): { px: Uint8Array; w: number; h: number } {
  const w = o.w ?? 1500
  const h = o.h ?? 1200
  const r = rng(o.seed ?? 1)
  const base = o.base ?? 128
  const noise = o.noise ?? 60
  const blobs = o.blobs ?? 50
  const px = new Uint8Array(w * h)
  // Coarse blobs (12px cells) look like terrain; per-pixel noise like grain.
  const cell = 12
  const cw = Math.ceil(w / cell)
  const grid = Array.from({ length: cw * Math.ceil(h / cell) }, () => (r() - 0.5) * blobs)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = base + grid[Math.floor(y / cell) * cw + Math.floor(x / cell)] + (r() - 0.5) * noise
      px[y * w + x] = Math.max(0, Math.min(255, Math.round(v)))
    }
  }
  if (o.period) {
    const t = o.thickness ?? 1
    const line = o.line ?? 0
    const [px0, py0] = [o.phaseX ?? 17, o.phaseY ?? 29]
    const mark = (pos: number, vertical: boolean) => {
      const start = Math.round(pos - (t - 1) / 2)
      for (let k = 0; k < t; k++) {
        const c = start + k
        if (vertical) {
          if (c < 0 || c >= w) continue
          for (let y = 0; y < h; y++) px[y * w + c] = line
        } else {
          if (c < 0 || c >= h) continue
          for (let x = 0; x < w; x++) px[c * w + x] = line
        }
      }
    }
    for (let p = px0; p < w; p += o.period) mark(p, true)
    for (let p = py0; p < h; p += o.period) mark(p, false)
  }
  return { px, w, h }
}

const detect = (o: Options) => {
  const { px, w, h } = synth(o)
  return detectGrid(px, w, h)
}

function expectGrid(result: ReturnType<typeof detectGrid>, period: number, phaseX: number, phaseY: number, minScore = 0.5, tol = 0.05) {
  assert.ok(result, 'grid detected')
  for (const [axis, phase] of [[result.x, phaseX], [result.y, phaseY]] as [AxisGrid, number][]) {
    assert.ok(Math.abs(axis.period - period) <= tol, `period ${axis.period} vs ${period}`)
    assert.ok(axis.score > minScore, `score ${axis.score}`)
    // Phase is modulo the period; compare circularly, allowing a pixel for line placement.
    const d = Math.abs(((axis.phase - (phase % period)) % period + period) % period)
    assert.ok(Math.min(d, period - d) <= 1.1, `phase ${axis.phase} vs ${phase % period}`)
  }
}

const confident = (r: ReturnType<typeof detectGrid>) => !!r && Math.min(r.x.score, r.y.score) >= 0.3

test('pure noise has no confident grid', () => {
  for (const seed of [1, 2, 3]) {
    const r = detect({ seed, blobs: 0, noise: 120 })
    assert.ok(!confident(r), `seed ${seed}: ${JSON.stringify(r)}`)
  }
})

test('texture without lines has no confident grid', () => {
  for (const seed of [4, 5, 6]) {
    const r = detect({ seed, blobs: 120, noise: 40 })
    assert.ok(!confident(r), `seed ${seed}: ${JSON.stringify(r)}`)
  }
})

test('flat image has no grid', () => {
  const px = new Uint8Array(800 * 600).fill(100)
  assert.ok(!confident(detectGrid(px, 800, 600)))
})

test('images too small for the period range return null', () => {
  const px = new Uint8Array(60 * 60).fill(100)
  assert.equal(detectGrid(px, 60, 60), null)
})

test('black 1px grid, period 101, on textured noise', () => {
  const r = detect({ period: 101, phaseX: 23, phaseY: 41 })
  expectGrid(r, 101, 23, 41)
})

test('integer period with a different phase and seed', () => {
  expectGrid(detect({ period: 70, phaseX: 5, phaseY: 60, seed: 9 }), 70, 5, 60)
})

test('fractional period 70.5', () => {
  expectGrid(detect({ period: 70.5, phaseX: 11, phaseY: 33, w: 1800, h: 1400, seed: 2 }), 70.5, 11, 33)
})

test('fractional period 140.25', () => {
  expectGrid(detect({ period: 140.25, phaseX: 30, phaseY: 50, w: 2400, h: 1800, seed: 3 }), 140.25, 30, 50)
})

test('faint grid: about 12 grey levels of contrast', () => {
  expectGrid(detect({ period: 101, line: 128 - 12, blobs: 30, noise: 30, seed: 7 }), 101, 17, 29)
})

test('light (white) grid on a dark map', () => {
  expectGrid(detect({ period: 101, base: 60, line: 200, seed: 8, phaseX: 40, phaseY: 12 }), 101, 40, 12)
  expectGrid(detect({ period: 101, base: 128, line: 255, seed: 3, phaseX: 40, phaseY: 12 }), 101, 40, 12)
})

// KNOWN WEAKNESS (server/grid.ts is not to be changed here): with near-full-contrast
// lines (about 200 grey levels) the ridge filter clips (CLIP = 40) and the line and its
// two side lobes at +-RIDGE_RADIUS tie exactly, so the peak lands up to 3px early and the
// fitted period drifts by 0.05-0.15.
//   white 255 on base 50, seed 8: x period 101.054, phase 37.0 (expected 101 / 40)
//   black 0 on base 200, seed 1:  y period 100.843, phase 14.8 (expected 101 / 17)
test('full-contrast white grid on near-black map keeps phase and period', () => {
  expectGrid(detect({ period: 101, base: 50, line: 255, seed: 8, phaseX: 40, phaseY: 12 }), 101, 40, 12)
})

test('full-contrast black grid on a light map keeps phase and period', () => {
  expectGrid(detect({ period: 101, base: 200, line: 0, seed: 1 }), 101, 17, 29)
})

test('3px thick line', () => {
  expectGrid(detect({ period: 101, thickness: 3, seed: 10, phaseX: 22, phaseY: 66 }), 101, 22, 66)
})

test('non-square image with independent axes', () => {
  expectGrid(detect({ period: 90, w: 2000, h: 900, seed: 11 }), 90, 17, 29)
})

test('isConfident: agreement across axes offsets one weak axis, but never disagreement', () => {
  const axis = (period: number, score: number) => ({ period, phase: 0, score })
  assert.equal(isConfident({ x: axis(50.49, 0.18), y: axis(50.5, 1) }), true)
  assert.equal(isConfident({ x: axis(28, 0.08), y: axis(30, 0.07) }), false)
  assert.equal(isConfident({ x: axis(43, 0.9), y: axis(30, 0.9) }), false)
  assert.equal(isConfident({ x: axis(30, 0.05), y: axis(30, 0.08) }), false)
})
