import test from 'node:test'
import assert from 'node:assert/strict'
import { groupMaps, propagateGrid, guessSquares, similarity, type GroupInput, type Measured } from './group.ts'
import { parseName } from './names.ts'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** Zero-mean signature like the scanner produces; `jitter` perturbs it slightly. */
function signature(seed: number, jitter = 0, jitterSeed = 1, n = 256): Int8Array {
  const r = rng(seed)
  const j = rng(jitterSeed * 7919 + seed)
  const raw = Array.from({ length: n }, () => (r() - 0.5) * 200 + (jitter ? (j() - 0.5) * 200 * jitter : 0))
  const mean = raw.reduce((a, b) => a + b, 0) / n
  return Int8Array.from(raw, (v) => Math.max(-127, Math.min(127, Math.round(v - mean))))
}

let nextId = 1
function item(name: string, over: Partial<GroupInput> & { sigSeed?: number } = {}): GroupInput {
  const parsed = parseName(name)
  const { sigSeed, ...rest } = over
  return {
    id: nextId++,
    scope: 'pack',
    tokens: parsed.tokens,
    version: parsed.version,
    labelled: parsed.labelled,
    key: parsed.key,
    width: 4000,
    height: 3000,
    sig: signature(sigSeed ?? nextId * 31),
    hasGrid: parsed.grid === true,
    time: '',
    ...rest,
  }
}

const groupOf = (groups: ReturnType<typeof groupMaps>, id: number) => groups.find((g) => g.members.some((m) => m.id === id))!

test('similarity: identical, opposite and unrelated signatures', () => {
  const a = signature(1)
  assert.ok(Math.abs(similarity(a, a) - 1) < 1e-9)
  const neg = Int8Array.from(a, (v) => -v)
  assert.ok(Math.abs(similarity(a, neg) + 1) < 1e-9)
  assert.ok(Math.abs(similarity(a, signature(2))) < 0.3)
  assert.equal(similarity(new Int8Array(8), a.slice(0, 8)), 0)
})

test('groupMaps: same key clusters even when the images differ', () => {
  const a = item('Cave Day GRID', { sigSeed: 1, width: 3000, height: 3000 })
  const b = item('Cave Day NG', { sigSeed: 2, width: 5000, height: 2000 })
  const [g, ...rest] = groupMaps([a, b])
  assert.equal(rest.length, 0)
  assert.deepEqual(g.members.map((m) => m.id).sort(), [a.id, b.id].sort())
})

test('groupMaps: same signature clusters despite different names', () => {
  const a = item('Forest Day', { sigSeed: 10 })
  const b = item('Totally Other Title', { sigSeed: 10 })
  const groups = groupMaps([a, b])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].members.length, 2)
})

test('groupMaps: slightly perturbed signature still matches, different aspect does not', () => {
  const a = item('Forest Day', { sigSeed: 10 })
  const slight = item('Wood Night', { sigSeed: 10, sig: signature(10, 0.2, 3) })
  assert.ok(similarity(a.sig, slight.sig) >= 0.8)
  assert.equal(groupMaps([a, slight]).length, 1)

  const tall = item('Wood Night', { sigSeed: 10, width: 3000, height: 4000 })
  assert.equal(groupMaps([a, tall]).length, 2)
})

test('groupMaps: unrelated maps stay apart', () => {
  const a = item('Forest Day', { sigSeed: 100 })
  const b = item('Desert Oasis', { sigSeed: 200 })
  const c = item('Dungeon Hall', { sigSeed: 300, width: 2000, height: 2000 })
  const groups = groupMaps([a, b, c])
  assert.equal(groups.length, 3)
  for (const g of groups) assert.equal(g.members.length, 1)
})

test('groupMaps: identical maps in different scopes are not merged', () => {
  const a = item('Forest Day', { sigSeed: 5, scope: 'packA' })
  const b = item('Forest Day', { sigSeed: 5, scope: 'packB' })
  assert.equal(groupMaps([a, b]).length, 2)
})

test('groupMaps: named family needs a shared lead and moderate similarity', () => {
  const base = signature(50)
  const related = signature(50, 0.9, 4)
  const score = similarity(base, related)
  assert.ok(score >= 0.45 && score < 0.8, `precondition: ${score}`)
  const a = item('Easter Meadow Day', { sig: base })
  const b = item('Easter Meadow Night', { sig: related })
  assert.equal(groupMaps([a, b]).length, 1)
  // Same similarity, but different lead words: apart.
  const c = item('Harbor Night', { sig: related })
  assert.equal(groupMaps([a, c]).length, 2)
})

test('groupMaps: variant labels and title', () => {
  const day = item('Easter Meadow Day', { sigSeed: 7, time: 'Day' })
  const night = item('Easter Meadow Night Rain', { sigSeed: 7, time: 'Night' })
  const [g] = groupMaps([day, night])
  assert.equal(g.title, 'Easter Meadow')
  const label = (id: number) => g.members.find((m) => m.id === id)!.variant
  assert.equal(label(day.id), 'Day')
  assert.equal(label(night.id), 'Night Rain')
})

test('groupMaps: single map has the whole name as title and an empty variant', () => {
  const only = item('Lonely Tower', { sigSeed: 77 })
  const [g] = groupMaps([only])
  assert.equal(g.title, 'Lonely Tower')
  assert.equal(g.coverId, only.id)
  assert.equal(g.members[0].variant, '')
})

test('groupMaps: cover prefers a gridless Day variant', () => {
  const dayGrid = item('Meadow Day GRID', { sigSeed: 9, hasGrid: true, time: 'Day' })
  const dayNg = item('Meadow Day NG', { sigSeed: 9, hasGrid: false, time: 'Day' })
  const night = item('Meadow Night NG', { sigSeed: 9, hasGrid: false, time: 'Night' })
  const [g] = groupMaps([dayGrid, night, dayNg])
  assert.equal(g.members.length, 3)
  assert.equal(g.coverId, dayNg.id)
})

test('groupMaps: without a Day variant, gridless beats gridded', () => {
  const grid = item('Cellar GRID', { sigSeed: 12, hasGrid: true })
  const ng = item('Cellar NG', { sigSeed: 12, hasGrid: false })
  assert.equal(groupMaps([grid, ng])[0].coverId, ng.id)
})

test('groupMaps: every input ends up in exactly one group', () => {
  const items = [
    item('A Day', { sigSeed: 1 }), item('A Night', { sigSeed: 1 }),
    item('B', { sigSeed: 2 }), item('C', { sigSeed: 3, scope: 'other' }),
  ]
  const ids = groupMaps(items).flatMap((g) => g.members.map((m) => m.id)).sort()
  assert.deepEqual(ids, items.map((i) => i.id).sort())
  assert.equal(groupOf(groupMaps(items), items[0].id).members.length, 2)
})

const measured = (over: Partial<Measured> & Pick<Measured, 'id'>): Measured => ({
  width: 4000, height: 3000, cols: 20, rows: 15, offsetX: 0, offsetY: 0, source: 'guess', gridType: 'square', ...over,
})

test('propagateGrid: same-size visual beats a vtt measurement at other dimensions', () => {
  const visual = measured({ id: 1, width: 4000, height: 3000, cols: 28, rows: 21, offsetX: 12, offsetY: 8, source: 'visual' })
  const vtt = measured({ id: 2, width: 2000, height: 1500, cols: 40, rows: 30, source: 'vtt' })
  const guess = measured({ id: 3, width: 4000, height: 3000, cols: 10, rows: 10, source: 'guess' })
  const out = propagateGrid([visual, vtt, guess])
  assert.deepEqual(out[0], visual)
  // The vtt file is weaker than the visual measurement, so it takes it, scaled to half size.
  assert.equal(out[1].source, 'sibling')
  assert.equal(out[1].cols, 28)
  assert.equal(out[1].offsetX, 6)
  assert.equal(out[1].offsetY, 4)
  assert.equal(out[2].cols, 28)
  assert.equal(out[2].rows, 21)
  assert.equal(out[2].offsetX, 12)
  assert.equal(out[2].offsetY, 8)
  assert.equal(out[2].source, 'sibling')
  assert.notEqual(out[2].cols, vtt.cols, 'the vtt count at other dimensions is not used')
})

test('propagateGrid: a weak file picks the same-size strong one, not a stronger one elsewhere', () => {
  const manualBig = measured({ id: 1, width: 4000, height: 3000, cols: 20, rows: 15, source: 'visual' })
  const vttSmall = measured({ id: 2, width: 2000, height: 1500, cols: 40, rows: 30, source: 'vtt' })
  const weakSmall = measured({ id: 3, width: 2000, height: 1500, cols: 5, rows: 5, source: 'guess' })
  const out = propagateGrid([manualBig, vttSmall, weakSmall])
  // Twins (same dims) of weakSmall: itself and vttSmall; vtt is not "visual", so the
  // visual measurement from the other size is used, scaled to the file's pixels.
  assert.equal(out[2].source, 'sibling')
  assert.equal(out[2].cols, 20)
  assert.equal(out[2].rows, 15)
})

test('propagateGrid: offsets scale with the image width', () => {
  const big = measured({ id: 1, width: 4000, height: 3000, cols: 20, rows: 15, offsetX: 40, offsetY: 20, source: 'visual' })
  const small = measured({ id: 2, width: 2000, height: 1500, cols: 1, rows: 1, source: 'filename' })
  const out = propagateGrid([big, small])
  assert.equal(out[1].offsetX, 20)
  assert.equal(out[1].offsetY, 10)
  assert.equal(out[1].cols, 20)
  assert.equal(out[1].source, 'sibling')
})

test('propagateGrid: different aspect ratio is left alone', () => {
  const visual = measured({ id: 1, source: 'visual' })
  const other = measured({ id: 2, width: 3000, height: 3000, cols: 7, rows: 7, source: 'guess' })
  assert.deepEqual(propagateGrid([visual, other])[1], other)
})

test('propagateGrid: a stronger own source is never overwritten; equal strength stays', () => {
  const filename = measured({ id: 1, source: 'filename', cols: 33, rows: 22 })
  const sibling = measured({ id: 2, source: 'sibling', cols: 1, rows: 1 })
  const out = propagateGrid([filename, sibling])
  assert.equal(out[0].cols, 33)
  assert.equal(out[1].cols, 33, 'sibling is weaker than filename')
  assert.equal(out[1].source, 'sibling')

  const manual = measured({ id: 3, source: 'manual', cols: 9, rows: 9 })
  assert.deepEqual(propagateGrid([manual, measured({ id: 4, source: 'visual' })])[0], manual)

  const a = measured({ id: 5, source: 'filename', cols: 11, rows: 11 })
  const b = measured({ id: 6, source: 'filename', cols: 12, rows: 12 })
  assert.deepEqual(propagateGrid([a, b]), [a, b])
})

test('propagateGrid: a single member is unchanged', () => {
  const only = measured({ id: 1, source: 'guess' })
  assert.deepEqual(propagateGrid([only]), [only])
})

test('guessSquares: standard pixels-per-square that divide evenly', () => {
  assert.deepEqual(guessSquares(7000, 5600), { cols: 50, rows: 40 }) // 140 ppi
  assert.deepEqual(guessSquares(3000, 2000), { cols: 30, rows: 20 }) // 100 ppi
  assert.deepEqual(guessSquares(5040, 3500), { cols: 36, rows: 25 }) // 140 first
})

test('guessSquares: falls back to ~100px squares, never below 1', () => {
  assert.deepEqual(guessSquares(1234, 777), { cols: 12, rows: 8 })
  assert.deepEqual(guessSquares(30, 20), { cols: 1, rows: 1 })
  // 7 squares at 100px is too few to be believable, so the next standard size (70) is used.
  assert.deepEqual(guessSquares(700, 700), { cols: 10, rows: 10 })
})

test('groupMaps: levels of a building are one scene, even with unrelated pixels', () => {
  const [group, ...rest] = groupMaps(['Butterskull Ranch v1.03 (cellar)', 'Butterskull Ranch v1.04 (upper)', 'Butterskull Ranch v1.0 (ground)', 'Butterskull Ranch v1.0 (roof)'].map((n) => item(n)))
  assert.equal(rest.length, 0)
  assert.equal(group.title, 'Butterskull Ranch')
  assert.deepEqual(group.members.map((m) => [m.variant, m.kind, m.order]), [['Cellar', 'level', -1], ['Upper', 'level', 1], ['Ground', 'level', 0], ['Roof', 'level', 4]])
  assert.equal(group.coverId, group.members[2].id)
})

test('groupMaps: different places sharing a prefix stay apart', () => {
  assert.equal(groupMaps([item('Haldraxis_Keep_grid_72'), item('Haldraxis_Ruins_grid_72')]).length, 2)
})

test('groupMaps: a hand-set scene overrides detection in both directions', () => {
  const a = item('Cave One', { scene: 'Sunken Vault' })
  const b = item('Totally Different', { scene: 'Sunken Vault' })
  const c = item('Cave One')
  const groups = groupMaps([a, b, c])
  assert.equal(groups.length, 2)
  assert.equal(groups.find((g) => g.members.length === 2)?.title, 'Sunken Vault')
})
