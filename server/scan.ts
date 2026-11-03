import { mkdirSync } from 'node:fs'
import { opendir, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, posix, relative, sep } from 'node:path'
import { isWithin, joinPath, leafName, parentPath, rebasePath } from '../shared/tree.ts'
import { projectKey } from '../shared/types.ts'
import type { GridType, MapEdit, Root, ScanStatus } from '../shared/types.ts'
import { analyzeImage } from './analyze.ts'
import { DATA_DIR, RESCAN_MS, WORKERS } from './config.ts'
import { db, editKey, type FileRow, getFile, markChanged, deleteProfile, moveEdit, moveProfile, readEditLooks, readEdits, readProfiles, transaction, writeEdit } from './db.ts'
import { differingBits, groupMaps, guessSquares, type GroupInput, type Measured, propagateGrid, signBits, similarity } from './group.ts'
import { classify, folderChain, type ParsedName, isLikelyMap, mentions, parseName, provenance } from './names.ts'
import { listZip, localImage, readVtt } from './source.ts'

export const THUMB_DIR = join(DATA_DIR, 'thumbs')
mkdirSync(THUMB_DIR, { recursive: true })

export const thumbPath = (id: number, size: 'large' | 'small') => join(THUMB_DIR, `${id}-${size}.webp`)

const IMAGE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif'])
const VTT = new Set(['.dd2vtt', '.df2vtt', '.uvtt'])
const IGNORED = /^(?:\.|@eaDir$|#recycle$|#snapshot$|\$RECYCLE\.BIN$|__MACOSX$|System Volume Information$)/
const MIN_SIDE = 800
const REGROUP_MIN_MS = 5000

const state = { running: false, phase: 'idle' as ScanStatus['phase'], done: 0, total: 0, current: '' }
const offline = new Set<number>()
let again = false

export function scanStatus(): ScanStatus {
  const roots = (db.prepare('SELECT id, path FROM root ORDER BY path').all() as unknown as Root[]).map((r) => ({
    id: r.id,
    path: r.path,
    online: !offline.has(r.id),
  }))
  const counts = db.prepare(`SELECT
    SUM(status = 'ok') AS indexed, SUM(status = 'failed') AS failed FROM file`).get() as { indexed: number | null; failed: number | null }
  return { ...state, indexed: counts.indexed ?? 0, failed: counts.failed ?? 0, roots }
}

export function failedFiles() {
  return db.prepare(`SELECT rel, error FROM file WHERE status = 'failed' ORDER BY rel LIMIT 200`).all()
}

interface Found {
  path: string
  entry: string
  kind: 'image' | 'vtt'
  bytes: number
  mtime: number
  segments: string[]
  stem: string
}

async function walk(dir: string, visit: (path: string) => Promise<void>): Promise<boolean> {
  let complete = true
  try {
    const handle = await opendir(dir)
    for await (const item of handle) {
      if (IGNORED.test(item.name)) continue
      const path = join(dir, item.name)
      if (item.isDirectory()) complete = (await walk(path, visit)) && complete
      else if (item.isFile()) await visit(path)
    }
  } catch (error) {
    console.error(`Skipping ${dir}:`, error)
    return false
  }
  return complete
}

const kindOf = (name: string) => {
  const ext = extname(name).toLowerCase()
  return IMAGE.has(ext) ? 'image' : VTT.has(ext) ? 'vtt' : null
}

const upsert = () => db.prepare(`
  INSERT INTO file (root_id, path, entry, kind, bytes, mtime, rel, name, labelled, has_grid,
                    time, weather, biomes)
  VALUES (:root, :path, :entry, :kind, :bytes, :mtime, :rel, :name, :labelled, :grid,
          :time, :weather, :biomes)
  ON CONFLICT (path, entry) DO UPDATE SET
    bytes = excluded.bytes, mtime = excluded.mtime, status = 'pending', error = NULL, labelled = excluded.labelled
  WHERE file.bytes != excluded.bytes OR file.mtime != excluded.mtime`)

function record(rootId: number, rootName: string, found: Found) {
  const dirs = found.segments.slice(0, -1)
  const parsed = parseName(found.stem, dirs)
  const rel = [rootName, ...found.segments].join('/')
  const tags = classify(found.stem, dirs.join(' '))
  upsert().run({
    root: rootId, path: found.path, entry: found.entry, kind: found.kind, bytes: found.bytes, mtime: found.mtime,
    rel, name: found.stem, labelled: parsed.labelled ? 1 : 0, grid: parsed.grid ? 1 : 0,
    time: tags.time, weather: tags.weather, biomes: JSON.stringify(tags.biomes),
  })
  return `${found.path}\0${found.entry}`
}

async function scanRoot(root: Root): Promise<void> {
  const info = await stat(root.path).catch(() => null)
  if (!info?.isDirectory()) {
    // A share that dropped off the network must not wipe the index.
    offline.add(root.id)
    return
  }
  offline.delete(root.id)
  const rootName = basename(root.path)
  const seen = new Set<string>()
  const known = db.prepare('SELECT bytes, mtime FROM file WHERE path = ? LIMIT 1')
  const inZip = db.prepare('SELECT entry FROM file WHERE path = ?')

  const complete = await walk(root.path, async (path) => {
    const name = basename(path)
    const dirs = relative(root.path, dirname(path)).split(sep).filter(Boolean)
    if (extname(name).toLowerCase() === '.zip') {
      const zipInfo = await stat(path)
      const stem = name.slice(0, -4)
      const rows = inZip.all(path) as { entry: string }[]
      const unchanged = rows.length && (known.get(path) as { mtime: number })?.mtime === zipInfo.mtimeMs
      if (unchanged) {
        // Skip rules may have changed since the zip was read; anything they now exclude is left unseen and removed.
        for (const row of rows) {
          const parts = row.entry.split('/').filter(Boolean)
          if (isLikelyMap(parts.slice(0, -1), parts.at(-1)!.replace(/\.[^.]+$/, ''))) seen.add(`${path}\0${row.entry}`)
        }
        return
      }
      const entries = await listZip(path).catch((error) => {
        console.error(`Cannot read ${path}:`, error.message)
        return []
      })
      transaction(() => {
        for (const entry of entries) {
          const kind = kindOf(entry.name)
          const parts = entry.name.split('/').filter(Boolean)
          const file = parts.at(-1)!
          const fileStem = file.slice(0, -extname(file).length)
          if (!kind || !isLikelyMap(parts.slice(0, -1), fileStem)) continue
          seen.add(record(root.id, rootName, {
            path, entry: entry.name, kind, bytes: entry.bytes, mtime: zipInfo.mtimeMs,
            segments: [...dirs, stem, ...parts], stem: fileStem,
          }))
        }
      })
      return
    }
    const kind = kindOf(name)
    const stemName = name.slice(0, -extname(name).length)
    if (!kind || !isLikelyMap(dirs, stemName)) return
    const fileInfo = await stat(path)
    seen.add(record(root.id, rootName, {
      path, entry: '', kind, bytes: fileInfo.size, mtime: fileInfo.mtimeMs, segments: [...dirs, name], stem: stemName,
    }))
    state.current = name
  })

  // Only an exhaustive walk that found something can prove files are gone.
  if (!complete || !seen.size) return
  const rows = db.prepare('SELECT id, path, entry FROM file WHERE root_id = ?').all(root.id) as unknown as Pick<FileRow, 'id' | 'path' | 'entry'>[]
  const gone = rows.filter((r) => !seen.has(`${r.path}\0${r.entry}`))
  transaction(() => {
    for (const row of gone) db.prepare('DELETE FROM file WHERE id = ?').run(row.id)
  })
  await Promise.all(gone.flatMap((r) => [rm(thumbPath(r.id, 'large'), { force: true }), rm(thumbPath(r.id, 'small'), { force: true })]))
}

/** Attaches each VTT file to the images of the same map; lone VTT files are maps themselves. */
function pairSidecars(): void {
  const rows = db.prepare(`SELECT id, path, entry, kind, name, vtt_path, vtt_entry, status FROM file`).all() as unknown as FileRow[]
  const location = (r: FileRow) => `${r.path}\0${posix.dirname(r.entry)}\0${parseName(r.name).key}`
  const sidecars = new Map<string, FileRow>()
  for (const row of rows) if (row.kind === 'vtt') sidecars.set(location(row), row)

  transaction(() => {
    const paired = new Set<number>()
    for (const row of rows) {
      if (row.kind !== 'image') continue
      const vtt = sidecars.get(location(row))
      if (vtt) paired.add(vtt.id)
      if ((vtt?.path ?? null) !== row.vtt_path || (vtt?.entry ?? null) !== row.vtt_entry) {
        db.prepare(`UPDATE file SET vtt_path = ?, vtt_entry = ?, status = 'pending' WHERE id = ?`)
          .run(vtt?.path ?? null, vtt?.entry ?? null, row.id)
      }
    }
    for (const row of rows) {
      if (row.kind !== 'vtt') continue
      const wanted = paired.has(row.id) ? 'sidecar' : row.status === 'sidecar' ? 'pending' : row.status
      if (wanted !== row.status) db.prepare('UPDATE file SET status = ? WHERE id = ?').run(wanted, row.id)
    }
  })
}

async function analyzeOne(id: number): Promise<void> {
  const file = getFile(id)!
  try {
    const input = await localImage(file)
    const result = await analyzeImage(input, { large: thumbPath(id, 'large'), small: thumbPath(id, 'small') })
    if (Math.min(result.width, result.height) < MIN_SIDE) {
      await Promise.all([rm(thumbPath(id, 'large'), { force: true }), rm(thumbPath(id, 'small'), { force: true })])
      db.prepare(`UPDATE file SET status = 'sidecar' WHERE id = ?`).run(id)
      return
    }
    let vtt: { cols: number; rows: number; walls: number; lights: number } | null = null
    const vttSource = file.kind === 'vtt' ? file : file.vtt_path ? { path: file.vtt_path, entry: file.vtt_entry ?? '', mtime: file.mtime } : null
    if (vttSource) {
      const data = await readVtt(vttSource).catch(() => null)
      if (data) {
        vtt = {
          cols: data.resolution.map_size.x,
          rows: data.resolution.map_size.y,
          walls: data.line_of_sight?.length ?? 0,
          lights: data.lights?.length ?? 0,
        }
      }
    }
    const named = parseName(file.name, file.rel.split('/').slice(1, -1))
    const hasGrid = named.grid === false ? false : named.grid === true || !!result.period
    db.prepare(`UPDATE file SET status = 'ok', error = NULL, format = ?, width = ?, height = ?, ink = ?, color = ?,
        colors = ?, sig = ?, period_x = ?, period_y = ?, phase_x = ?, phase_y = ?, has_grid = ?, vtt_cols = ?,
        vtt_rows = ?, walls = ?, lights = ?, hex_size = ?, hex_pointy = ?, tile_period = ? WHERE id = ?`).run(
      result.format, result.width, result.height, result.ink, result.color, JSON.stringify(result.colors),
      new Uint8Array(result.sig.buffer), result.period?.x ?? null, result.period?.y ?? null,
      result.period?.phaseX ?? null, result.period?.phaseY ?? null, hasGrid ? 1 : 0,
      vtt?.cols ?? null, vtt?.rows ?? null, vtt?.walls ?? 0, vtt?.lights ?? 0,
      result.lattice.hex?.size ?? null, result.lattice.hex ? Number(result.lattice.hex.pointy) : null, result.lattice.tile?.period ?? null, id,
    )
  } catch (error) {
    console.error(`Failed ${file.rel}:`, error)
    db.prepare(`UPDATE file SET status = 'failed', error = ? WHERE id = ?`).run(String((error as Error).message ?? error), id)
  }
}

const MAX_TILE_COLS = 80

function measure(f: FileRow, named: ParsedName): Measured {
  const base = { id: f.id, width: f.width, height: f.height, offsetX: 0, offsetY: 0, gridType: 'square' as GridType }
  const hexName = /(?<![a-z])hex(?![a-z])/i.test(f.name)
  const hexType: GridType = f.hex_pointy === 0 ? 'hex' : 'hexPointy'
  if (f.user_cols && f.user_rows) {
    return { ...base, cols: f.user_cols, rows: f.user_rows, offsetX: f.user_offset_x ?? 0, offsetY: f.user_offset_y ?? 0, source: 'manual', gridType: f.user_grid_type ?? 'square' }
  }
  if (f.period_x && f.period_y) {
    // A stated resolution within measuring error is the exact figure.
    const stated = named.ppi && Math.abs(f.period_x / named.ppi - 1) < 0.01 ? named.ppi : null
    const [x, y] = stated ? [stated, stated] : [f.period_x, f.period_y]
    return { ...base, cols: f.width / x, rows: f.height / y, offsetX: f.phase_x ?? 0, offsetY: f.phase_y ?? 0, source: 'visual' }
  }
  // Map detail and faint square grids both mimic hexes, so this needs a file that says it is one.
  if (f.hex_size && named.grid !== false && hexName) {
    const stated = named.ppi && Math.abs(f.hex_size / named.ppi - 1) < 0.03 ? named.ppi : f.hex_size
    return { ...base, cols: f.width / stated, rows: f.height / stated, source: 'visual', gridType: hexType }
  }
  const gridType = hexName ? hexType : 'square'
  // Converted VTT files can carry a scale that contradicts the map's stated size.
  const vttAgrees = f.vtt_cols && f.vtt_rows && (!named.cols || Math.abs(f.vtt_cols / named.cols - 1) < 0.03)
  if (vttAgrees) return { ...base, cols: f.vtt_cols!, rows: f.vtt_rows!, source: 'vtt', gridType }
  if (named.cols && named.rows) return { ...base, cols: named.cols, rows: named.rows, source: 'filename', gridType }
  if (named.ppi) return { ...base, cols: f.width / named.ppi, rows: f.height / named.ppi, source: 'filename', gridType }
  if (f.tile_period) {
    // Floors often tile at half a square; a map is rarely this many squares across.
    const period = f.width / f.tile_period > MAX_TILE_COLS ? f.tile_period * 2 : f.tile_period
    return { ...base, cols: f.width / period, rows: f.height / period, source: 'pattern', gridType }
  }
  return { ...base, ...guessSquares(f.width, f.height), source: 'guess', gridType }
}

const folderSegments = (f: FileRow) => f.rel.split('/').slice(1, -1)

/** Works out each file's creator and project from the whole library's folder structure. */
function placeFiles(rows: FileRow[]): Map<number, { creator: string; pack: string }> {
  const chains = new Map(rows.map((f) => {
    const chain = folderChain(folderSegments(f))
    return [f.id, chain.names.length ? chain : folderChain([f.rel.split('/')[0]])]
  }))
  const tally = new Map<string, { total: number; echoing: number }>()
  for (const f of rows) {
    const { names } = chains.get(f.id)!
    if (names.length !== 1) continue
    const count = tally.get(names[0]) ?? { total: 0, echoing: 0 }
    count.total++
    if (mentions(names[0], f.name)) count.echoing++
    tally.set(names[0], count)
  }
  return new Map(rows.map((f) => {
    const chain = chains.get(f.id)!
    const count = tally.get(chain.names[0] ?? '')
    return [f.id, provenance(chain, count ? count.echoing / count.total : 0)]
  }))
}

const RENAMED = 0.97
const RENAMED_DIFFERENT_BITS = 0.2
const look = (sig: Uint8Array) => new Int8Array(sig.buffer, sig.byteOffset, sig.byteLength)

/** A renamed or re-exported file gets a new key, so an edit left without a file passes to the file that looks the same. */
function followRenames(rows: FileRow[]): void {
  const present = new Set((db.prepare('SELECT name, bytes FROM file').all() as unknown as Pick<FileRow, 'name' | 'bytes'>[]).map(editKey))
  const edits = readEditLooks()
  const left = edits.filter((e) => e.sig && !present.has(e.key))
  if (!left.length) return
  const claimed = new Set(edits.map((e) => e.key))
  const open = rows.filter((f) => f.sig && !claimed.has(editKey(f))).map((f) => {
    const sig = look(f.sig!)
    return { key: editKey(f), sig, bits: signBits(sig) }
  })
  for (const edit of left) {
    const sig = look(edit.sig!)
    const bits = signBits(sig)
    let best = RENAMED
    let match = -1
    open.forEach((file, i) => {
      if (differingBits(bits, file.bits) > sig.length * RENAMED_DIFFERENT_BITS) return
      const score = similarity(sig, file.sig)
      if (score >= best) [best, match] = [score, i]
    })
    if (match < 0) continue
    moveEdit(edit.key, open[match].key)
    open.splice(match, 1)
  }
}

/** Favourite and hidden are the user's marks, not corrections to what was detected. */
const isCorrected = ({ favorite, hidden, ...corrections }: MapEdit) => Object.keys(corrections).length > 0

export function regroup(): void {
  const all = db.prepare(`SELECT * FROM file WHERE status = 'ok'`).all() as unknown as FileRow[]
  // A pack kept both zipped and unpacked is one map; the loose file is the faster to read.
  const unique = new Map<string, FileRow>()
  for (const row of [...all].sort((a, b) => Number(!!a.entry) - Number(!!b.entry) || a.id - b.id)) {
    const key = `${row.name}\0${row.bytes}`
    if (!unique.has(key)) unique.set(key, row)
  }
  const rows = [...unique.values()]
  const byId = new Map(rows.map((r) => [r.id, r]))
  followRenames(rows)
  const edits = readEdits()
  const editOf = (f: FileRow): MapEdit => edits.get(editKey(f)) ?? {}
  const places = placeFiles(rows)
  for (const f of rows) {
    const edit = editOf(f)
    const place = places.get(f.id)!
    if (edit.creator !== undefined) place.creator = edit.creator ?? ''
    if (edit.pack !== undefined) place.pack = edit.pack ?? ''
  }
  const names = new Map(rows.map((f) => [f.id, parseName(f.name, folderSegments(f))]))
  const inputs = rows.map((f): GroupInput => {
    const parsed = names.get(f.id)!
    const { creator, pack } = places.get(f.id)!
    return {
      id: f.id,
      // Grid and gridless copies often sit in parallel folders, so a creator's loose maps compare across them.
      scope: pack || creator ? `${creator}\0${pack}` : `${dirname(f.path)}\0${posix.dirname(f.entry)}`,
      tokens: parsed.tokens.length ? parsed.tokens : [f.name],
      version: parsed.version,
      labelled: parsed.labelled,
      key: parsed.key,
      width: f.width,
      height: f.height,
      sig: new Int8Array(f.sig!.buffer, f.sig!.byteOffset, f.sig!.byteLength),
      hasGrid: !!f.has_grid,
      time: f.time,
      scene: editOf(f).scene ?? undefined,
    }
  })
  const groups = groupMaps(inputs)

  transaction(() => {
    db.exec('DELETE FROM grp')
    db.exec('UPDATE file SET group_id = NULL')
    const addGroup = db.prepare('INSERT INTO grp (title, creator, pack, cover_id) VALUES (?, ?, ?, ?)')
    const setMember = db.prepare(`UPDATE file SET group_id = ?, variant = ?, variant_kind = ?, variant_order = ?, creator = ?, pack = ?,
      cols = ?, rows = ?, offset_x = ?, offset_y = ?, grid_source = ?, grid_type = ?, tags = ?, edited = ? WHERE id = ?`)
    for (const group of groups) {
      const { creator, pack } = places.get(group.members[0].id)!
      const { lastInsertRowid } = addGroup.run(group.title, creator, pack, group.coverId)
      const measured = new Map(propagateGrid(group.members.map((m) => measure(byId.get(m.id)!, names.get(m.id)!))).map((m) => [m.id, m]))
      for (const member of group.members) {
        const m = measured.get(member.id)!
        const edit = editOf(byId.get(member.id)!)
        setMember.run(
          lastInsertRowid, edit.variant ?? member.variant, edit.kind ?? member.kind, edit.order ?? member.order, creator, pack,
          m.cols, m.rows, m.offsetX, m.offsetY, m.source, m.gridType, edit.tags ? JSON.stringify(edit.tags) : null,
          isCorrected(edit) ? 1 : 0, member.id,
        )
      }
    }
  })
  markChanged()
}

export interface TreeNode {
  creator: string
  /** '' is the creator itself. */
  path: string
}

const profileKey = ({ creator, path }: TreeNode) => (path ? projectKey(creator, path) : creator)
const profileKind = ({ path }: TreeNode) => (path ? 'project' : 'creator') as 'project' | 'creator'

function filesUnder({ creator, path }: TreeNode): Pick<FileRow, 'id' | 'pack'>[] {
  const rows = db.prepare(`SELECT id, pack FROM file WHERE status = 'ok' AND creator = ?`).all(creator) as unknown as Pick<FileRow, 'id' | 'pack'>[]
  return rows.filter((r) => isWithin(r.pack, path))
}

/** The edits and profile moves that take everything under `from` to `to`. A name already in use merges. */
function planMove(from: TreeNode, to: TreeNode, keepProfile = true): [number[], MapEdit][] {
  const byPack = new Map<string, number[]>()
  for (const file of filesUnder(from)) byPack.set(file.pack, [...(byPack.get(file.pack) ?? []), file.id])
  const nested = Object.keys(readProfiles('project'))
    .map((key) => JSON.parse(key) as [string, string])
    .filter(([creator, path]) => creator === from.creator && path !== from.path && isWithin(path, from.path))
  for (const [creator, path] of nested) {
    moveProfile('project', projectKey(creator, path), 'project', projectKey(to.creator, rebasePath(path, from.path, to.path)))
  }
  if (keepProfile) moveProfile(profileKind(from), profileKey(from), profileKind(to), profileKey(to))
  else deleteProfile(profileKind(from), profileKey(from))
  return [...byPack].map(([pack, ids]) => [ids, { creator: to.creator, pack: rebasePath(pack, from.path, to.path) }])
}

const applyPlans = (plans: [number[], MapEdit][]) => applyEdits(plans)

/** Moves a creator or project, which also renames it when the new path's last name differs. */
export const moveNode = (from: TreeNode, to: TreeNode) => applyPlans(planMove(from, to))

/** Moves creators and projects inside `into`, and scenes straight into it. */
export function moveInto(nodes: TreeNode[], files: number[], into: TreeNode): void {
  const plans = nodes.flatMap((node) => planMove(node, { creator: into.creator, path: joinPath(into.path, leafName(node.path || node.creator)) }))
  if (files.length) plans.push([files, { creator: into.creator, pack: into.path }])
  applyPlans(plans)
}

/** Removes a project level; what it held moves up to its parent. */
export function dissolveNode(node: TreeNode): void {
  applyPlans(planMove(node, { creator: node.creator, path: parentPath(node.path) }, false))
}

/** Dissolves every project under `root` that holds a single scene and nothing else. */
export function flattenSingles(root: TreeNode): number {
  const rows = db.prepare(`SELECT DISTINCT pack, group_id FROM file WHERE status = 'ok' AND group_id IS NOT NULL AND creator = ?`).all(root.creator) as { pack: string; group_id: number }[]
  const packs = rows.map((r) => r.pack).filter((p) => p && isWithin(p, root.path))
  const singles = [...new Set(packs)].filter((p) => p !== root.path && packs.filter((q) => q === p).length === 1 && !packs.some((q) => q !== p && isWithin(q, p)))
  applyPlans(singles.flatMap((path) => planMove({ creator: root.creator, path }, { creator: root.creator, path: parentPath(path) }, false)))
  return singles.length
}

/** Records corrections on files, then rebuilds the library around them once. */
export function applyEdits(plans: [number[], MapEdit][]): void {
  transaction(() => {
    for (const [ids, patch] of plans) {
      for (const id of ids) {
        const file = getFile(id)
        if (file) writeEdit(file, patch)
      }
    }
  })
  regroup()
}

export const applyEdit = (ids: number[], patch: MapEdit) => applyEdits([[ids, patch]])

async function run(): Promise<void> {
  const roots = db.prepare('SELECT id, path FROM root').all() as unknown as Root[]
  state.phase = 'walking'
  state.done = state.total = 0
  for (const root of roots) await scanRoot(root)
  pairSidecars()

  const pending = db.prepare(`SELECT id FROM file WHERE status = 'pending'`).all() as { id: number }[]
  state.phase = 'analyzing'
  state.total = pending.length
  let next = 0
  let groupedAt = Date.now()
  let groupCost = 0
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < pending.length) {
      const { id } = pending[next++]
      state.current = getFile(id)?.name ?? ''
      await analyzeOne(id)
      state.done++
      // Keeps the gallery filling in during a long first scan, without letting
      // regrouping take more than a small share of the time as the library grows.
      if (Date.now() - groupedAt > Math.max(REGROUP_MIN_MS, groupCost * 20)) {
        const started = Date.now()
        regroup()
        groupedAt = Date.now()
        groupCost = groupedAt - started
      }
    }
  }))
  state.phase = 'grouping'
  regroup()
}

export async function startScan(): Promise<void> {
  if (state.running) {
    again = true
    return
  }
  state.running = true
  try {
    do {
      again = false
      await run()
    } while (again)
  } catch (error) {
    console.error('Scan failed:', error)
  } finally {
    state.running = false
    state.phase = 'idle'
    state.current = ''
  }
}

export function startSchedule(): void {
  setInterval(() => void startScan(), RESCAN_MS).unref()
  void startScan()
}

/** Applies a corrected grid to every same-shaped file of the map's family. */
export function saveGrid(id: number, grid: { cols: number; rows: number; offsetX: number; offsetY: number; type?: GridType } | null): void {
  const file = getFile(id)
  if (!file) return
  const family = db.prepare(`SELECT id, width, height FROM file WHERE group_id = ? AND status = 'ok'`).all(file.group_id) as unknown as Pick<FileRow, 'id' | 'width' | 'height'>[]
  transaction(() => {
    for (const member of family) {
      const scale = member.width / file.width
      if (Math.abs(member.height / member.width - file.height / file.width) > 0.01) continue
      db.prepare(`UPDATE file SET user_cols = ?, user_rows = ?, user_offset_x = ?, user_offset_y = ?, user_grid_type = ? WHERE id = ?`).run(
        grid?.cols ?? null, grid?.rows ?? null, grid ? grid.offsetX * scale : null, grid ? grid.offsetY * scale : null, grid?.type ?? null, member.id,
      )
    }
  })
  regroup()
}
