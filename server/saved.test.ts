import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { NEW_LOOK, type Look } from '../shared/look.ts'
import { NEW_FILTER } from '../shared/tone.ts'

process.env.SCENIC_DATA = mkdtempSync(join(tmpdir(), 'scenic-saved-'))
const saved = await import('./saved.ts')

const settings = (extra = {}) => ({ filter: NEW_FILTER, squareMm: 25.4, ...extra })

test('working settings and named copies are kept apart, newest copy first', () => {
  assert.deepEqual(saved.readPrintState('1:a.jpg'), { working: null, saves: [] })
  saved.writePrintState('1:a.jpg', '', settings({ step: 1 }))
  saved.writePrintState('1:a.jpg', '', settings({ step: 2 }))
  saved.writePrintState('1:a.jpg', 'Table', settings({ step: 3 }))
  const state = saved.readPrintState('1:a.jpg')
  assert.equal((state.working as { step: number }).step, 2)
  assert.deepEqual(state.saves.map((s) => s.name), ['Table'])
  assert.equal(saved.readPrintState('2:b.jpg').working, null, 'another map has its own')
})

test('saving under a name already used replaces that copy; deleting never touches the working settings', () => {
  saved.writePrintState('3:c.jpg', '', settings())
  saved.writePrintState('3:c.jpg', 'A', settings({ step: 1 }))
  saved.writePrintState('3:c.jpg', 'A', settings({ step: 2 }))
  assert.equal(saved.readPrintState('3:c.jpg').saves.length, 1)
  assert.equal((saved.readPrintState('3:c.jpg').saves[0].settings as { step: number }).step, 2)
  saved.deletePrintCopy('3:c.jpg', '')
  assert.ok(saved.readPrintState('3:c.jpg').working)
  saved.deletePrintCopy('3:c.jpg', 'A')
  assert.deepEqual(saved.readPrintState('3:c.jpg').saves, [])
})

test('a map has a limited number of copies, but replacing one is always allowed', () => {
  for (let i = 0; i < saved.MAX_SAVES; i++) assert.ok(saved.writePrintState('4:d.jpg', `Copy ${i}`, settings()))
  assert.equal(saved.writePrintState('4:d.jpg', 'One too many', settings()), false)
  assert.ok(saved.writePrintState('4:d.jpg', 'Copy 0', settings({ step: 9 })))
})

test('saved settings follow a renamed file', () => {
  saved.writePrintState('5:old.jpg', '', settings({ step: 1 }))
  saved.writePrintState('5:old.jpg', 'Kept', settings())
  saved.movePrintState('5:old.jpg', '5:new.jpg')
  assert.equal(saved.readPrintState('5:old.jpg').working, null)
  assert.equal(saved.readPrintState('5:new.jpg').saves.length, 1)
})

test('settings from the browser must be an object with a usable filter', () => {
  assert.equal(saved.invalidSettings(settings()), null)
  assert.equal(saved.invalidSettings(null), 'settings')
  assert.equal(saved.invalidSettings([]), 'settings')
  assert.equal(saved.invalidSettings({}), 'filter')
  assert.equal(saved.invalidSettings(settings({ filter: { ...NEW_FILTER, mode: 'sepia' } })), 'filter')
  assert.equal(saved.invalidSettings(settings({ pad: 'x'.repeat(1_000_001) })), 'settings size')
})

const grey: Look = { filter: { ...NEW_FILTER, mode: 'grey', levels: { black: 20, white: 230, gamma: 1.2 } }, fadeMm: 10 }

test('looks keep their values, and names are unique whatever the case', () => {
  const made = saved.createLook('  Table   print ', grey)
  assert.ok('id' in made)
  assert.deepEqual(saved.readLooks().looks.map((l) => [l.name, l.look]), [['Table print', grey]])
  assert.deepEqual(saved.createLook('table PRINT', NEW_LOOK), { error: 'There is already a look called “table PRINT”', status: 409 })
  assert.equal((saved.createLook('', grey) as { status: number }).status, 400)
  assert.equal((saved.createLook('Bad', { ...grey, fadeMm: -1 }) as { status: number }).status, 400)
  assert.equal((saved.createLook('Bad', { ...grey, filter: { ...grey.filter, levels: { black: 200, white: 100, gamma: 1 } } }) as { status: number }).status, 400)
})

test('a look can be renamed, overwritten and made the default; deleting the default clears it', () => {
  const { id } = saved.createLook('Dark maps', NEW_LOOK) as { id: number }
  const other = saved.createLook('Light maps', NEW_LOOK) as { id: number }
  assert.equal((saved.updateLook(id, { name: 'Light maps' }) as { status: number }).status, 409)
  saved.updateLook(id, { name: 'Dungeons', look: grey, isDefault: true })
  const after = saved.readLooks()
  assert.equal(after.defaultId, id)
  assert.deepEqual(after.looks.find((l) => l.id === id), { id, name: 'Dungeons', look: grey })
  saved.updateLook(other.id, { isDefault: false })
  assert.equal(saved.readLooks().defaultId, id, 'clearing another look leaves the default alone')
  saved.deleteLook(id)
  assert.equal(saved.readLooks().defaultId, null)
  assert.equal((saved.updateLook(id, { name: 'Gone' }) as { status: number }).status, 404)
})
