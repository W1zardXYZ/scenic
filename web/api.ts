import type { FailedFile, Library, MapEdit, MapRecord, ScanStatus } from '../shared/types.ts'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status})`)
  return body as T
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
})

export const api = {
  library: () => json<Library>('/api/library'),
  status: () => json<ScanStatus>('/api/status'),
  failed: () => json<FailedFile[]>('/api/failed'),
  scan: () => json('/api/scan', send('POST')),
  browse: (path?: string) =>
    json<{ path: string; parent: string | null; dirs: string[] }>(`/api/browse?path=${encodeURIComponent(path ?? '')}`),
  addRoot: (path: string) => json('/api/roots', send('POST', { path })),
  removeRoot: (id: number) => json(`/api/roots/${id}`, send('DELETE')),
  patchMap: (id: number, patch: object) => json(`/api/maps/${id}`, send('PATCH', patch)),
  edit: (ids: number[], patch: MapEdit) => json('/api/edits', send('POST', { ids, patch })),
  profile: (body: { kind: 'creator' | 'project'; creator: string; project?: string; patch: Record<string, string | null> }) => json('/api/profiles', send('POST', body)),
  tree: (body: object) => json<{ flattened?: number }>('/api/tree', send('POST', body)),
  uploadImage: (file: File) => json<{ id: string; color: string }>('/api/profile-image', { method: 'POST', body: file }),
}

export const profileImage = (id: string) => `/profile/${id}`

export const fullImage = (m: Pick<MapRecord, 'id' | 'mtime'>) => `/api/maps/${m.id}/full?v=${Math.round(m.mtime)}`

export const thumb = (m: Pick<MapRecord, 'id' | 'mtime'>, size: 'small' | 'large') => `/thumb/${m.id}/${size}?v=${Math.round(m.mtime)}`

/** Runs a print job, reporting progress, and resolves with the finished file's URL. */
export interface PrintFile {
  part: 'overview' | 'sheets' | 'fog' | 'all'
  pages: number
  url: string
}

export async function createPrint(request: object, progress: (done: number, total: number) => void): Promise<PrintFile[]> {
  const response = await fetch('/api/print', send('POST', request))
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error ?? 'The print job was refused')
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) throw new Error('The server stopped before finishing')
    buffer += value
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const message = JSON.parse(line)
      if (message.error) throw new Error(message.error)
      if (message.files) return message.files
      progress(message.done, message.total)
    }
  }
}
