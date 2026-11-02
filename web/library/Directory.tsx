import { ArrowLeft } from 'lucide-react'
import { AppBar } from '@/components/app-bar'
import { IconButton } from '@/components/controls'
import type { Entity } from '../profiles.ts'
import { CreatorCard, ProjectBanner } from './EntityCards.tsx'
import { creatorHref, projectHref } from './Shelves.tsx'

/** The "view all" page behind a home shelf. */
export function Directory({ title, entities }: { title: string; entities: Entity[] }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar>
        <IconButton label="Library" icon={ArrowLeft} href="#/" className="-ml-2" />
        <h1 className="text-sm font-medium">{title}</h1>
      </AppBar>
      <main className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,14rem),1fr))] gap-4 px-(--gutter) py-4">
        {entities.map((e) => (e.kind === 'creator' && !e.collection
          ? <CreatorCard key={e.name} entity={e} href={creatorHref(e)} />
          : <ProjectBanner key={`${e.creator}/${e.path}`} entity={e} href={projectHref(e)} />))}
      </main>
    </div>
  )
}
