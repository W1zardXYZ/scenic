import assert from 'node:assert/strict'
import test from 'node:test'
import { splitVariant } from './levels.ts'

test('a variant splits into where it is and how it looks', () => {
  assert.deepEqual(splitVariant('Night Exterior'), { floor: 'Exterior', look: 'Night', height: 4 })
  assert.deepEqual(splitVariant('Floor 2 Rain'), { floor: 'Floor 2', look: 'Rain', height: 2 })
  assert.deepEqual(splitVariant('Day'), { floor: '', look: 'Day', height: null })
})
