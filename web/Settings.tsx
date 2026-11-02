import { useMemo, useState } from 'react'
import { ArrowLeft, FolderOpen, ListTree, Pencil } from 'lucide-react'
import type { Library } from '../shared/types.ts'
import { AppBar } from '@/components/app-bar'
import { IconButton, SwitchRow } from '@/components/controls'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Index, Prefs } from './filters.ts'
import { Avatar } from './library/EntityCards.tsx'
import { EntityDialog } from './library/EntityDialog.tsx'
import { creatorHref, projectHref } from './library/Shelves.tsx'
import { directory, type Entity } from './profiles.ts'

function Row({ entity, href, onEdit }: { entity: Entity; href: string; onEdit: () => void }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <a href={href} className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring">
        {entity.kind === 'creator' && !entity.collection
          ? <span className="rounded-full p-1" style={{ backgroundColor: entity.color }}><Avatar entity={entity} className="size-9 text-xs" /></span>
          : <span className="h-11 w-16 shrink-0 rounded-md bg-cover bg-center" style={{ backgroundColor: entity.color, backgroundImage: entity.banner ? `url(${entity.banner})` : undefined }} />}
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{entity.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {entity.adventure ? 'Adventure · ' : ''}{entity.kind === 'project' && entity.creator ? `${entity.creator} · ` : ''}
            {entity.scenes.length} {entity.scenes.length === 1 ? 'scene' : 'scenes'}
          </span>
        </span>
      </a>
      <IconButton label={`Edit ${entity.name}`} icon={Pencil} onClick={onEdit} />
    </li>
  )
}

export function Settings({ library, index, tab, prefs, setPrefs, onFolders, onChanged }: {
  library: Library
  index: Index
  tab: string
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
  onFolders: () => void
  onChanged: () => void
}) {
  const { creators, everyProject, projects } = useMemo(() => directory(library, index), [library, index])
  const [editing, setEditing] = useState<Entity | null>(null)

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar>
        <IconButton label="Library" icon={ArrowLeft} href="#/" className="-ml-2" />
        <h1 className="text-sm font-medium">Settings</h1>
        <div className="ml-auto flex gap-1">
          <Button variant="ghost" size="sm" asChild><a href="#/organize"><ListTree data-icon="inline-start" />Organise</a></Button>
          <Button variant="ghost" size="sm" onClick={onFolders}><FolderOpen data-icon="inline-start" />Folders</Button>
        </div>
      </AppBar>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-(--gutter) py-4">
        <SwitchRow
          label="Single-key shortcuts"
          hint="Letter and number keys in the print canvas and map view, and / for search"
          checked={prefs.shortcuts}
          onCheckedChange={(shortcuts) => setPrefs({ shortcuts })}
        />
        <Tabs value={tab} onValueChange={(next) => (window.location.hash = `#/settings/${next}`)} className="gap-5">
          <TabsList className="w-full">
            <TabsTrigger value="creators">Creators</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
          </TabsList>
          <TabsContent value="creators">
            <ul>{creators.map((e) => <Row key={e.name} entity={e} href={creatorHref(e)} onEdit={() => setEditing(e)} />)}</ul>
          </TabsContent>
          <TabsContent value="projects">
            <ul>{[...projects.filter((e) => e.kind === 'creator'), ...everyProject].map((e) => <Row key={`${e.kind}/${e.creator}/${e.path}`} entity={e} href={projectHref(e)} onEdit={() => setEditing(e)} />)}</ul>
          </TabsContent>
        </Tabs>
      </main>
      {editing && <EntityDialog entity={editing} creators={creators.map((c) => c.name)} onClose={() => setEditing(null)} onChanged={onChanged} />}
    </div>
  )
}
