import { useMemo, useState } from 'react'
import { ChevronRight, FolderTree } from 'lucide-react'
import { leafName, parentPath, SEPARATOR } from '../../shared/tree.ts'
import type { MapGroup } from '../../shared/types.ts'
import { Hint } from '@/components/controls'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { scopeHash, type Scope } from '../scope.ts'

interface Branch {
  creator: string
  count: number
  projects: Map<string, number>
}

function treeOf(groups: MapGroup[]): Branch[] {
  const branches = new Map<string, Branch>()
  for (const g of groups) {
    const branch = branches.get(g.creator) ?? { creator: g.creator, count: 0, projects: new Map() }
    branches.set(g.creator, branch)
    branch.count++
    for (let path = g.pack; path; path = parentPath(path)) branch.projects.set(path, (branch.projects.get(path) ?? 0) + 1)
  }
  return [...branches.values()].sort((a, b) => a.creator.localeCompare(b.creator))
}

const ROW = 'flex min-h-(--control-sm) min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-2 text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring aria-[current=page]:text-primary'

function Row({ href, label, count, current, onPick }: { href: string; label: string; count?: number; current: string; onPick: () => void }) {
  return (
    <a href={href} className={ROW} aria-current={href === current ? 'page' : undefined} onClick={onPick}>
      <span className="truncate">{label}</span>
      {count !== undefined && <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{count}</span>}
    </a>
  )
}

/** Creator › Project with scene counts, out of the way until asked for. */
export function BrowseSheet({ groups, scope }: { groups: MapGroup[]; scope: Scope }) {
  const [open, setOpen] = useState(false)
  const tree = useMemo(() => (open ? treeOf(groups) : []), [groups, open])
  const current = scopeHash(scope)
  const close = () => setOpen(false)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Hint label="Browse">
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Browse creators and projects"><FolderTree /></Button>
        </SheetTrigger>
      </Hint>
      <SheetContent side="left" className="gap-0 data-[side=left]:w-full data-[side=left]:sm:max-w-sm" aria-describedby={undefined}>
        <SheetHeader><SheetTitle>Browse</SheetTitle></SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <nav aria-label="Creators and projects" className="flex flex-col gap-1 p-(--gutter)">
            <Row href="#/" label="Library" count={groups.length} current={current} onPick={close} />
            <Row href="#/organize" label="Organise" current={current} onPick={close} />
            {tree.map((branch) => {
              const projects = [...branch.projects.entries()].sort(([a], [b]) => a.localeCompare(b))
              const rows = projects.map(([project, count]) => {
                const href = scopeHash({ creator: branch.creator, project })
                return (
                  <div key={project} style={{ paddingLeft: `${project.split(SEPARATOR).length - 1}rem` }}>
                    <Row href={href} label={leafName(project)} count={count} current={current} onPick={close} />
                  </div>
                )
              })
              if (!branch.creator) return rows
              return (
                <Collapsible key={branch.creator} defaultOpen={scope.creator === branch.creator}>
                  <div className="flex items-center">
                    {projects.length > 0 ? (
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="icon-xs" aria-label={`Projects of ${branch.creator}`} className="group/branch mr-1 text-muted-foreground">
                          <ChevronRight className="transition-transform group-data-[state=open]/branch:rotate-90" />
                        </Button>
                      </CollapsibleTrigger>
                    ) : <span className="mr-1 size-6" />}
                    <Row href={scopeHash({ creator: branch.creator })} label={branch.creator} count={branch.count} current={current} onPick={close} />
                  </div>
                  <CollapsibleContent className="flex flex-col gap-1 pt-1 pl-7">{rows}</CollapsibleContent>
                </Collapsible>
              )
            })}
          </nav>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
