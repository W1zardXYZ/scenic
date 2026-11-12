import type { GridSource, GridType, VariantKind } from '../shared/types.ts'
import { describesCondition, levelOf, variantKind } from './names.ts'

export interface GroupInput {
  id: number
  scope: string
  tokens: string[]
  version: string
  labelled: boolean
  key: string
  width: number
  height: number
  sig: Int8Array
  hasGrid: boolean
  time: string
  /** A scene name set by hand: such files group by it and nothing else. */
  scene?: string
}

export interface GroupOutput {
  title: string
  coverId: number
  members: { id: number; variant: string; kind: VariantKind; order: number }[]
}

const SAME_MAP = 0.8
const PREVIEW = 0.9
const PREVIEW_SCALE = 0.5
const NAMED_FAMILY = 0.45
const ASPECT_TOLERANCE = 0.01
const MAX_DIFFERENT_BITS = 0.45

/** Cosine similarity of two signatures; they are zero-mean, so this is correlation. */
export function similarity(a: Int8Array, b: Int8Array): number {
  let dot = 0, aa = 0, bb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    aa += a[i] * a[i]
    bb += b[i] * b[i]
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

/**
 * One sign bit per signature cell. The fraction of differing bits tracks
 * correlation at about 3% of its cost, which is what keeps a flat folder of
 * thousands of maps tractable.
 */
export function signBits(sig: Int8Array): Uint32Array {
  const bits = new Uint32Array(Math.ceil(sig.length / 32))
  for (let i = 0; i < sig.length; i++) if (sig[i] >= 0) bits[i >> 5] |= 1 << (i & 31)
  return bits
}

export function differingBits(a: Uint32Array, b: Uint32Array): number {
  let count = 0
  for (let i = 0; i < a.length; i++) {
    let v = a[i] ^ b[i]
    v -= (v >>> 1) & 0x55555555
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
  }
  return count
}

function sameShape(a: GroupInput, b: GroupInput): boolean {
  return Math.abs(a.width / a.height - b.width / b.height) <= ASPECT_TOLERANCE * (a.width / a.height)
}

function sharedLead(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && a[n].toLowerCase() === b[n].toLowerCase()) n++
  return n
}

function belongsTogether(a: GroupInput, b: GroupInput, bitsA: Uint32Array, bitsB: Uint32Array): boolean {
  if (a.scene || b.scene) return a.scene === b.scene
  if (a.key && a.key === b.key) return true
  // "Ranch cellar" and "Ranch upper" are one place, however different the pixels look.
  const shared = sharedLead(a.tokens, b.tokens)
  if (shared && describesCondition(a.tokens.slice(shared)) && describesCondition(b.tokens.slice(shared))) return true
  if (!sameShape(a, b) || differingBits(bitsA, bitsB) > a.sig.length * MAX_DIFFERENT_BITS) return false
  const score = similarity(a.sig, b.sig)
  if (score >= SAME_MAP) return true
  const lead = sharedLead(a.tokens, b.tokens)
  return lead >= 2 && lead / Math.min(a.tokens.length, b.tokens.length) >= 0.5 && score >= NAMED_FAMILY
}

const titleCase = (s: string) => s.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())

function describe(members: GroupInput[]): GroupOutput {
  const first = members[0].tokens
  let lead = first.length
  for (const m of members) lead = Math.min(lead, sharedLead(first, m.tokens))
  const title = members.find((m) => m.scene)?.scene ?? (first.slice(0, lead).join(' ') || first.join(' '))

  const words = (m: GroupInput) => m.tokens.slice(lead)
  const rank = (m: GroupInput) =>
    (m.hasGrid ? 2 : 0) +
    (m.time === 'Day' ? -1 : m.time ? 1 : 0) +
    Math.abs(levelOf(words(m)) ?? 0) +
    words(m).length * 0.1 -
    Math.min(m.width * m.height, 1e9) / 1e10
  const cover = [...members].sort((a, b) => rank(a) - rank(b))[0]

  const labels = members.map((m) => titleCase(words(m).join(' ')))
  const repeats = (i: number) =>
    members.some((m, j) => j !== i && labels[j] === labels[i] && m.hasGrid === members[i].hasGrid && m.version !== members[i].version)

  return {
    title,
    coverId: cover.id,
    members: members.map((m, i) => ({
      id: m.id,
      variant: [labels[i], repeats(i) ? m.version : ''].filter(Boolean).join(' '),
      kind: variantKind(words(m), m.labelled),
      order: levelOf(words(m)) ?? 0,
    })),
  }
}

/** Clusters maps into families of the same scene: lighting, weather and grid versions. */
export function groupMaps(items: GroupInput[]): GroupOutput[] {
  const parent = items.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }

  const bits = items.map((item) => signBits(item.sig))
  const scopes = new Map<string, number[]>()
  items.forEach((item, i) => {
    const list = scopes.get(item.scope)
    if (list) list.push(i)
    else scopes.set(item.scope, [i])
  })
  for (const indices of scopes.values()) {
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const [x, y] = [indices[a], indices[b]]
        const [i, j] = [find(x), find(y)]
        if (i !== j && belongsTogether(items[x], items[y], bits[x], bits[y])) parent[j] = i
      }
    }
  }

  const clusters = new Map<number, GroupInput[]>()
  items.forEach((item, i) => {
    const root = find(i)
    const list = clusters.get(root)
    if (list) list.push(item)
    else clusters.set(root, [item])
  })
  return [...clusters.values()].map(withoutPreviews).filter((c) => c.length).map(describe)
}

/**
 * Creators ship small copies of a map as previews. A file showing the same picture as
 * another of its scene at half the width or less is one, unless its name says what it is:
 * a lower-resolution version shares another file's name, and a variant such as "Night"
 * names a condition. Files placed in the scene by hand always stay.
 */
export function withoutPreviews(members: GroupInput[]): GroupInput[] {
  return members.filter((m) => {
    if (m.scene || members.some((o) => o !== m && o.key === m.key)) return true
    return !members.some((o) => {
      if (o === m || m.width > o.width * PREVIEW_SCALE || !sameShape(m, o) || similarity(m.sig, o.sig) < PREVIEW) return false
      const own = m.tokens.slice(sharedLead(m.tokens, o.tokens))
      return !own.length || !describesCondition(own)
    })
  })
}

const commonLead = (members: GroupInput[]) => members.reduce((n, m) => Math.min(n, sharedLead(members[0].tokens, m.tokens)), members[0].tokens.length)

/**
 * Puts each overlay in the scene of the map its name continues: "Ruins - Day - Open Roof"
 * goes with "Ruins - Day". Its label is what follows the scene's shared name.
 * Overlays that continue no map's name are returned to be grouped on their own.
 */
export function attachOverlays(groups: GroupOutput[], items: GroupInput[], overlays: GroupInput[]): {
  attached: Map<GroupOutput, { id: number; variant: string }[]>
  rest: GroupInput[]
} {
  const byId = new Map(items.map((i) => [i.id, i]))
  const scenes = groups.map((group) => {
    const members = group.members.map((m) => byId.get(m.id)!)
    return { group, members, scope: members[0].scope, lead: commonLead(members) }
  })
  const attached = new Map<GroupOutput, { id: number; variant: string }[]>()
  const rest: GroupInput[] = []
  for (const overlay of overlays) {
    let best: (typeof scenes)[number] | null = null
    let bestLead = 0
    for (const scene of scenes) {
      if (scene.scope !== overlay.scope) continue
      // The whole of some map's name, or at least the scene's shared name of two words or more.
      const lead = Math.max(...scene.members.map((m) => {
        const n = sharedLead(overlay.tokens, m.tokens)
        return n === m.tokens.length || (n >= scene.lead && n >= 2) ? n : 0
      }))
      if (lead > bestLead) [best, bestLead] = [scene, lead]
    }
    if (!best) {
      rest.push(overlay)
      continue
    }
    const words = overlay.tokens.slice(Math.min(best.lead, bestLead))
    const list = attached.get(best.group) ?? []
    list.push({ id: overlay.id, variant: titleCase(words.join(' ')) || overlay.tokens.join(' ') })
    attached.set(best.group, list)
  }
  return { attached, rest }
}

export interface Measured {
  id: number
  width: number
  height: number
  cols: number
  rows: number
  offsetX: number
  offsetY: number
  source: GridSource
  gridType: GridType
}

const STRENGTH: Record<GridSource, number> = { manual: 6, visual: 5, vtt: 4, filename: 3, pattern: 2, sibling: 1, guess: 0 }

const strongest = (list: Measured[]) => list.reduce((a, b) => (STRENGTH[b.source] > STRENGTH[a.source] ? b : a))

/** The most trustworthy measurement in a family applies to all of it, scaled to each file's pixels. */
export function propagateGrid(members: Measured[]): Measured[] {
  return members.map((m) => {
    if (STRENGTH[m.source] >= STRENGTH.visual) return m
    const twins = members.filter((o) => o.width === m.width && o.height === m.height)
    const best = STRENGTH[strongest(twins).source] >= STRENGTH.visual ? strongest(twins) : strongest(members)
    if (STRENGTH[best.source] <= STRENGTH[m.source]) return m
    if (Math.abs(m.width / m.height - best.width / best.height) > ASPECT_TOLERANCE) return m
    const scale = m.width / best.width
    return { ...m, cols: best.cols, rows: best.rows, offsetX: best.offsetX * scale, offsetY: best.offsetY * scale, source: 'sibling', gridType: best.gridType }
  })
}

const STANDARD_PPS = [140, 100, 70, 150, 200, 120, 300, 280, 256, 128, 160, 250, 72, 75, 50]

/** Last resort for gridless, unnamed files: a common export resolution that divides both sides evenly. */
export function guessSquares(width: number, height: number): { cols: number; rows: number } {
  for (const pps of STANDARD_PPS) {
    const cols = width / pps
    const rows = height / pps
    if (cols >= 8 && rows >= 8 && Number.isInteger(cols) && Number.isInteger(rows)) return { cols, rows }
  }
  return { cols: Math.max(1, Math.round(width / 100)), rows: Math.max(1, Math.round(height / 100)) }
}
