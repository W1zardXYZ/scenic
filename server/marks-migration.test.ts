import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

process.env.SCENIC_DATA = mkdtempSync(join(tmpdir(), 'scenic-migration-'))
const old = new DatabaseSync(join(process.env.SCENIC_DATA, 'scenic.db'))
old.exec(`
  CREATE TABLE file (id INTEGER PRIMARY KEY, root_id INTEGER, path TEXT, entry TEXT NOT NULL DEFAULT '', status TEXT, mtime INTEGER, period_x REAL, sig BLOB,
    name TEXT, bytes INTEGER, favorite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
  INSERT INTO file (id, name, bytes, favorite, hidden) VALUES (1, 'Keep', 10, 1, 1), (2, 'Ruins', 20, 0, 1), (3, 'Plain', 30, 0, 0);
`)
old.close()
const { db, readEdits } = await import('./db.ts')

test('marks on old file rows move to the edit table', () => {
  assert.deepEqual(Object.fromEntries(readEdits()), { '10:Keep': { favorite: true, hidden: true }, '20:Ruins': { hidden: true } })
  const columns = (db.prepare('PRAGMA table_info(file)').all() as { name: string }[]).map((c) => c.name)
  assert.ok(!columns.includes('hidden') && !columns.includes('favorite'))
})
