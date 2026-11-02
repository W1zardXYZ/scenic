import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanName, isWithin, joinPath, leafName, parentPath, rebasePath } from './tree.ts'

test('paths join, split and compare by whole folder names', () => {
  assert.equal(joinPath('', 'A'), 'A')
  assert.equal(joinPath('A', ''), 'A')
  assert.equal(joinPath('A', 'B'), 'A/B')
  assert.equal(parentPath('A/B/C'), 'A/B')
  assert.equal(parentPath('A'), '')
  assert.equal(leafName('A/B'), 'B')
  assert.equal(isWithin('A/B', 'A'), true)
  assert.equal(isWithin('AB', 'A'), false)
  assert.equal(isWithin('X', ''), true)
  assert.equal(cleanName(' Fire/Ice '), 'Fire-Ice')
})

test('rebasePath moves a folder and everything under it', () => {
  assert.equal(rebasePath('A/B/C', 'A/B', 'X'), 'X/C')
  assert.equal(rebasePath('A/B', 'A/B', 'X/Y'), 'X/Y')
  assert.equal(rebasePath('A/B', 'A/B', ''), '')
  assert.equal(rebasePath('A/B/C', 'A/B', 'A'), 'A/C')
  assert.equal(rebasePath('Keep', '', 'Top'), 'Top/Keep')
})
