import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import sharp from 'sharp'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { basicAuth } from 'hono/basic-auth'
import { bodyLimit } from 'hono/body-limit'
import { compress } from 'hono/compress'
import { HTTPException } from 'hono/http-exception'
import { PIXEL_LIMIT } from './analyze.ts'
import { BROWSE_ROOT, DATA_DIR, PASSWORD, PORT } from './config.ts'
import { isWithin } from '../shared/tree.ts'
import { projectKey } from '../shared/types.ts'
import type { GridType, MapEdit } from '../shared/types.ts'
import { db, getFile, hideScene, libraryVersion, markChanged, type ProfileKind, readLibrary, writeEdit, writeProfile } from './db.ts'
import { exportMap, exportName, exportZip, type ExportFormat, FORMATS, safeName } from './export.ts'
import { generate, type PrintRequest, validatePrint } from './print.ts'
import { applyEdit, dissolveNode, failedFiles, flattenSingles, moveInto, moveNode, regroup, type TreeNode, saveGrid, scanStatus, startSchedule, startScan, thumbPath } from './scan.ts'
import { cached, cachePath, clearPartialFiles, localImage } from './source.ts'

const GRID_TYPES: GridType[] = ['square', 'hex', 'hexPointy']

const app = new Hono()

if (PASSWORD) app.use('*', basicAuth({ username: 'scenic', password: PASSWORD }))
app.use('/api/*', bodyLimit({ maxSize: 8 * 1024 * 1024 }))
app.use('/api/library', compress())

const toWeb = (stream: Readable) => Readable.toWeb(stream) as unknown as ReadableStream
const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
const mapFile = (id: string) => {
  const file = getFile(Number(id))
  return file?.status === 'ok' ? file : undefined
}

app.get('/api/library', (c) => {
  const etag = `"${libraryVersion()}"`
  if (c.req.header('if-none-match') === etag) return c.body(null, 304)
  c.header('etag', etag)
  return c.json(readLibrary())
})

app.get('/api/status', (c) => c.json(scanStatus()))
app.get('/api/failed', (c) => c.json(failedFiles()))

app.post('/api/scan', (c) => {
  void startScan()
  return c.json({ ok: true })
})

const inBrowseRoot = (path: string) => {
  const rel = relative(BROWSE_ROOT, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

app.get('/api/browse', async (c) => {
  const path = resolve(c.req.query('path') || BROWSE_ROOT)
  if (!inBrowseRoot(path)) return c.json({ error: 'Outside the allowed folder' }, 403)
  const entries = await readdir(path, { withFileTypes: true }).catch(() => null)
  if (!entries) return c.json({ error: 'Cannot read this folder' }, 404)
  return c.json({
    path,
    parent: path === BROWSE_ROOT ? null : resolve(path, '..'),
    dirs: entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b)),
  })
})

app.post('/api/roots', async (c) => {
  const { path } = await c.req.json<{ path: string }>()
  if (typeof path !== 'string') return c.json({ error: 'Path required' }, 400)
  const target = resolve(path)
  if (!inBrowseRoot(target)) return c.json({ error: 'Outside the allowed folder' }, 403)
  if (!(await stat(target).catch(() => null))?.isDirectory()) return c.json({ error: 'Not a folder' }, 400)
  db.prepare('INSERT OR IGNORE INTO root (path) VALUES (?)').run(target)
  void startScan()
  return c.json({ ok: true })
})

app.delete('/api/roots/:id', (c) => {
  db.prepare('DELETE FROM root WHERE id = ?').run(Number(c.req.param('id')))
  regroup()
  return c.json({ ok: true })
})

app.get('/thumb/:id/:size', async (c) => {
  const size = c.req.param('size') === 'large' ? 'large' : 'small'
  const path = thumbPath(Number(c.req.param('id')), size)
  if (!existsSync(path)) return c.notFound()
  c.header('content-type', 'image/webp')
  c.header('cache-control', 'public, max-age=604800')
  return c.body(toWeb(createReadStream(path)))
})

app.patch('/api/maps/:id', async (c) => {
  const file = mapFile(c.req.param('id'))
  if (!file) return c.notFound()
  const body = await c.req.json<{
    favorite?: boolean
    hidden?: boolean
    grid?: { cols: number; rows: number; offsetX: number; offsetY: number; type?: GridType } | null
  }>()
  if (body.favorite !== undefined) writeEdit(file, { favorite: body.favorite || null })
  if (body.hidden !== undefined) hideScene(file.group_id, body.hidden)
  if (body.grid !== undefined) {
    const g = body.grid
    const valid = g === null || (g.cols > 0 && g.rows > 0 && Number.isFinite(g.offsetX) && Number.isFinite(g.offsetY))
    if (!valid || (g?.type && !GRID_TYPES.includes(g.type))) return c.json({ error: 'Invalid grid' }, 400)
    saveGrid(file.id, g)
  }
  markChanged()
  return c.json({ ok: true })
})

const validEdit = (e: MapEdit) => {
  const text = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.length <= 200)
  return text(e.scene) && text(e.variant) && text(e.creator) && text(e.pack) &&
    (e.kind == null || ['level', 'lighting', 'weather', 'labels', 'other'].includes(e.kind)) &&
    (e.order == null || Number.isFinite(e.order)) &&
    (e.favorite == null || typeof e.favorite === 'boolean') &&
    (e.hidden == null || typeof e.hidden === 'boolean') &&
    (e.tags == null || (Array.isArray(e.tags) && e.tags.length <= 50 && e.tags.every((t) => typeof t === 'string' && t.length <= 60)))
}

app.post('/api/edits', async (c) => {
  const { ids, patch } = await c.req.json<{ ids: number[]; patch: MapEdit }>()
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || !ids.every(Number.isInteger) || !patch || !validEdit(patch)) {
    return c.json({ error: 'Invalid edit' }, 400)
  }
  applyEdit(ids, patch)
  return c.json({ ok: true })
})

const PROFILE_DIR = join(DATA_DIR, 'profile')
const IMAGE_ID = /^[0-9a-f]{40}$/
const HEX = /^#[0-9a-f]{6}$/i
const toHex = ({ r, g, b }: { r: number; g: number; b: number }) => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`

/** Uploads are always re-encoded, so only a real image ever lands in the data folder. */
app.post('/api/profile-image', async (c) => {
  const input = Buffer.from(await c.req.arrayBuffer())
  try {
    const image = await sharp(input, { limitInputPixels: PIXEL_LIMIT }).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 84 }).toBuffer()
    const { dominant } = await sharp(image).stats()
    const id = createHash('sha1').update(image).digest('hex')
    await mkdir(PROFILE_DIR, { recursive: true })
    await sharp(image).toFile(join(PROFILE_DIR, `${id}.webp`))
    return c.json({ id, color: toHex(dominant) })
  } catch {
    return c.json({ error: 'That file is not an image Scenic can read' }, 400)
  }
})

app.get('/profile/:id', (c) => {
  const id = c.req.param('id')
  const path = join(PROFILE_DIR, `${id}.webp`)
  if (!IMAGE_ID.test(id) || !existsSync(path)) return c.notFound()
  c.header('content-type', 'image/webp')
  c.header('cache-control', 'public, max-age=31536000, immutable')
  return c.body(toWeb(createReadStream(path)))
})

const validLink = (v: unknown) => {
  if (v === null || v === undefined || v === '') return true
  if (typeof v !== 'string' || v.length > 500) return false
  try {
    return ['http:', 'https:'].includes(new URL(v).protocol)
  } catch {
    return false
  }
}
const validField = (v: unknown, pattern: RegExp) => v === null || v === undefined || v === '' || (typeof v === 'string' && pattern.test(v))

app.post('/api/profiles', async (c) => {
  const { kind, creator, project, patch } = await c.req.json<{ kind: ProfileKind; creator: string; project?: string; patch: Record<string, string | null> }>()
  const valid = (kind === 'creator' || kind === 'project') && typeof creator === 'string' && patch && typeof patch === 'object' &&
    (kind === 'creator' || typeof project === 'string') &&
    validLink(patch.site) && validLink(patch.patreon) &&
    validField(patch.color, HEX) && validField(patch.avatarColor, HEX) && validField(patch.bannerColor, HEX) &&
    validField(patch.avatar, IMAGE_ID) && validField(patch.banner, IMAGE_ID)
  if (!valid) return c.json({ error: 'Links must start with http:// or https://' }, 400)
  const { site, patreon, color, avatar, avatarColor, banner, bannerColor, asProject, type } = patch
  writeProfile(kind, kind === 'creator' ? creator : projectKey(creator, project!), { site, patreon, color, avatar, avatarColor, banner, bannerColor, asProject: asProject === undefined ? undefined : asProject ? '1' : null, type: type === undefined ? undefined : type === 'adventure' ? type : null } as Record<string, string | null>)
  markChanged()
  return c.json({ ok: true })
})

const validNode = (n: TreeNode) => !!n && typeof n.creator === 'string' && typeof n.path === 'string' && n.creator.length <= 200 && n.path.length <= 1000

app.post('/api/tree', async (c) => {
  const q = await c.req.json<{ op: string; nodes?: TreeNode[]; files?: number[]; into?: TreeNode; from?: TreeNode; to?: TreeNode; node?: TreeNode }>()
  const bad = () => c.json({ error: 'That move is not possible' }, 400)
  if (q.op === 'move') {
    const nodes = q.nodes ?? []
    const files = q.files ?? []
    if (!validNode(q.into!) || !nodes.every(validNode) || !files.every(Number.isInteger)) return bad()
    // A project cannot move inside itself.
    if (nodes.some((n) => n.creator === q.into!.creator && isWithin(q.into!.path, n.path))) return bad()
    moveInto(nodes, files, q.into!)
  } else if (q.op === 'rename') {
    if (!validNode(q.from!) || !validNode(q.to!) || (!q.to!.path && !q.to!.creator.trim())) return bad()
    moveNode(q.from!, q.to!)
  } else if (q.op === 'dissolve') {
    if (!validNode(q.node!) || !q.node!.path) return bad()
    dissolveNode(q.node!)
  } else if (q.op === 'flatten') {
    if (!validNode(q.node!)) return bad()
    return c.json({ ok: true, flattened: flattenSingles(q.node!) })
  } else return bad()
  return c.json({ ok: true })
})

const NATIVE: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' }

/** The full-resolution image for deep zoom; only formats browsers cannot show are converted. */
app.get('/api/maps/:id/full', async (c) => {
  const file = mapFile(c.req.param('id'))
  if (!file) return c.notFound()
  const source = await localImage(file)
  const native = NATIVE[file.format ?? '']
  const path = native
    ? source
    : await cached(cachePath(`full|${file.path}|${file.entry}|${file.mtime}`, '.webp'), async (temp) => {
        await sharp(source, { limitInputPixels: PIXEL_LIMIT }).webp({ quality: 90 }).toFile(temp)
      })
  c.header('content-type', native ?? 'image/webp')
  c.header('cache-control', 'public, max-age=604800')
  return c.body(toWeb(createReadStream(path)))
})

function exportOptions(q: { format?: string; quality?: string; pps?: string }) {
  const format = (q.format ?? 'webp') as ExportFormat
  if (!FORMATS.includes(format)) return null
  return {
    format,
    quality: Math.min(100, Math.max(10, Number(q.quality) || 85)),
    pps: Math.max(0, Number(q.pps) || 0),
  }
}

app.get('/api/maps/:id/export', async (c) => {
  const file = mapFile(c.req.param('id'))
  const options = exportOptions(c.req.query())
  if (!file || !options) return c.json({ error: 'Unknown map or format' }, 404)
  const stream = await exportMap(file, options)
  c.header('content-disposition', attachment(exportName(file, options.format)))
  c.header('content-type', 'application/octet-stream')
  return c.body(toWeb(stream))
})

app.get('/api/export-zip', (c) => {
  const options = exportOptions(c.req.query())
  const files = (c.req.query('ids') ?? '').split(',').map(mapFile).filter((f) => f !== undefined)
  if (!options || !files.length) return c.json({ error: 'Nothing to export' }, 400)
  c.header('content-disposition', attachment(`${safeName(c.req.query('name') || 'Scenic export')}.zip`))
  c.header('content-type', 'application/zip')
  return c.body(toWeb(exportZip(files, options)))
})

/** Streams progress as JSON lines, ending with the finished file's token. */
app.post('/api/print', async (c) => {
  const q = await c.req.json<PrintRequest>()
  const invalid = validatePrint(q)
  if (invalid) return c.json({ error: `Invalid ${invalid}` }, 400)
  const file = mapFile(String(q.mapId))
  if (!file) return c.json({ error: 'Unknown map' }, 404)

  const encoder = new TextEncoder()
  const body = new ReadableStream({
    async start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`))
      try {
        const path = await generate(q, file, (done) => send({ done, total: q.pages.length }))
        send({ url: `/api/print/${basename(path)}?name=${encodeURIComponent(safeName(file.name))}` })
      } catch (error) {
        console.error('Print failed:', error)
        send({ error: String((error as Error).message ?? error) })
      }
      controller.close()
    },
  })
  return c.body(body, 200, { 'content-type': 'application/x-ndjson' })
})

app.get('/api/print/:file', async (c) => {
  const name = c.req.param('file')
  if (!/^[0-9a-f]{40}\.(pdf|zip)$/.test(name)) return c.notFound()
  const path = join(cachePath('', '.x'), '..', name)
  const info = await stat(path).catch(() => null)
  if (!info) return c.notFound()
  const pdf = name.endsWith('.pdf')
  const download = `${c.req.query('name') || 'map'} print.${pdf ? 'pdf' : 'zip'}`
  c.header('content-type', pdf ? 'application/pdf' : 'application/zip')
  c.header('content-length', String(info.size))
  c.header('content-disposition', pdf && !c.req.query('download') ? 'inline' : attachment(download))
  return c.body(toWeb(createReadStream(path)))
})

app.onError((error, c) => {
  if (error instanceof HTTPException) return error.getResponse()
  console.error(error)
  return c.json({ error: 'Something went wrong' }, 500)
})

// Bundles are named by content, but the page naming them must never go stale.
app.use('/*', async (c, next) => {
  await next()
  if (c.res.headers.get('content-type')?.startsWith('text/html')) c.res.headers.set('cache-control', 'no-cache')
})
app.use('/*', serveStatic({ root: './dist' }))
app.get('*', serveStatic({ path: './dist/index.html' }))

serve({ fetch: app.fetch, port: PORT }, ({ port }) => console.log(`Scenic is listening on http://localhost:${port}`))
  .on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EADDRINUSE') throw error
    console.error(`Port ${PORT} is already in use, so Scenic is probably running already. Stop it with: npm run stop`)
    process.exit(1)
  })

// Scan progress is committed per map, so stopping at any moment just resumes on the next start.
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0))

await clearPartialFiles()
startSchedule()
