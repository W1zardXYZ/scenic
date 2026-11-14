// Describes and tags scenes with a vision model behind any OpenAI-compatible API:
// OpenRouter with a key, or LM Studio or Ollama on another machine of the network.
// Only each scene's 640 px cover thumbnail is sent; what comes back is stored as
// suggestions and never changes grouping or the user's own edits.

import sharp from 'sharp'
import type { AiSettings, AiStatus } from '../shared/types.ts'
import { db, editKey, type FileRow, markChanged, readEdits, readSetting, transaction, writeSetting } from './db.ts'
import { classify } from './names.ts'
import { afterScan, thumbPath } from './scan.ts'

db.exec('CREATE TABLE IF NOT EXISTS ai (key TEXT PRIMARY KEY, data TEXT NOT NULL)')

interface Stored {
  enabled: boolean
  baseUrl: string
  model: string
  auto: boolean
  apiKey: string
}

export type AiPatch = Partial<Omit<Stored, 'apiKey'>> & { apiKey?: string | null }

const DEFAULTS: Stored = { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: '', auto: false, apiKey: '' }

const stored = (): Stored => ({ ...DEFAULTS, ...((readSetting('ai') as Partial<Stored> | undefined) ?? {}) })

export function aiSettings(): AiSettings {
  const { apiKey, ...rest } = stored()
  return { ...rest, hasKey: !!apiKey }
}

/** A key left out stays as it is; null removes it. */
export function saveAiSettings(patch: AiPatch): AiSettings {
  const next = { ...stored() }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    Object.assign(next, { [field]: field === 'apiKey' ? (value ?? '') : value })
  }
  next.baseUrl = next.baseUrl.trim().replace(/\/+$/, '')
  writeSetting('ai', next)
  prices = null
  return aiSettings()
}

/** A server on this network keeps thumbnails at home; anything else is a hosted API. */
export function leavesNetwork(baseUrl: string): boolean {
  let host = ''
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return true
  }
  const local = /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|::1|f[cd][0-9a-f]*:.*|fe80:.*)$/i
  return !(local.test(host) || host.endsWith('.local') || host.endsWith('.lan') || host.endsWith('.home.arpa') || !host.includes('.'))
}

// Results ----------------------------------------------------------------------

export interface Suggestion {
  description: string
  tags: string[]
}

type Row = (Suggestion & { model: string }) | { error: string; tries: number }

/** A scene that fails this often is left alone, so a model that cannot read it does not cost money forever. */
const MAX_TRIES = 3

function readResults(): Map<string, Row> {
  const rows = db.prepare('SELECT key, data FROM ai').all() as { key: string; data: string }[]
  return new Map(rows.map((r) => [r.key, JSON.parse(r.data)]))
}

const writeResult = (key: string, row: Row) =>
  db.prepare('INSERT INTO ai (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data').run(key, JSON.stringify(row))

/** Suggestions per scene, from whichever of its files was described; keys follow files through moves and rescans. */
export function sceneSuggestions(): Map<number, Suggestion> {
  const results = readResults()
  const files = db.prepare(`SELECT f.group_id, f.name, f.bytes, f.id = g.cover_id AS cover FROM file f JOIN grp g ON g.id = f.group_id
    WHERE f.status = 'ok' AND f.variant_kind != 'overlay' ORDER BY cover DESC`).all() as { group_id: number; name: string; bytes: number }[]
  const out = new Map<number, Suggestion>()
  for (const f of files) {
    const row = results.get(editKey(f))
    if (row && 'description' in row && !out.has(f.group_id)) out.set(f.group_id, { description: row.description, tags: row.tags })
  }
  return out
}

interface Scene {
  id: number
  coverId: number
  coverKey: string
}

/** Scenes whose last attempt failed, with the reason; they are retried up to MAX_TRIES times. */
function failedScenes(): number {
  const results = readResults()
  const described = sceneSuggestions()
  const covers = db.prepare(`SELECT g.id, f.name, f.bytes FROM grp g JOIN file f ON f.id = g.cover_id`).all() as { id: number; name: string; bytes: number }[]
  return covers.filter((c) => !described.has(c.id) && 'tries' in (results.get(editKey(c)) ?? {})).length
}

/** Visible scenes with no description, in library order; hidden scenes cost nothing. */
function waitingScenes(): Scene[] {
  const results = readResults()
  const edits = readEdits()
  const files = db.prepare(`SELECT f.id, f.group_id, f.name, f.bytes, g.cover_id FROM file f JOIN grp g ON g.id = f.group_id
    WHERE f.status = 'ok' AND f.variant_kind != 'overlay' ORDER BY g.title, g.id`).all() as unknown as (Pick<FileRow, 'id' | 'group_id' | 'name' | 'bytes'> & { cover_id: number })[]
  const scenes = new Map<number, { cover: Scene | null; skip: boolean }>()
  for (const f of files) {
    const scene = scenes.get(f.group_id!) ?? { cover: null, skip: false }
    const key = editKey(f)
    const row = results.get(key)
    if (edits.get(key)?.hidden || (row && 'description' in row)) scene.skip = true
    if (f.id === f.cover_id) {
      if (row && 'tries' in row && row.tries >= MAX_TRIES) scene.skip = true
      scene.cover = { id: f.group_id!, coverId: f.id, coverKey: key }
    }
    scenes.set(f.group_id!, scene)
  }
  return [...scenes.values()].filter((s) => !s.skip && s.cover).map((s) => s.cover!)
}

// The model ---------------------------------------------------------------------

const SETTINGS = ['Forest', 'Grassland', 'Mountain', 'Desert', 'Arctic', 'Swamp', 'Coast', 'Water', 'Cave', 'Dungeon', 'Castle', 'Town', 'Temple', 'Arcane']

export const PROMPT = `This is a top-down battle map for a tabletop roleplaying game. Describe it so it can be found by search.
Reply with JSON only, no other text: {"description": "...", "tags": ["...", "..."]}
- description: one sentence of at most 25 words saying what kind of place it is and what stands out on it.
- tags: 3 to 8 short tags in Title Case. Include the kind of place (such as Tavern, Camp, Bridge, Ruins), its terrain, and notable features. For the terrain, use one of these when it fits: ${SETTINGS.join(', ')}.
Describe only what you can see. Do not invent names.`

const MAX_DESCRIPTION = 300
const MAX_TAGS = 10
const MAX_TAG = 40

const MAX_PLAIN = 600

/**
 * Reads the model's answer, tolerating code fences and chatter around the JSON. Small local
 * models often answer with a plain sentence instead; that becomes the description, and its
 * terrain words become the tags.
 */
export function parseReply(content: unknown): Suggestion | null {
  const text = (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('') : '').trim()
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) {
    if (!text || text.length > MAX_PLAIN || /[{}]/.test(text)) return null
    const sentence = /^[\s\S]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text
    return parseReply(JSON.stringify({ description: sentence, tags: [] }))
  }
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  const { description, tags } = (data ?? {}) as { description?: unknown; tags?: unknown }
  if (typeof description !== 'string' || !description.trim() || !Array.isArray(tags)) return null
  const seen = new Set<string>()
  const clean = tags
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, MAX_TAGS)
  const text2 = description.trim().replace(/\s+/g, ' ').slice(0, MAX_DESCRIPTION)
  // A model that only repeats the instructions back has not looked at the map.
  const bare = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, ' ').trim()
  if (bare(text2).split(' ').length >= 5 && bare(PROMPT).includes(bare(text2))) return null
  return { description: text2, tags: clean.length ? clean : classify(text2, '').biomes }
}

const headers = (apiKey: string) => ({ 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) })

/** A failure of the connection rather than of one scene: the run stops and the scenes stay queued. */
class ConnectionError extends Error {}

async function request(url: string, init: RequestInit, timeout: number): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
  } catch (error) {
    const cause = (error as Error).name === 'TimeoutError' ? 'it did not answer in time' : (error as Error).message
    throw new ConnectionError(`Cannot reach ${new URL(url).host}: ${cause}`)
  }
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string } | null
  if (!response.ok) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message
    throw new ConnectionError(`${new URL(url).host} answered ${response.status}${message ? `: ${message}` : ''}`)
  }
  return body
}

async function describe(scene: Scene, s: Stored): Promise<void> {
  let image: Buffer
  try {
    image = await sharp(thumbPath(scene.coverId, 'small')).jpeg({ quality: 82 }).toBuffer()
  } catch {
    return fail(scene.coverKey, 'The cover has no thumbnail')
  }
  const body = await request(`${s.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(s.apiKey),
    body: JSON.stringify({
      model: s.model,
      temperature: 0.2,
      // Room for models that reason before answering; others stop after about 150 tokens.
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
        ],
      }],
    }),
  }, 180_000) as { choices?: { message?: { content?: unknown } }[] }
  const suggestion = parseReply(body?.choices?.[0]?.message?.content)
  if (!suggestion) return fail(scene.coverKey, 'The reply was not the expected JSON')
  writeResult(scene.coverKey, { ...suggestion, model: s.model })
  markChanged()
}

function fail(key: string, error: string): void {
  const row = readResults().get(key)
  writeResult(key, { error, tries: (row && 'tries' in row ? row.tries : 0) + 1 })
}

// Prices --------------------------------------------------------------------------

// A 640 px image is about 500–800 tokens for current vision models; the prompt and reply add the rest.
const IMAGE_TOKENS = 800
const PROMPT_TOKENS = 250
const REPLY_TOKENS = 150

interface ModelInfo {
  id: string
  name: string
  /** Estimated US dollars per scene; null without published prices. */
  perScene: number | null
  vision: boolean
}

let prices: { at: number; models: ModelInfo[] } | null = null
const PRICE_TTL = 60 * 60_000

/** The models an API offers. OpenRouter publishes prices and input types; local servers list names only. */
export async function listModels(baseUrl: string = stored().baseUrl, apiKey: string = stored().apiKey): Promise<ModelInfo[]> {
  const body = await request(`${baseUrl}/models`, { headers: headers(apiKey) }, 15_000) as { data?: unknown[] }
  return (body?.data ?? []).flatMap((entry) => {
    const m = entry as { id?: unknown; name?: unknown; pricing?: Record<string, unknown>; architecture?: { input_modalities?: unknown } }
    if (typeof m.id !== 'string') return []
    const price = (k: string) => Number(m.pricing?.[k] ?? 0) || 0
    const perScene = m.pricing
      ? price('prompt') * (IMAGE_TOKENS + PROMPT_TOKENS) + price('completion') * REPLY_TOKENS + price('image') + price('request')
      : null
    const inputs = m.architecture?.input_modalities
    return [{ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, perScene, vision: Array.isArray(inputs) ? inputs.includes('image') : true }]
  })
}

async function perScene(s: Stored): Promise<number | null> {
  if (!prices || Date.now() - prices.at > PRICE_TTL) {
    prices = { at: Date.now(), models: await listModels(s.baseUrl, s.apiKey).catch(() => []) }
  }
  return prices.models.find((m) => m.id === s.model)?.perScene ?? null
}

// Runs ------------------------------------------------------------------------------

const run = { running: false, done: 0, total: 0, error: '', stop: false }

export async function aiStatus(): Promise<AiStatus> {
  const s = stored()
  const waiting = waitingScenes().length
  const away = leavesNetwork(s.baseUrl)
  const each = s.model && away ? await perScene(s) : away ? null : 0
  return {
    running: run.running,
    done: run.done,
    total: run.total,
    error: run.error,
    waiting,
    described: sceneSuggestions().size,
    failed: failedScenes(),
    leavesNetwork: away,
    estimate: each === null ? null : each * waiting,
  }
}

/** Describes every waiting scene, one at a time so a scan or a print is never starved. */
export async function startAi(): Promise<void> {
  const s = stored()
  if (run.running || !s.enabled || !s.baseUrl || !s.model) return
  const queue = waitingScenes()
  Object.assign(run, { running: true, done: 0, total: queue.length, error: '', stop: false })
  try {
    for (const scene of queue) {
      if (run.stop) break
      await describe(scene, s)
      run.done++
    }
  } catch (error) {
    run.error = error instanceof ConnectionError ? error.message : `Stopped: ${(error as Error).message}`
    if (!(error instanceof ConnectionError)) console.error('AI tagging failed:', error)
  } finally {
    run.running = false
  }
}

export const stopAi = () => void (run.stop = true)

/** Forgets every suggestion, so the next run describes the library again, for example with a better model. */
export function clearSuggestions(): void {
  transaction(() => db.exec('DELETE FROM ai'))
  markChanged()
}

afterScan.push(() => {
  const s = stored()
  if (s.enabled && s.auto) void startAi()
})
