import { cpus } from 'node:os'
import { resolve } from 'node:path'

const number = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const PORT = number('SCENIC_PORT', 8420)
export const DATA_DIR = resolve(process.env.SCENIC_DATA ?? 'data')
/** The folder picker cannot leave this directory. */
export const BROWSE_ROOT = resolve(process.env.SCENIC_BROWSE_ROOT ?? '/')
export const PASSWORD = process.env.SCENIC_PASSWORD ?? ''
export const WORKERS = number('SCENIC_WORKERS', Math.max(1, Math.min(4, cpus().length >> 1)))
export const CACHE_BYTES = number('SCENIC_CACHE_MB', 8192) * 1024 * 1024
export const RESCAN_MS = number('SCENIC_RESCAN_MINUTES', 60) * 60_000
