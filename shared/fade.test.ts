import test from 'node:test'
import assert from 'node:assert/strict'
import { fadeAt, fadeMask, fadeRegion } from './fade.ts'

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)
const region = { x: 25.4, y: 25.4, w: 711.2, h: 457.2 }

test('fades the crop, clipped to the map, or else the whole map', () => {
  assert.deepEqual(fadeRegion(762, 508), { x: 0, y: 0, w: 762, h: 508 })
  assert.deepEqual(fadeRegion(762, 508, region), region)
  assert.deepEqual(fadeRegion(762, 508, { x: 700, y: -10, w: 100, h: 50 }), { x: 700, y: 0, w: 62, h: 40 })
  assert.equal(fadeRegion(762, 508, { x: 800, y: 0, w: 10, h: 10 }), null)
})

test('white at the edge, clear past the band, nothing when off', () => {
  near(fadeAt(region, 30, region.x, 200), 1)
  near(fadeAt(region, 30, region.x - 5, 200), 1)
  near(fadeAt(region, 30, region.x + 30, 200), 0)
  near(fadeAt(region, 30, 400, 250), 0)
  near(fadeAt(region, 0, region.x, 200), 0)
})

test('the ramp eases in and out and is symmetric around its middle', () => {
  const at = (d: number) => fadeAt(region, 30, region.x + d, 250)
  near(at(15), 0.5)
  near(at(10) + at(20), 1)
  // Smooth ends: the first and last millimetre move far less than a linear ramp's 1/30.
  assert.ok(at(29) < 0.01 && 1 - at(1) < 0.01)
  for (let d = 0; d < 30; d++) assert.ok(at(d) >= at(d + 1))
})

test('every edge fades alike', () => {
  const right = region.x + region.w
  const bottom = region.y + region.h
  near(fadeAt(region, 30, region.x + 7, 250), fadeAt(region, 30, right - 7, 250))
  near(fadeAt(region, 30, 300, region.y + 7), fadeAt(region, 30, 300, bottom - 7))
})

test('corners round off instead of creasing along the diagonal', () => {
  const { x, y } = region
  // On a crease, a point 10 mm in from both edges would be as white as one 10 mm from a single edge.
  const edge = fadeAt(region, 30, x + 10, 250)
  const corner = fadeAt(region, 30, x + 10, y + 10)
  assert.ok(corner > edge + 0.1)
  // Points at the same distance from the inner corner are equally white, whatever their direction.
  const inner = { x: x + 30, y: y + 30 }
  const a = fadeAt(region, 30, inner.x - 12, inner.y)
  const b = fadeAt(region, 30, inner.x - 12 / Math.SQRT2, inner.y - 12 / Math.SQRT2)
  near(a, b)
})

test('a region narrower than two bands still reaches clear in its middle', () => {
  const thin = { x: 0, y: 0, w: 40, h: 500 }
  near(fadeAt(thin, 30, 20, 250), 0)
  near(fadeAt(thin, 30, 0, 250), 1)
})

test('the mask samples fadeAt at pixel centres', () => {
  const view = { x: 0, y: 0, w: 100, h: 60 }
  const mask = fadeMask(region, 30, view, 50, 30)!
  for (const [i, j] of [[0, 0], [12, 3], [20, 25], [49, 29], [13, 13]]) {
    const expected = fadeAt(region, 30, view.x + (i + 0.5) * 2, view.y + (j + 0.5) * 2)
    assert.equal(mask[j * 50 + i], Math.round(expected * 255))
  }
})

test('no mask when nothing in view is veiled', () => {
  assert.equal(fadeMask(region, 30, { x: 200, y: 200, w: 100, h: 100 }, 10, 10), null)
  assert.equal(fadeMask(region, 0, { x: 0, y: 0, w: 100, h: 100 }, 10, 10), null)
  assert.ok(fadeMask(region, 30, { x: 0, y: 0, w: 10, h: 10 }, 10, 10)!.every((a) => a === 255))
})
