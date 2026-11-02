import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import yauzl from 'yauzl'
import { CACHE_BYTES, DATA_DIR } from './config.ts'

const CACHE_DIR = join(DATA_DIR, 'cache')
const MAX_ENTRY_BYTES = 8 * 1024 * 1024 * 1024

export interface ZipEntry {
  name: string
  bytes: number
  mtime: number
}

export interface Source {
  path: string
  entry: string
  kind: 'image' | 'vtt'
  mtime: number
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: false }, (error, zip) => (error ? reject(error) : resolve(zip)))
  })
}

export async function listZip(path: string): Promise<ZipEntry[]> {
  const zip = await openZip(path)
  try {
    return await new Promise((resolve, reject) => {
      const entries: ZipEntry[] = []
      zip.on('error', reject)
      zip.on('end', () => resolve(entries))
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entryName(entry)
        if (!name.endsWith('/')) {
          entries.push({ name, bytes: entry.uncompressedSize, mtime: entry.getLastModDate().getTime() })
        }
        zip.readEntry()
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Mac and many Windows tools write UTF-8 names without setting the zip flag that says so. */
function entryName(entry: yauzl.Entry): string {
  const raw = entry.fileName as unknown as Buffer
  try {
    return UTF8.decode(raw)
  } catch {
    return raw.toString('latin1')
  }
}

async function extractEntry(path: string, name: string, target: string): Promise<void> {
  const zip = await openZip(path)
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject)
      zip.on('end', () => reject(new Error(`${name} is not in ${path}`)))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entryName(entry) !== name) return zip.readEntry()
        if (entry.uncompressedSize > MAX_ENTRY_BYTES) return reject(new Error(`${name} is too large to unpack`))
        zip.openReadStream(entry, { decodeStrings: false } as yauzl.ZipFileOptions, (error, stream) => {
          if (error) return reject(error)
          pipeline(stream as Readable, createWriteStream(target)).then(resolve, reject)
        })
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

export function cachePath(key: string, ext: string): string {
  return join(CACHE_DIR, `${createHash('sha1').update(key).digest('hex')}${ext}`)
}

const inFlight = new Map<string, Promise<string>>()

/** Runs `build` to create `target` once, even when requested concurrently, and reuses it after. */
export function cached(target: string, build: (temp: string) => Promise<void>): Promise<string> {
  const running = inFlight.get(target)
  if (running) return running
  const work = (async () => {
    await mkdir(CACHE_DIR, { recursive: true })
    const hit = await stat(target).catch(() => null)
    const now = new Date()
    if (hit) {
      await utimes(target, now, now)
      return target
    }
    // Keeps the suffix: sharp picks its output format from it.
    const temp = target.replace(/([^/]+)$/, 'tmp-$1')
    try {
      await build(temp)
      await rename(temp, target)
    } catch (error) {
      await rm(temp, { force: true })
      throw error
    }
    await pruneCache(target)
    return target
  })().finally(() => inFlight.delete(target))
  inFlight.set(target, work)
  return work
}

async function pruneCache(keep: string): Promise<void> {
  const names = await readdir(CACHE_DIR)
  const files = await Promise.all(names.map(async (name) => {
    const path = join(CACHE_DIR, name)
    const info = await stat(path).catch(() => null)
    return info ? { path, size: info.size, used: info.mtimeMs } : null
  }))
  const live = files.filter((f) => f !== null).sort((a, b) => b.used - a.used)
  let total = 0
  for (const file of live) {
    total += file.size
    if (total > CACHE_BYTES && file.path !== keep && !inFlight.has(file.path) && !/\/tmp-/.test(file.path)) {
      await rm(file.path, { force: true })
    }
  }
}

/** A process stopped mid-write leaves partial files behind; nothing else ever removes them. */
export async function clearPartialFiles(): Promise<void> {
  const names = await readdir(CACHE_DIR).catch(() => [])
  await Promise.all(names.filter((n) => n.startsWith('tmp-')).map((n) => rm(join(CACHE_DIR, n), { force: true })))
}

async function plainFile(src: Pick<Source, 'path' | 'entry' | 'mtime'>): Promise<string> {
  if (!src.entry) return src.path
  return cached(cachePath(`entry|${src.path}|${src.entry}|${src.mtime}`, '.bin'), (temp) => extractEntry(src.path, src.entry, temp))
}

export interface VttData {
  format?: number
  resolution: { map_origin?: { x: number; y: number }; map_size: { x: number; y: number }; pixels_per_grid: number }
  line_of_sight?: unknown[]
  objects_line_of_sight?: unknown[]
  portals?: unknown[]
  lights?: unknown[]
  environment?: unknown
  image?: string
}

export async function readVtt(src: Pick<Source, 'path' | 'entry' | 'mtime'>): Promise<VttData> {
  const data = JSON.parse(await readFile(await plainFile(src), 'utf8')) as VttData
  if (!data.resolution?.map_size?.x || !data.resolution.map_size.y) throw new Error('Not a Universal VTT file')
  return data
}

/** A path sharp can open: the file itself, or a cached copy of what is inside a zip or VTT file. */
export function localImage(src: Source): Promise<string> {
  if (src.kind === 'image') return plainFile(src)
  return cached(cachePath(`vtt-image|${src.path}|${src.entry}|${src.mtime}`, '.bin'), async (temp) => {
    const { image } = await readVtt(src)
    if (!image) throw new Error('VTT file has no embedded image')
    await writeFile(temp, Buffer.from(image, 'base64'))
  })
}

export { createReadStream }
