import assert from 'node:assert/strict'
import test from 'node:test'
import { NEUTRAL_LEVELS, toneCurve } from './tone.ts'

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
