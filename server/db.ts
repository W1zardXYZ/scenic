import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { projectKey } from '../shared/types.ts'
import type { GridSource, GridType, Library, MapEdit, MapGroup, MapRecord, Profile, VariantKind } from '../shared/types.ts'
import { DATA_DIR } from './config.ts'

mkdirSync(DATA_DIR, { recursive: true })
export const db = new DatabaseSync(join(DATA_DIR, 'scenic.db'))
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS root (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS grp (id INTEGER PRIMARY KEY, title TEXT, creator TEXT, pack TEXT, cover_id INTEGER);
  CREATE TABLE IF NOT EXISTS file (
    id INTEGER PRIMARY KEY,
    root_id INTEGER NOT NULL REFERENCES root(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    entry TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    rel TEXT NOT NULL,
    name TEXT NOT NULL,
    creator TEXT NOT NULL DEFAULT '',
    pack TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    format TEXT, width INTEGER, height INTEGER,
    ink REAL, color TEXT, colors TEXT, sig BLOB,
    period_x REAL, period_y REAL, phase_x REAL, phase_y REAL,
    has_grid INTEGER NOT NULL DEFAULT 0,
    labelled INTEGER NOT NULL DEFAULT 0,
    time TEXT NOT NULL DEFAULT '', weather TEXT NOT NULL DEFAULT '', biomes TEXT NOT NULL DEFAULT '[]',
    name_cols REAL, name_rows REAL, name_ppi REAL,
    vtt_path TEXT, vtt_entry TEXT, vtt_cols REAL, vtt_rows REAL,
    walls INTEGER NOT NULL DEFAULT 0, lights INTEGER NOT NULL DEFAULT 0,
    user_cols REAL, user_rows REAL, user_offset_x REAL, user_offset_y REAL,
    cols REAL, rows REAL, offset_x REAL NOT NULL DEFAULT 0, offset_y REAL NOT NULL DEFAULT 0,
    grid_source TEXT,
    group_id INTEGER, variant TEXT NOT NULL DEFAULT '',
    UNIQUE (path, entry)
  );
  CREATE INDEX IF NOT EXISTS file_status ON file (status);
  CREATE INDEX IF NOT EXISTS file_root ON file (root_id);
`)

// Databases created before these columns existed gain them here; nothing else changes.
const columns = new Set((db.prepare('PRAGMA table_info(file)').all() as { name: string }[]).map((c) => c.name))
if (!columns.has('variant_kind')) {
  db.exec(`ALTER TABLE file ADD COLUMN variant_kind TEXT NOT NULL DEFAULT 'other'`)
  // Non-ASCII zip names were stored mis-decoded; a changed mtime makes the next scan list those zips again.
  db.exec(`UPDATE file SET mtime = 0 WHERE path IN (SELECT path FROM file WHERE entry GLOB '*[^ -~]*')`)
}
if (!columns.has('variant_order')) db.exec('ALTER TABLE file ADD COLUMN variant_order REAL NOT NULL DEFAULT 0')

if (!columns.has('hex_size')) {
  for (const column of ['hex_size REAL', 'hex_pointy INTEGER', 'tile_period REAL', 'user_grid_type TEXT', 'tags TEXT']) db.exec(`ALTER TABLE file ADD COLUMN ${column}`)
  db.exec(`ALTER TABLE file ADD COLUMN grid_type TEXT NOT NULL DEFAULT 'square'`)
  db.exec('ALTER TABLE file ADD COLUMN edited INTEGER NOT NULL DEFAULT 0')
  // Maps with no measured grid get one pass of the newer detection.
  db.exec(`UPDATE file SET status = 'pending' WHERE status = 'ok' AND period_x IS NULL`)
}
db.exec('CREATE TABLE IF NOT EXISTS edit (key TEXT PRIMARY KEY, data TEXT NOT NULL, sig BLOB)')
if (!(db.prepare('PRAGMA table_info(edit)').all() as { name: string }[]).some((c) => c.name === 'sig')) {
  db.exec('ALTER TABLE edit ADD COLUMN sig BLOB')
  db.exec(`UPDATE edit SET sig = (SELECT sig FROM file WHERE bytes || ':' || name = edit.key AND sig IS NOT NULL LIMIT 1)`)
}
db.exec('CREATE TABLE IF NOT EXISTS profile (kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (kind, key))')

export type ProfileKind = 'creator' | 'project'

export function readProfiles(kind: ProfileKind): Record<string, Profile> {
  const rows = db.prepare('SELECT key, data FROM profile WHERE kind = ?').all(kind) as { key: string; data: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.data)]))
}

export function writeProfile(kind: ProfileKind, key: string, patch: Record<string, string | null>): void {
  const current = readProfiles(kind)[key] ?? {}
  // A field left out stays as it is; an empty one clears it.
  const given = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  const next = Object.fromEntries(Object.entries({ ...current, ...given }).filter(([, v]) => v))
  if (Object.keys(next).length) {
    db.prepare('INSERT INTO profile (kind, key, data) VALUES (?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET data = excluded.data').run(kind, key, JSON.stringify(next))
  } else {
    db.prepare('DELETE FROM profile WHERE kind = ? AND key = ?').run(kind, key)
  }
}

export function deleteProfile(kind: ProfileKind, key: string): void {
  db.prepare('DELETE FROM profile WHERE kind = ? AND key = ?').run(kind, key)
}

/** Carries a profile to a new place; one already there wins, since moving onto it is a merge. */
export function moveProfile(fromKind: ProfileKind, from: string, toKind: ProfileKind, to: string): void {
  if (fromKind === toKind && from === to) return
  db.prepare('UPDATE OR IGNORE profile SET kind = ?, key = ? WHERE kind = ? AND key = ?').run(toKind, to, fromKind, from)
  deleteProfile(fromKind, from)
}

/** Edits follow a file's name and size, so they outlive moving it or rebuilding its row. Renames: see `followRenames`. */
export const editKey = (f: Pick<FileRow, 'name' | 'bytes'>) => `${f.bytes}:${f.name}`

export function readEdits(): Map<string, MapEdit> {
  const rows = db.prepare('SELECT key, data FROM edit').all() as { key: string; data: string }[]
  return new Map(rows.map((r) => [r.key, JSON.parse(r.data)]))
}

type EditTarget = Pick<FileRow, 'name' | 'bytes' | 'sig'>

export function writeEdit(file: EditTarget, patch: MapEdit): void {
  const key = editKey(file)
  const current = readEdits().get(key) ?? {}
  const next = Object.fromEntries(Object.entries({ ...current, ...patch }).filter(([, v]) => v !== null && v !== undefined))
  if (Object.keys(next).length) {
    db.prepare('INSERT INTO edit (key, data, sig) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data, sig = COALESCE(excluded.sig, sig)').run(key, JSON.stringify(next), file.sig)
  } else {
    db.prepare('DELETE FROM edit WHERE key = ?').run(key)
  }
}

export const readEditLooks = () => db.prepare('SELECT key, sig FROM edit').all() as { key: string; sig: Uint8Array | null }[]

export function moveEdit(from: string, to: string): void {
  db.prepare('UPDATE edit SET key = ? WHERE key = ?').run(to, from)
}

// Favourite and hidden used to sit on the file row, which a moved file or a removed folder loses.
if (columns.has('hidden')) {
  transaction(() => {
    for (const mark of ['favorite', 'hidden']) {
      const files = db.prepare(`SELECT name, bytes, sig FROM file WHERE ${mark} = 1`).all() as unknown as EditTarget[]
      for (const file of files) writeEdit(file, { [mark]: true })
      db.exec(`ALTER TABLE file DROP COLUMN ${mark}`)
    }
  })
}

/** Marks every file of the scene. One hidden file hides its scene, so a new variant needs no mark. */
export function hideScene(groupId: number | null, hidden: boolean): void {
  const files = db.prepare('SELECT name, bytes, sig FROM file WHERE group_id = ?').all(groupId) as unknown as EditTarget[]
  transaction(() => {
    for (const file of files) writeEdit(file, { hidden: hidden || null })
  })
}

export interface FileRow {
  id: number
  root_id: number
  path: string
  entry: string
  kind: 'image' | 'vtt'
  bytes: number
  mtime: number
  rel: string
  name: string
  creator: string
  pack: string
  status: 'pending' | 'ok' | 'failed' | 'sidecar'
  error: string | null
  format: string | null
  width: number
  height: number
  ink: number
  color: string
  colors: string
  sig: Uint8Array | null
  period_x: number | null
  period_y: number | null
  phase_x: number | null
  phase_y: number | null
  has_grid: number
  labelled: number
  time: string
  weather: string
  biomes: string
  name_cols: number | null
  name_rows: number | null
  name_ppi: number | null
  vtt_path: string | null
  vtt_entry: string | null
  vtt_cols: number | null
  vtt_rows: number | null
  walls: number
  lights: number
  user_cols: number | null
  user_rows: number | null
  user_offset_x: number | null
  user_offset_y: number | null
  cols: number
  rows: number
  offset_x: number
  offset_y: number
  grid_source: GridSource
  group_id: number | null
  variant: string
  variant_kind: VariantKind
  variant_order: number
  hex_size: number | null
  hex_pointy: number | null
  tile_period: number | null
  user_grid_type: GridType | null
  grid_type: GridType
  tags: string | null
  edited: number
}

export function getFile(id: number): FileRow | undefined {
  return db.prepare('SELECT * FROM file WHERE id = ?').get(id) as FileRow | undefined
}

export function transaction<T>(work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function toRecord(f: FileRow, edit: MapEdit = {}): MapRecord {
  return {
    id: f.id,
    name: f.name,
    rel: f.rel,
    creator: f.creator,
    pack: f.pack,
    format: f.format ?? '',
    bytes: f.bytes,
    width: f.width,
    height: f.height,
    ppsX: f.width / f.cols,
    ppsY: f.height / f.rows,
    offsetX: f.offset_x,
    offsetY: f.offset_y,
    gridSource: f.grid_source,
    gridType: f.grid_type,
    edited: !!f.edited,
    hasGrid: !!f.has_grid,
    labelled: !!f.labelled,
    groupId: f.group_id ?? 0,
    variant: f.variant,
    variantKind: f.variant_kind,
    ink: f.ink,
    color: f.color,
    colors: JSON.parse(f.colors),
    time: f.time,
    weather: f.weather,
    biomes: JSON.parse(f.tags ?? f.biomes),
    walls: f.walls,
    lights: f.lights,
    favorite: !!edit.favorite,
    hidden: !!edit.hidden,
    mtime: f.mtime,
  }
}

export function readLibrary(): Library {
  const rows = db.prepare(`SELECT * FROM file WHERE status = 'ok' AND group_id IS NOT NULL ORDER BY variant_order, variant, id`).all() as unknown as FileRow[]
  const edits = readEdits()
  const maps = rows.map((f) => toRecord(f, edits.get(editKey(f))))
  const hiddenScenes = new Set(maps.filter((m) => m.hidden).map((m) => m.groupId))
  for (const m of maps) m.hidden = hiddenScenes.has(m.groupId)
  const members = new Map<number, number[]>()
  for (const m of maps) {
    const list = members.get(m.groupId)
    if (list) list.push(m.id)
    else members.set(m.groupId, [m.id])
  }
  const groups = (db.prepare('SELECT * FROM grp').all() as unknown as { id: number; title: string; creator: string; pack: string; cover_id: number }[])
    .filter((g) => members.has(g.id))
    .map((g): MapGroup => ({ id: g.id, title: g.title, creator: g.creator, pack: g.pack, coverId: g.cover_id, mapIds: members.get(g.id)! }))
  return { maps, groups, creators: readProfiles('creator'), projects: readProfiles('project') }
}

let revision = 0

/** Call after any change visible in the library. */
export function markChanged(): void {
  revision++
}

const started = Date.now()

export const libraryVersion = () => `${started}-${revision}`
