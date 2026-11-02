import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PAPERS, generatePages, generatePagesIn, gridCandidates, sheetCount, pageLabel, columnsOf, intersect, gridSegments,
  type PageSpec, type Plane,
} from './layout.ts'

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

const A4 = PAPERS.find((p) => p.id === 'a4')!
const spec = (over: Partial<PageSpec> = {}): PageSpec => ({
  paperW: A4.w, paperH: A4.h, orientation: 'portrait', marginMm: 6.35, overlapMm: 0,
  squareMm: 25.4, seamsOnGrid: true, ...over,
})
const plane = (cols: number, rows: number, over: Partial<Plane> = {}): Plane => ({
  w: cols * 25.4, h: rows * 25.4, offsetX: 0, offsetY: 0, ...over,
})

test('seams on grid: A4 pages hold whole squares', () => {
  const pages = generatePages(plane(20, 30), spec())
  assert.ok(pages.length > 0)
  for (const p of pages) {
    near(p.w, 7 * 25.4)
    near(p.h, 11 * 25.4)
    near(p.w, 177.8)
    near(p.h, 279.4)
    assert.equal(p.sheetW, 210)
    assert.equal(p.sheetH, 297)
  }
  // 20/7 -> 3 columns, 30/11 -> 3 rows
  assert.equal(pages.length, 9)
  assert.equal(columnsOf(pages), 3)
})

test('seams off grid uses the full printable area', () => {
  const pages = generatePages(plane(20, 30), spec({ seamsOnGrid: false }))
  near(pages[0].w, 210 - 12.7)
  near(pages[0].h, 297 - 12.7)
})

test('orientation auto picks the layout with fewer sheets', () => {
  // Wide map: landscape needs fewer sheets than portrait.
  const wide = plane(22, 7)
  const portrait = sheetCount(wide, spec({ orientation: 'portrait' }))
  const landscape = sheetCount(wide, spec({ orientation: 'landscape' }))
  assert.ok(landscape < portrait, `${landscape} < ${portrait}`)
  assert.equal(sheetCount(wide, spec({ orientation: 'auto' })), landscape)
  const pages = generatePages(wide, spec({ orientation: 'auto' }))
  assert.equal(pages[0].sheetW, 297)
  assert.equal(pages[0].sheetH, 210)

  // Tall map: portrait wins.
  const tall = plane(7, 22)
  assert.ok(sheetCount(tall, spec({ orientation: 'portrait' })) < sheetCount(tall, spec({ orientation: 'landscape' })))
  assert.equal(generatePages(tall, spec({ orientation: 'auto' }))[0].sheetW, 210)

  // Auto never does worse than either fixed choice.
  for (const [c, r] of [[7, 11], [15, 9], [9, 15], [30, 30]]) {
    const pl = plane(c, r)
    const auto = sheetCount(pl, spec({ orientation: 'auto' }))
    assert.ok(auto <= sheetCount(pl, spec({ orientation: 'portrait' })))
    assert.ok(auto <= sheetCount(pl, spec({ orientation: 'landscape' })))
  }
})

test('forced orientation is respected', () => {
  const pl = plane(10, 10)
  assert.equal(generatePages(pl, spec({ orientation: 'portrait' }))[0].sheetW, 210)
  assert.equal(generatePages(pl, spec({ orientation: 'landscape' }))[0].sheetW, 297)
})

test('a map smaller than one sheet gives a single page', () => {
  assert.equal(generatePages(plane(3, 3), spec()).length, 1)
})

test('overlap grows each page and shrinks the step', () => {
  const s = spec({ overlapMm: 10, seamsOnGrid: false })
  const pages = generatePages({ w: 500, h: 284.3, offsetX: 0, offsetY: 0 }, s)
  assert.ok(pages.length >= 3)
  const [a, b] = pages
  near(a.w, 197.3)
  near(b.x, a.x + a.w - 10)
  // Seams on grid with overlap: step stays a whole number of squares, size adds overlap.
  const g = generatePages(plane(20, 11), spec({ overlapMm: 5 }))
  near(g[0].w, 7 * 25.4 + 5) // (197.3 - 5) / 25.4 = 7.57 -> 7 whole squares
})

test('grid offset starts the first page before the image on grid lines', () => {
  const offset = 10
  const pages = generatePages(plane(20, 11, { offsetX: offset }), spec())
  near(pages[0].x, offset - 25.4)
  assert.ok(pages[0].x < 0)
  // Every page edge sits on a grid line.
  for (const p of pages) {
    const r = (((p.x - offset) % 25.4) + 25.4) % 25.4
    near(Math.min(r, 25.4 - r), 0, 1e-6)
  }
  // Zero or full-square offsets need no shift.
  assert.equal(generatePages(plane(20, 11, { offsetX: 25.4 }), spec())[0].x, 0)
  assert.equal(generatePages(plane(20, 11, { offsetX: 0 }), spec())[0].x, 0)
})

test('pages cover the whole map', () => {
  const cases: [Plane, Partial<PageSpec>][] = [
    [plane(20, 30), {}],
    [plane(20, 30, { offsetX: 7, offsetY: 3 }), {}],
    [{ w: 1234, h: 987, offsetX: 0, offsetY: 0 }, { seamsOnGrid: false }],
    [plane(52, 52, { offsetX: 12.3, offsetY: 20 }), { overlapMm: 6, orientation: 'auto' }],
    [plane(13, 7), { orientation: 'landscape' }],
  ]
  for (const [pl, over] of cases) {
    const pages = generatePages(pl, spec(over))
    const minX = Math.min(...pages.map((p) => p.x))
    const minY = Math.min(...pages.map((p) => p.y))
    const maxX = Math.max(...pages.map((p) => p.x + p.w))
    const maxY = Math.max(...pages.map((p) => p.y + p.h))
    assert.ok(minX <= 1e-6 && minY <= 1e-6)
    assert.ok(maxX >= pl.w - 1e-6, `right edge ${maxX} < ${pl.w}`)
    assert.ok(maxY >= pl.h - 1e-6, `bottom edge ${maxY} < ${pl.h}`)
    // Sample points: each is on at least one page.
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 20; j++) {
        const px = Math.min(pl.w - 0.001, (pl.w * i) / 20)
        const py = Math.min(pl.h - 0.001, (pl.h * j) / 20)
        assert.ok(
          pages.some((p) => px >= p.x - 1e-6 && px <= p.x + p.w + 1e-6 && py >= p.y - 1e-6 && py <= p.y + p.h + 1e-6),
          `uncovered ${px},${py}`,
        )
      }
    }
  }
})

test('sheetCount equals generatePages length', () => {
  for (const orientation of ['auto', 'portrait', 'landscape'] as const) {
    for (const seamsOnGrid of [true, false]) {
      for (const overlapMm of [0, 8]) {
        for (const paper of [A4, PAPERS.find((p) => p.id === 'letter')!, PAPERS.find((p) => p.id === 'a3')!]) {
          for (const pl of [plane(10, 10), plane(52, 52, { offsetX: 5 }), plane(80, 55, { offsetY: 11 })]) {
            const s = spec({ orientation, seamsOnGrid, overlapMm, paperW: paper.w, paperH: paper.h })
            assert.equal(sheetCount(pl, s), generatePages(pl, s).length)
          }
        }
      }
    }
  }
})

test('unusable settings produce no pages', () => {
  const s = spec({ marginMm: 200, seamsOnGrid: false })
  assert.equal(sheetCount(plane(5, 5), s), 0)
  assert.deepEqual(generatePages(plane(5, 5), s), [])
  assert.equal(columnsOf([]), 1)
})

test('pageLabel is spreadsheet-style, row-major', () => {
  assert.equal(pageLabel(0, 3), 'A1')
  assert.equal(pageLabel(1, 3), 'B1')
  assert.equal(pageLabel(2, 3), 'C1')
  assert.equal(pageLabel(3, 3), 'A2')
  assert.equal(pageLabel(7, 3), 'B3')
  assert.equal(pageLabel(25, 100), 'Z1')
  assert.equal(pageLabel(26, 100), 'C271')
})

test('columnsOf counts pages in the first row', () => {
  assert.equal(columnsOf(generatePages(plane(20, 30), spec())), 3)
  assert.equal(columnsOf(generatePages(plane(3, 3), spec())), 1)
})

test('intersect', () => {
  assert.deepEqual(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 })
  assert.deepEqual(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 3, w: 2, h: 2 }), { x: 2, y: 3, w: 2, h: 2 })
  assert.equal(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), null, 'touching edges')
  assert.equal(intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }), null)
})

test('gridSegments: square grid', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 }
  const segs = gridSegments('square', rect, 25, 0, 0)
  const vertical = segs.filter(([x1, , x2]) => x1 === x2)
  const horizontal = segs.filter(([, y1, , y2]) => y1 === y2)
  assert.deepEqual(vertical.map((s) => s[0]), [0, 25, 50, 75, 100])
  assert.deepEqual(horizontal.map((s) => s[1]), [0, 25, 50])
  for (const [, y1, , y2] of vertical) assert.deepEqual([y1, y2], [0, 50])
  for (const [x1, , x2] of horizontal) assert.deepEqual([x1, x2], [0, 100])

  // Offset shifts lines but keeps spacing.
  const shifted = gridSegments('square', rect, 25, 10, 5)
  assert.deepEqual(shifted.filter(([x1, , x2]) => x1 === x2).map((s) => s[0]), [10, 35, 60, 85])
  assert.deepEqual(shifted.filter(([, y1, , y2]) => y1 === y2).map((s) => s[1]), [5, 30])

  // Lines lie inside the rect.
  const sub = gridSegments('square', { x: 30, y: 30, w: 40, h: 40 }, 25, 0, 0)
  assert.deepEqual(sub.filter(([x1, , x2]) => x1 === x2).map((s) => s[0]), [50])
})

test('gridSegments: hex grid', () => {
  const size = 20
  const segs = gridSegments('hex', { x: 0, y: 0, w: 100, h: 100 }, size, 0, 0)
  assert.ok(segs.length > 0)
  assert.equal(segs.length % 3, 0, 'three edges per cell')
  const edge = size / 2 // flat-top hex: side length equals half the corner-to-corner width
  for (const [x1, y1, x2, y2] of segs) {
    near(Math.hypot(x2 - x1, y2 - y1), edge, 1e-9)
  }
  // Cell centres follow the flat-top pitch: 0.75*size across, sqrt(3)/2*size down.
  const horizontalEdges = segs.filter(([, y1, , y2]) => Math.abs(y1 - y2) < 1e-9)
  assert.ok(horizontalEdges.length > 0)
  const ys = new Set(horizontalEdges.map((s) => Math.round(s[1] * 1e6) / 1e6))
  const h = (size * Math.sqrt(3)) / 4
  for (const y of ys) assert.ok(Number.isFinite(y))
  assert.ok([...ys].some((y) => Math.abs(y - (0 - h)) < 1e-6 || Math.abs(y - h) < 1e-6))
})

test('generatePagesIn: covers only the crop, with seams on grid lines', () => {
  const plane = { w: 1000, h: 1000, offsetX: 0, offsetY: 0 }
  const spec = { paperW: 210, paperH: 297, orientation: 'portrait' as const, marginMm: 6.35, overlapMm: 0, squareMm: 25.4, seamsOnGrid: true }
  const crop = { x: 130, y: 260, w: 300, h: 200 }
  const pages = generatePagesIn(crop, plane, spec)
  assert.ok(pages.length < generatePages(plane, spec).length)
  for (const p of pages) {
    assert.ok(Math.abs(p.x / 25.4 - Math.round(p.x / 25.4)) < 1e-6)
    assert.ok(p.x < crop.x + crop.w && p.y < crop.y + crop.h)
  }
  assert.ok(Math.min(...pages.map((p) => p.x)) <= crop.x)
  assert.ok(Math.max(...pages.map((p) => p.x + p.w)) >= crop.x + crop.w)
  assert.ok(Math.max(...pages.map((p) => p.y + p.h)) >= crop.y + crop.h)
})

test('centered placement splits spare area evenly around the map, on grid lines', () => {
  const plane = { w: 254, h: 254, offsetX: 0, offsetY: 0 }
  const base = { paperW: 210, paperH: 297, orientation: 'portrait' as const, marginMm: 6.35, overlapMm: 0, squareMm: 25.4, seamsOnGrid: true }
  const pages = generatePages(plane, { ...base, centered: true })
  const left = Math.min(...pages.map((p) => p.x))
  const right = Math.max(...pages.map((p) => p.x + p.w))
  assert.equal(pages.length, generatePages(plane, base).length)
  assert.ok(left <= 0 && right >= 254)
  assert.ok(Math.abs(-left - (right - 254)) <= 25.4 + 1e-6)
  assert.ok(Math.abs(left / 25.4 - Math.round(left / 25.4)) < 1e-6)
})

test('pointy hex rows are staggered by half a cell across the flats', () => {
  const segments = gridSegments('hexPointy', { x: 0, y: 0, w: 100, h: 100 }, 20, 0, 0)
  assert.ok(segments.length > 0)
  for (const [a, b, c, d] of segments) assert.ok(Math.abs(Math.hypot(c - a, d - b) - 20 / Math.sqrt(3)) < 1e-6)
})

test('gridCandidates puts sizes that divide the map evenly first', () => {
  const [best] = gridCandidates(7000, 7000)
  assert.equal(best.pps, 140)
  assert.equal(best.cols, 50)
})
