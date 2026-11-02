import { cleanName, isWithin, joinPath, leafName, parentPath, SEPARATOR } from '../shared/tree.ts'
import { type Library, type MapGroup, type MapRecord, type Profile, projectKey } from '../shared/types.ts'
import { api, profileImage, thumb } from './api.ts'
import type { Index } from './filters.ts'

export interface Entity {
  /** How it is stored; `collection` says a creator-level entry is really one big project. */
  kind: 'creator' | 'project'
  collection: boolean
  adventure: boolean
  name: string
  /** The owner of a project, and a creator's own name. */
  creator: string
  /** Where a project sits among nested projects; '' for a creator. */
  path: string
  profile: Profile
  scenes: MapGroup[]
  /** The map its colour and default picture come from. */
  cover: MapRecord | undefined
  color: string
  banner: string
  avatar: string
}

const FALLBACK_COLOR = '#3a3632'

/** A random-looking map that stays the same between visits. */
function coverFor(name: string, scenes: MapGroup[], index: Index): MapRecord | undefined {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return index.byId.get(scenes[Math.abs(hash) % Math.max(1, scenes.length)]?.coverId)
}

/** Chosen colour first, then the uploaded image's, then the art's. */
function describe(kind: Entity['kind'], name: string, creator: string, path: string, profile: Profile, scenes: MapGroup[], index: Index): Entity {
  const cover = coverFor(name, scenes, index)
  return {
    kind, name, creator, path, profile, scenes, cover,
    collection: !!profile.asProject,
    adventure: profile.type === 'adventure',
    color: profile.color ?? profile.bannerColor ?? profile.avatarColor ?? cover?.color ?? FALLBACK_COLOR,
    banner: profile.banner ? profileImage(profile.banner) : cover ? thumb(cover, 'small') : '',
    avatar: profile.avatar ? profileImage(profile.avatar) : '',
  }
}

const relativeLuminance = (color: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(color.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Whichever of black or white reads better on `color`; one of them always reaches 4.5:1. */
export function inkOn(color: string): string {
  const l = relativeLuminance(color)
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000'
}

/** Solid behind the text, then fading out by 65% of the height. */
export const colorFade = (color: string, solid = 30) => `linear-gradient(to top, ${color} ${solid}%, transparent 65%)`

const bySize = (a: Entity, b: Entity) => b.scenes.length - a.scenes.length || a.name.localeCompare(b.name)

export function creatorEntities(library: Library, index: Index): Entity[] {
  const buckets = new Map<string, MapGroup[]>()
  for (const g of library.groups) if (g.creator) buckets.set(g.creator, [...(buckets.get(g.creator) ?? []), g])
  return [...buckets].map(([name, scenes]) => describe('creator', name, name, '', library.creators[name] ?? {}, scenes, index)).sort(bySize)
}

/** Every project at every depth. */
export function projectEntities(library: Library, index: Index): Entity[] {
  const buckets = new Map<string, { creator: string; path: string; scenes: MapGroup[] }>()
  for (const g of library.groups) {
    let path = g.pack
    while (path) {
      const key = projectKey(g.creator, path)
      const bucket = buckets.get(key) ?? { creator: g.creator, path, scenes: [] }
      bucket.scenes.push(g)
      buckets.set(key, bucket)
      path = parentPath(path)
    }
  }
  return [...buckets].map(([key, { creator, path, scenes }]) =>
    describe('project', leafName(path), creator, path, library.projects[key] ?? {}, scenes, index)).sort(bySize)
}

export interface Directory {
  /** Everything creator-level, for looking up the current page. */
  all: Entity[]
  creators: Entity[]
  /** What the Projects row shows: real groupings, not folders around one map. */
  projects: Entity[]
  /** Every project, nested or not. */
  everyProject: Entity[]
}

export function directory(library: Library, index: Index): Directory {
  const all = creatorEntities(library, index)
  const collections = new Set(all.filter((e) => e.collection).map((e) => e.name))
  const everyProject = projectEntities(library, index)
  const worthShowing = (p: Entity) => p.scenes.length > 1 || p.adventure
  return {
    all,
    creators: all.filter((e) => !e.collection),
    projects: [
      ...all.filter((e) => e.collection),
      ...everyProject.filter((p) => !p.path.includes(SEPARATOR) && !collections.has(p.creator) && worthShowing(p)),
    ].sort((a, b) => Number(b.adventure) - Number(a.adventure) || bySize(a, b)),
    everyProject,
  }
}

/** The rule the server enforces, said in a way that tells you how to fix it. */
export function linkProblem(link: string): string {
  if (!link.trim()) return ''
  try {
    if (['http:', 'https:'].includes(new URL(link.trim()).protocol)) return ''
  } catch {
    // Not a URL at all; same advice.
  }
  return 'Start the link with https://'
}

export const openLink = (href: string) => ({ href, target: '_blank', rel: 'noreferrer noopener' })

const nodeOf = (e: Entity) => ({ creator: e.creator, path: e.path })

/** Flips a creator-level entry between person and big project, or lifts a project to creator level. */
export async function convertEntity(entity: Entity): Promise<void> {
  if (entity.kind === 'creator') await api.profile({ kind: 'creator', creator: entity.name, patch: { asProject: entity.collection ? '' : '1' } })
  else await api.tree({ op: 'rename', from: nodeOf(entity), to: { creator: entity.name, path: '' } })
}

export const dissolveEntity = (entity: Entity) => api.tree({ op: 'dissolve', node: nodeOf(entity) })

/** Saves a name change, if any, then the profile at the resulting place. Returns where it ended up. */
export async function saveEntity(entity: Entity, name: string, creator: string, patch: Record<string, string | null>) {
  const trimmed = cleanName(name)
  const owner = creator.trim()
  if (entity.kind === 'creator') {
    if (trimmed !== entity.name) await api.tree({ op: 'rename', from: nodeOf(entity), to: { creator: trimmed, path: '' } })
    await api.profile({ kind: 'creator', creator: trimmed, patch })
    return { creator: trimmed }
  }
  const path = joinPath(parentPath(entity.path), trimmed)
  if (path !== entity.path || owner !== entity.creator) await api.tree({ op: 'rename', from: nodeOf(entity), to: { creator: owner, path } })
  await api.profile({ kind: 'project', creator: owner, project: path, patch })
  return { creator: owner, project: path }
}

export const scenesWithin = (library: Library, creator: string, path: string) =>
  library.groups.filter((g) => g.creator === creator && isWithin(g.pack, path))
