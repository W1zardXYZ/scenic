// What the print studio keeps: the working settings of each map, named copies of them,
// and the looks (tone profiles) shared between maps.

import { cleanName, invalidLook, type Look, MAX_LOOKS } from '../shared/look.ts'
import { invalidFilter } from '../shared/tone.ts'
import { db, readSetting, writeSetting } from './db.ts'

// `name` is '' for the working settings, which every change updates; named rows are copies the user made.
// Keys are file keys (see `editKey`), so both follow a map through rescans, moves and renames.
db.exec(`CREATE TABLE IF NOT EXISTS print_state (
  key TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, saved INTEGER NOT NULL, PRIMARY KEY (key, name)
)`)
db.exec('CREATE TABLE IF NOT EXISTS look (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL)')

export const MAX_SAVES = 30
const MAX_STATE_BYTES = 1_000_000

export interface SavedCopy {
  name: string
  saved: number
  settings: unknown
}

/** The browser owns the shape of print settings; the server only keeps them in bounds. */
export function invalidSettings(settings: unknown): string | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'settings'
  if (JSON.stringify(settings).length > MAX_STATE_BYTES) return 'settings size'
  return invalidFilter((settings as { filter?: never }).filter)
}

export function readPrintState(key: string): { working: unknown | null; saves: SavedCopy[] } {
  const rows = db.prepare('SELECT name, data, saved FROM print_state WHERE key = ? ORDER BY saved DESC').all(key) as { name: string; data: string; saved: number }[]
  const working = rows.find((r) => r.name === '')
  return {
    working: working ? JSON.parse(working.data) : null,
    saves: rows.filter((r) => r.name).map((r) => ({ name: r.name, saved: r.saved, settings: JSON.parse(r.data) })),
  }
}

/** Writes the working settings (`name` ''), or a named copy; a copy under a name already used replaces it. Returns false when a new copy would pass the limit. */
export function writePrintState(key: string, name: string, settings: unknown): boolean {
  const exists = db.prepare('SELECT 1 FROM print_state WHERE key = ? AND name = ?').get(key, name)
  if (name && !exists) {
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM print_state WHERE key = ? AND name != ''").get(key) as { n: number }
    if (n >= MAX_SAVES) return false
  }
  db.prepare('INSERT INTO print_state (key, name, data, saved) VALUES (?, ?, ?, ?) ON CONFLICT (key, name) DO UPDATE SET data = excluded.data, saved = excluded.saved')
    .run(key, name, JSON.stringify(settings), Date.now())
  return true
}

export function deletePrintCopy(key: string, name: string): void {
  db.prepare("DELETE FROM print_state WHERE key = ? AND name = ? AND name != ''").run(key, name)
}

/** A map whose file was renamed keeps what was saved for it; anything already saved under the new key wins. */
export function movePrintState(from: string, to: string): void {
  db.prepare('UPDATE OR IGNORE print_state SET key = ? WHERE key = ?').run(to, from)
  db.prepare('DELETE FROM print_state WHERE key = ?').run(from)
}

export interface SavedLook {
  id: number
  name: string
  look: Look
}

const DEFAULT_LOOK = 'defaultLook'

export function readLooks(): { looks: SavedLook[]; defaultId: number | null } {
  const rows = db.prepare('SELECT id, name, data FROM look ORDER BY name').all() as { id: number; name: string; data: string }[]
  const looks = rows.map((r) => ({ id: r.id, name: r.name, look: JSON.parse(r.data) as Look }))
  const chosen = readSetting(DEFAULT_LOOK)
  return { looks, defaultId: looks.some((l) => l.id === chosen) ? (chosen as number) : null }
}

export type LookResult = { id: number } | { error: string; status: 400 | 404 | 409 }

const taken = (name: string, except = 0) => !!db.prepare('SELECT 1 FROM look WHERE name = ? AND id != ?').get(name, except)

export function createLook(rawName: unknown, look: Look): LookResult {
  const name = cleanName(rawName)
  const bad = invalidLook(look)
  if (!name || bad) return { error: bad ? `Invalid ${bad}` : 'A look needs a name', status: 400 }
  if (taken(name)) return { error: `There is already a look called “${name}”`, status: 409 }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM look').get() as { n: number }
  if (n >= MAX_LOOKS) return { error: 'Too many looks; delete one first', status: 400 }
  const { lastInsertRowid } = db.prepare('INSERT INTO look (name, data) VALUES (?, ?)').run(name, JSON.stringify(look))
  return { id: Number(lastInsertRowid) }
}

/** Renames and/or overwrites a look; `isDefault` makes it the look new maps start with, or clears that. */
export function updateLook(id: number, patch: { name?: unknown; look?: Look; isDefault?: boolean }): LookResult {
  if (!db.prepare('SELECT 1 FROM look WHERE id = ?').get(id)) return { error: 'Unknown look', status: 404 }
  if (patch.name !== undefined) {
    const name = cleanName(patch.name)
    if (!name) return { error: 'A look needs a name', status: 400 }
    if (taken(name, id)) return { error: `There is already a look called “${name}”`, status: 409 }
    db.prepare('UPDATE look SET name = ? WHERE id = ?').run(name, id)
  }
  if (patch.look !== undefined) {
    const bad = invalidLook(patch.look)
    if (bad) return { error: `Invalid ${bad}`, status: 400 }
    db.prepare('UPDATE look SET data = ? WHERE id = ?').run(JSON.stringify(patch.look), id)
  }
  if (patch.isDefault === true) writeSetting(DEFAULT_LOOK, id)
  else if (patch.isDefault === false && readSetting(DEFAULT_LOOK) === id) writeSetting(DEFAULT_LOOK, null)
  return { id }
}

export function deleteLook(id: number): void {
  if (readSetting(DEFAULT_LOOK) === id) writeSetting(DEFAULT_LOOK, null)
  db.prepare('DELETE FROM look WHERE id = ?').run(id)
}
