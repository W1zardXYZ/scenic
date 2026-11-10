import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BAND_PRESETS, bandFunction, curveFunction, type Filter, filterPixels, isPlain, NEUTRAL_LEVELS, NEW_FILTER, printTable, shiftHues, toneCurve,
} from './tone.ts'

test('neutral levels change nothing', () => {
  assert.deepEqual([...toneCurve(NEUTRAL_LEVELS)], Array.from({ length: 256 }, (_, i) => i))
})

test('black and white points clip and stretch', () => {
  const curve = toneCurve({ black: 50, white: 200, gamma: 1 })
  assert.equal(curve[50], 0)
  assert.equal(curve[10], 0)
  assert.equal(curve[200], 255)
  assert.equal(curve[125], 128)
})

test('gamma above 1 lifts midtones and keeps the ends', () => {
  const curve = toneCurve({ black: 0, white: 255, gamma: 2 })
  assert.ok(curve[128] > 170)
  assert.equal(curve[0], 0)
  assert.equal(curve[255], 255)
})

const base: Filter = NEW_FILTER
const identity = Array.from({ length: 256 }, (_, i) => i)

test('a straight curve and no tweaks print every value as it is', () => {
  assert.deepEqual([...printTable(base)], identity)
  assert.ok(isPlain(base))
})

test('the curve passes through its points and never overshoots them', () => {
  const points: [number, number][] = [[0, 0], [40, 120], [60, 125], [255, 255]]
  const f = curveFunction(points)
  for (const [x, y] of points) assert.equal(f(x), y)
  let last = -1
  for (let x = 0; x <= 255; x += 0.5) {
    const y = f(x)
    assert.ok(y >= last, `falls back at ${x}`)
    if (x >= 40 && x <= 60) assert.ok(y >= 120 && y <= 125, `overshoots at ${x}: ${y}`)
    last = y
  }
})

test('the curve is flat beyond its end points', () => {
  const f = curveFunction([[20, 60], [200, 230]])
  assert.equal(f(0), 60)
  assert.equal(f(255), 230)
})

test('lightening the shadows lifts them together and leaves the rooms above alone', () => {
  const table = printTable({ ...base, bands: [{ ...BAND_PRESETS.shadows, amount: 1 }] })
  assert.equal(table[0], 64)
  assert.equal(table[64], 128)
  assert.equal(table[32], 96)
  for (let v = 128; v < 256; v++) assert.equal(table[v], v)
})

test('bands never swap the order of tones, however hard they push or overlap', () => {
  for (const amount of [-1, -0.4, 0.4, 1]) {
    const table = printTable({ ...base, bands: [{ from: 40, to: 90, soft: 20, amount }, { from: 0, to: 255, soft: 30, amount }, { ...BAND_PRESETS.highlights, amount }] })
    for (let v = 1; v < 256; v++) assert.ok(table[v] >= table[v - 1], `inverts at ${v} for ${amount}`)
  }
})

test('darkening a band pulls it down by its share of the edge', () => {
  const table = printTable({ ...base, bands: [{ ...BAND_PRESETS.midtones, amount: -0.5 }] })
  assert.equal(table[128], 104)
  assert.equal(table[40], 40)
  assert.equal(table[230], 230)
})

test('a band without an edge or an amount changes nothing', () => {
  const identity = Array.from({ length: 256 }, (_, i) => i)
  assert.deepEqual([...printTable({ ...base, bands: [{ from: 10, to: 90, soft: 0, amount: 1 }, { ...BAND_PRESETS.shadows, amount: 0 }] })], identity)
  assert.equal(bandFunction({ from: 100, to: 100, soft: 20, amount: 1 })(100), 120)
})

test('the saver washes the curve toward white, and B&W cuts after the curve', () => {
  assert.equal(printTable({ ...base, mode: 'light', amount: 0.5 })[0], 128)
  const bw = printTable({ ...base, mode: 'threshold', amount: 0.5, curve: [[0, 0], [64, 128], [255, 255]] })
  assert.equal(bw[63], 0)
  assert.equal(bw[64], 255)
})

test('levels only apply in the grey modes', () => {
  const levels = { black: 50, white: 200, gamma: 1 }
  assert.equal(printTable({ ...base, levels })[50], 50)
  assert.equal(printTable({ ...base, mode: 'grey', levels })[50], 0)
})

test('hue families lighten their own colours and leave greys alone', () => {
  const pixels = Uint8Array.from([40, 120, 40, 40, 40, 160, 90, 90, 90])
  shiftHues(pixels, 3, [0, 0, 0.5, 0, 0, 0])
  assert.deepEqual([...pixels.slice(0, 3)], [148, 188, 148])
  assert.deepEqual([...pixels.slice(3)], [40, 40, 160, 90, 90, 90])
})

test('neighbouring hue families blend halfway between them', () => {
  const yellowGreen = Uint8Array.from([128, 255, 0, 0])
  shiftHues(yellowGreen, 4, [0, 1, 0, 0, 0, 0])
  // Hue 1.5: half yellow, half green.
  assert.deepEqual([...yellowGreen], [192, 255, 128, 0])
})

test('the grey modes return one channel from the hue-shifted colour', () => {
  const { data, channels } = filterPixels(Uint8Array.from([0, 200, 0]), { ...base, mode: 'grey', hues: [0, 0, -1, 0, 0, 0] })
  assert.equal(channels, 1)
  assert.deepEqual([...data], [0])
  const colour = filterPixels(Uint8Array.from([10, 20, 30]), { ...base, curve: [[0, 255], [255, 255]] })
  assert.deepEqual([...colour.data], [255, 255, 255])
})
