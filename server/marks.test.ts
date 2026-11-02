import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.SCENIC_DATA = mkdtempSync(join(tmpdir(), 'scenic-marks-'))
const { db, getFile, hideScene, readLibrary, writeEdit } = await import('./db.ts')
const { regroup } = await import('./scan.ts')

const SIG = new Uint8Array(1024).map((_, i) => (i * 37) % 251)

db.exec(`INSERT INTO root (id, path) VALUES (1, '/maps')`)
const lookOf = (seed: number) => {
  const bytes = SIG.map((v, i) => (v * (seed + 3) + i * seed) % 251)
  return new Uint8Array(bytes.map((v) => v - 125 & 255))
}
function addFile(id: number, name: string, path: string, rootId = 1, seed = id, bytes = 1000) {
  const sig = lookOf(seed)
  db.prepare(`INSERT INTO file (id, root_id, path, kind, bytes, mtime, rel, name, status, format, width, height, ink, color, colors, sig)
    VALUES (?, ?, ?, 'image', ?, 1, ?, ?, 'ok', 'jpg', 3000, 2000, 0.5, '#333333', '[]', ?)`).run(id, rootId, path, bytes, path.slice(1), name, sig)
}
const map = (name: string) => readLibrary().maps.find((m) => m.name === name)!

addFile(1, 'Keep', '/maps/Quest/Keep.jpg')
addFile(2, 'Ruins', '/maps/Quest/Ruins.jpg')
regroup()

test('a hidden, favourite map stays that way after its file moves', () => {
  hideScene(map('Keep').groupId, true)
  writeEdit(getFile(1)!, { favorite: true })
  db.exec('DELETE FROM file WHERE id = 1')
  addFile(3, 'Keep', '/maps/Elsewhere/Keep.jpg', 1, 1)
  regroup()
  assert.equal(map('Keep').id, 3)
  assert.equal(map('Keep').hidden, true)
  assert.equal(map('Keep').favorite, true)
  assert.equal(map('Ruins').hidden, false)
})

test('a hidden map stays hidden when its folder is removed and added back', () => {
  db.exec(`DELETE FROM root WHERE id = 1`)
  regroup()
  assert.equal(readLibrary().maps.length, 0)
  db.exec(`INSERT INTO root (id, path) VALUES (2, '/maps')`)
  addFile(4, 'Keep', '/maps/Quest/Keep.jpg', 2, 1)
  addFile(5, 'Ruins', '/maps/Quest/Ruins.jpg', 2, 2)
  regroup()
  assert.equal(map('Keep').hidden, true)
})

test('marks do not count as corrections', () => {
  assert.equal(map('Keep').edited, false)
})

test('a hidden map stays hidden when it is renamed and resized', () => {
  db.exec('DELETE FROM file WHERE id = 4')
  addFile(6, 'Old Keep v2', '/maps/Quest/Old Keep v2.jpg', 2, 1, 1234)
  regroup()
  assert.equal(map('Old Keep v2').hidden, true)
  assert.equal(map('Old Keep v2').favorite, true)
})

test('a file that only looks different does not inherit a mark', () => {
  db.exec('DELETE FROM file WHERE id = 6')
  addFile(7, 'Tower', '/maps/Quest/Tower.jpg', 2, 7, 777)
  regroup()
  assert.equal(map('Tower').hidden, false)
  db.exec('DELETE FROM file WHERE id = 7')
  addFile(8, 'Keep', '/maps/Quest/Keep.jpg', 2, 1)
  regroup()
})

test('a new variant of a hidden scene is hidden with it', () => {
  addFile(9, 'Keep Night', '/maps/Quest/Keep Night.jpg', 2, 9)
  db.exec(`INSERT INTO edit (key, data) VALUES ('1000:Keep Night', '{"scene":"Keep"}')`)
  db.prepare(`INSERT OR REPLACE INTO edit (key, data, sig) SELECT '1000:Keep', json_set(data, '$.scene', 'Keep'), sig FROM edit WHERE key = '1000:Keep'`).run()
  regroup()
  assert.equal(map('Keep').groupId, map('Keep Night').groupId)
  assert.equal(map('Keep Night').hidden, true)
})

test('showing a map again clears the mark', () => {
  hideScene(map('Keep').groupId, false)
  assert.equal(map('Keep').hidden, false)
  assert.equal(map('Keep').favorite, true)
})
