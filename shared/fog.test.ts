import assert from 'node:assert/strict'
import test from 'node:test'
import { bakedFog, circleCurve, curveFromStroke, type Fog, fogBounds, type FogItem, fogPath, type FogPart, fogPlan, labelRoom, labelTone, liveFog, nearestOnCurve, NEW_FOG, partBounds, scaleFog, separateFog, sharpCurve, simplify, splitCurve, withoutPart } from './fog.ts'

const rect = (x: number, y: number, w: number, h: number, subtract = false): FogPart => ({ box: { x, y, w, h }, subtract })
const box = (id: number, mode: FogItem['mode'], on = true): FogItem => ({ id, name: `Fog ${id}`, on, mode, parts: [rect(0, 0, 10, 10)] })
const fog = (patch: Partial<Fog>): Fog => ({ ...NEW_FOG, items: [box(1, 'cover'), box(2, 'show'), box(3, 'cover', false)], ...patch })
const ids = (items: FogItem[]) => items.map((i) => i.id)

test('switching fog off keeps each item as it was', () => {
  assert.deepEqual(ids(liveFog(fog({}))), [1, 2])
  assert.deepEqual(ids(liveFog(fog({ on: false }))), [])
})

test('covers go on the map unless printed separately; show shapes always do', () => {
  assert.deepEqual(ids(bakedFog(fog({}))), [1, 2])
  assert.deepEqual(ids(separateFog(fog({}))), [])
  assert.deepEqual(ids(bakedFog(fog({ separate: true }))), [2])
  assert.deepEqual(ids(separateFog(fog({ separate: true }))), [1])
})

test('simplify drops points on a straight run', () => {
  const line = [{ x: 0, y: 0 }, { x: 1, y: 0.01 }, { x: 2, y: 0 }, { x: 2, y: 5 }]
  assert.deepEqual(simplify(line, 0.1), [line[0], line[2], line[3]])
})

test('a pen stroke becomes a closed smooth shape, a dot does not', () => {
  const stroke = Array.from({ length: 60 }, (_, i) => ({ x: 50 + 40 * Math.cos(i / 9.5), y: 50 + 40 * Math.sin(i / 9.5) }))
  const curve = curveFromStroke(stroke, 2)!
  assert.ok(curve.length >= 3 && curve.length < 30)
  assert.equal(curveFromStroke([{ x: 1, y: 1 }, { x: 1, y: 1 }], 2), null)
})

test('adding a point keeps the curve where it was', () => {
  const circle = circleCurve(0, 0, 10)
  const { index, t } = nearestOnCurve(circle, { x: 12, y: 3 })
  const split = splitCurve(circle, index, t)
  assert.equal(split.length, 9)
  const before = partBounds({ points: circle })
  const after = partBounds({ points: split })
  for (const key of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(before[key] - after[key]) < 0.05)
})

test('scaling there and back returns the same fog', () => {
  const start: Fog = { ...NEW_FOG, items: [{ ...box(1, 'cover'), parts: [{ points: circleCurve(5, 5, 2), subtract: false }] }] }
  const back = scaleFog(scaleFog(start, 3, 4), 1 / 3, 1 / 4)
  assert.ok(Math.abs(back.items[0].parts[0].points![2].y - start.items[0].parts[0].points![2].y) < 1e-9)
})

const signedArea = (ring: string) => {
  const p = ring.split(/[ML]/).filter(Boolean).map((v) => v.replace('Z', '').split(' ').map(Number))
  return p.reduce((sum, a, i) => sum + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0) / 2
}

test('added parts merge into one outline', () => {
  const item = { ...box(1, 'cover'), parts: [rect(0, 0, 10, 10), rect(5, 0, 10, 10)] }
  assert.deepEqual(fogBounds(item), { x: 0, y: 0, w: 15, h: 10 })
  assert.equal(fogPath(item).match(/M/g)!.length, 1)
})

test('a subtracted part cuts a hole that runs the other way', () => {
  const item = { ...box(1, 'cover'), parts: [rect(0, 0, 10, 10), rect(3, 3, 4, 4, true)] }
  const rings = fogPath(item).split(/(?=M)/)
  assert.equal(rings.length, 2)
  assert.ok(Math.sign(signedArea(rings[0])) !== Math.sign(signedArea(rings[1])))
})

test('a shape and a box combine, and parts apply in order', () => {
  const shape: FogPart = { points: sharpCurve([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 }]), subtract: false }
  const item = { ...box(1, 'cover'), parts: [shape, rect(0, 0, 5, 30), rect(0, 25, 5, 5, true)] }
  assert.deepEqual(fogBounds(item), { x: 0, y: 0, w: 20, h: 25 })
})

test('fog with nothing left is not printed', () => {
  const item = { ...box(1, 'cover'), parts: [rect(0, 0, 10, 10), rect(0, 0, 10, 10, true)] }
  assert.equal(fogPath(item), '')
  assert.deepEqual(liveFog({ ...NEW_FOG, items: [item] }), [])
})

test('removing the first part leaves the next one adding', () => {
  const left = withoutPart([rect(0, 0, 10, 10), rect(3, 3, 4, 4, true), rect(20, 0, 5, 5)], 0)
  assert.equal(left.length, 2)
  assert.equal(left[0].subtract, false)
})

test('fog labels are a quiet step from the fill toward its ink', () => {
  assert.equal(labelTone('#ffffff'), '#b3b3b3')
  assert.equal(labelTone('#000000'), '#4d4d4d')
})

test('separate covers get marks in item order, and split ones number their pieces', () => {
  const items: FogItem[] = [
    { id: 7, name: 'Hall', on: true, mode: 'cover', parts: [rect(0, 0, 50, 50)] },
    { id: 8, name: 'Keep', on: true, mode: 'show', parts: [rect(0, 0, 50, 50)] },
    { id: 9, name: 'Cave', on: true, mode: 'cover', parts: [rect(100, 0, 150, 400)] },
  ]
  const plan = fogPlan({ ...NEW_FOG, separate: true, items }, 210, 297, 6.35, 25.4)
  assert.deepEqual(plan.cards.map((c) => c.id), ['F1', 'F2·1/2', 'F2·2/2'])
  assert.deepEqual(plan.cards.map((c) => c.mark), ['F1', 'F2', 'F2'])
  assert.equal(plan.sheets, 2)
  // Covers outside the printed part are left out, and the rest renumber.
  const cropped = fogPlan({ ...NEW_FOG, separate: true, items }, 210, 297, 6.35, 25.4, { x: 90, y: 0, w: 50, h: 50 })
  assert.deepEqual(cropped.cards.map((c) => c.id), ['F1·1/2', 'F1·2/2'])
  assert.equal(fogPlan({ ...NEW_FOG, items }, 210, 297, 6.35, 25.4).sheets, 0)
})

test('a label on an L-shaped cover lands on the floor, not in the notch', () => {
  const ell: FogItem = { id: 1, name: 'L', on: true, mode: 'cover', parts: [rect(0, 0, 100, 20), rect(80, 0, 20, 100)] }
  const room = labelRoom(ell, fogBounds(ell))!
  const [x, y] = [room.x + room.w / 2, room.y + room.h / 2]
  assert.ok(!(x < 80 && y > 20), `in the notch at ${x},${y}`)
  assert.equal(labelRoom(ell, { x: 0, y: 50, w: 40, h: 40 }), null)
})

test('fog cards can print on other paper than the map', () => {
  const items: FogItem[] = [{ id: 1, name: 'Cave', on: true, mode: 'cover', parts: [rect(0, 0, 150, 400)] }]
  // Too tall for A4, so it splits; on A3 it fits whole.
  assert.equal(fogPlan({ ...NEW_FOG, separate: true, items }, 210, 297, 6.35, 25.4).cards.length, 2)
  const a3 = fogPlan({ ...NEW_FOG, separate: true, items, paper: 'a3' }, 210, 297, 6.35, 25.4)
  assert.equal(a3.cards.length, 1)
  assert.deepEqual([Math.min(a3.sheetW, a3.sheetH), Math.max(a3.sheetW, a3.sheetH)], [297, 420])
})
