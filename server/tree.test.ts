import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

process.env.SCENIC_DATA = mkdtempSync(join(tmpdir(), 'scenic-tree-'))
const { db, readLibrary, readProfiles, writeProfile } = await import('./db.ts')
const { dissolveNode, flattenSingles, moveInto, moveNode } = await import('./scan.ts')
const { projectKey } = await import('../shared/types.ts')

const SIG = new Uint8Array(1024).map((_, i) => (i * 37) % 251)

db.exec(`INSERT INTO root (id, path) VALUES (1, '/maps')`)
function addScene(id: number, name: string, rel: string) {
  // Different random-looking signatures keep unrelated scenes apart.
  const sig = SIG.map((v, i) => (v * (id + 3) + i * id) % 251)
  db.prepare(`INSERT INTO file (id, root_id, path, kind, bytes, mtime, rel, name, status, format, width, height, ink, color, colors, sig)
    VALUES (?, 1, ?, 'image', ?, 1, ?, ?, 'ok', 'jpg', 3000, 2000, 0.5, '#333333', '[]', ?)`).run(id, `/maps/${rel}`, 1000 + id, rel, name, sig)
}
addScene(1, 'Keep', 'maps/Quest/Hunt/Keep.jpg')
addScene(2, 'Ruins', 'maps/Quest/Hunt/Ruins.jpg')
addScene(3, 'Church', 'maps/Quest/Spirits/Church.jpg')
addScene(4, 'Ranch', 'maps/Quest/Lone/Ranch.jpg')
const { regroup } = await import('./scan.ts')
regroup()

const place = (id: number) => {
  const l = readLibrary()
  const map = l.maps.find((m) => m.id === id)!
  return `${map.creator}|${map.pack}`
}

test('nesting moves a project with its profile', () => {
  writeProfile('project', projectKey('Quest', 'Hunt'), { color: '#112233' })
  moveInto([{ creator: 'Quest', path: 'Hunt' }], [], { creator: 'Quest', path: 'Lone' })
  assert.equal(place(1), 'Quest|Lone/Hunt')
  assert.ok(readProfiles('project')[projectKey('Quest', 'Lone/Hunt')])
  assert.equal(readProfiles('project')[projectKey('Quest', 'Hunt')], undefined)
})

test('renaming a parent carries nested projects along', () => {
  moveNode({ creator: 'Quest', path: 'Lone' }, { creator: 'Quest', path: 'Dragon' })
  assert.equal(place(1), 'Quest|Dragon/Hunt')
  assert.equal(place(4), 'Quest|Dragon')
  assert.ok(readProfiles('project')[projectKey('Quest', 'Dragon/Hunt')])
})

test('dissolving a project moves its contents up a level', () => {
  dissolveNode({ creator: 'Quest', path: 'Dragon/Hunt' })
  assert.equal(place(1), 'Quest|Dragon')
  assert.equal(readProfiles('project')[projectKey('Quest', 'Dragon/Hunt')], undefined)
})

test('flatten only removes projects holding a single scene', () => {
  assert.equal(flattenSingles({ creator: 'Quest', path: '' }), 1)
  assert.equal(place(3), 'Quest|')
  assert.equal(place(1), 'Quest|Dragon')
})

test('a project becomes a creator and back', () => {
  moveNode({ creator: 'Quest', path: 'Dragon' }, { creator: 'Dragon', path: '' })
  assert.equal(place(1), 'Dragon|')
  moveInto([{ creator: 'Dragon', path: '' }], [], { creator: 'Quest', path: '' })
  assert.equal(place(1), 'Quest|Dragon')
})
