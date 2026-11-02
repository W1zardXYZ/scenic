import type { Entity } from '../profiles.ts'
import { scopeHash } from '../scope.ts'
import { CreatorCard, ProjectBanner } from './EntityCards.tsx'

export const creatorHref = (e: Entity) => scopeHash({ creator: e.name })
export const projectHref = (e: Entity) => (e.kind === 'creator' ? creatorHref(e) : scopeHash({ creator: e.creator, project: e.path }))

function Shelf({ title, href, total, shown, children, className }: {
  title: string
  href: string
  total: number
  shown: number
  children: React.ReactNode
  className?: string
}) {
  return (
    <section aria-label={title} className={`flex min-w-0 flex-col gap-3 ${className ?? ''}`}>
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {total > shown && <a href={href} className="touch-target inline-flex min-h-6 items-center text-xs text-muted-foreground hover:text-foreground">View all {total}</a>}
      </header>
      {children}
    </section>
  )
}

const CREATORS = 3
const PROJECTS = 3

export function Shelves({ creators, projects }: { creators: Entity[]; projects: Entity[] }) {
  if (!creators.length && !projects.length) return null
  return (
    <div className="grid gap-8 px-(--gutter) pt-2 pb-10 lg:grid-cols-2">
      {creators.length > 0 && (
        <Shelf title="Creators" href="#/creators" total={creators.length} shown={CREATORS}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {creators.slice(0, CREATORS).map((e) => <CreatorCard key={e.name} entity={e} href={creatorHref(e)} />)}
          </div>
        </Shelf>
      )}
      {projects.length > 0 && (
        <Shelf title="Projects" href="#/projects" total={projects.length} shown={PROJECTS}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {projects.slice(0, PROJECTS).map((e) => <ProjectBanner key={`${e.creator}/${e.path}`} entity={e} href={projectHref(e)} />)}
          </div>
        </Shelf>
      )}
    </div>
  )
}
