import { isWithin, leafName, parentPath } from '../shared/tree.ts'
import type { MapGroup } from '../shared/types.ts'

/** Where in Creator › Project the library is. A project's creator may be ''. */
export interface Scope {
  creator?: string
  project?: string
}

const NO_CREATOR = '-'

export function scopeHash({ creator, project }: Scope): string {
  if (project !== undefined) return `#/project/${encodeURIComponent(creator || NO_CREATOR)}/${encodeURIComponent(project)}`
  if (creator !== undefined) return `#/creator/${encodeURIComponent(creator)}`
  return '#/'
}

/** The scope a route names, or null when the route is not a library page. */
export function routeScope([view, a, b]: string[]): Scope | null {
  if (!view) return {}
  if (view === 'creator' && a) return { creator: a }
  if (view === 'project' && a && b) return { creator: a === NO_CREATOR ? '' : a, project: b }
  return null
}

export const sceneScope = (g: MapGroup): Scope =>
  g.pack ? { creator: g.creator, project: g.pack } : g.creator ? { creator: g.creator } : {}

export function parentScope({ creator, project }: Scope): Scope {
  if (project === undefined) return {}
  const parent = parentPath(project)
  if (parent) return { creator, project: parent }
  return creator ? { creator } : {}
}

export const inScope = (g: MapGroup, { creator, project }: Scope) =>
  (creator === undefined || g.creator === creator) && (project === undefined || isWithin(g.pack, project))

export const scopeTitle = ({ creator, project }: Scope) => (project !== undefined ? leafName(project) : creator ?? '')
