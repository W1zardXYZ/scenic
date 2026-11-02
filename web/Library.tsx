import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, Compass, ExternalLink, FolderOpen, ListTree, Heart, Map as MapIcon, MoreHorizontal, Pencil, Search, SearchX, Settings as SettingsIcon, X } from 'lucide-react'
import { PAPERS } from '../shared/layout.ts'
import { joinPath, leafName, SEPARATOR } from '../shared/tree.ts'
import type { Library as LibraryData, ScanStatus } from '../shared/types.ts'
import { AppBar } from '@/components/app-bar'
import { Hint, IconButton, IconToggle } from '@/components/controls'
import { Logo } from '@/components/logo'
import { Trail } from '@/components/trail'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useMediaQuery } from '@/hooks/use-media-query'
import { announce } from './announce.ts'
import {
  activeCount, applyFilters, type FacetKey, FACET_KEYS, type Filters, type GroupView, type Index, NO_FILTERS, type Prefs, type Sort,
} from './filters.ts'
import { BrowseSheet } from './library/BrowseSheet.tsx'
import { Avatar } from './library/EntityCards.tsx'
import { EntityDialog } from './library/EntityDialog.tsx'
import { FilterSheet, SWATCHES, TOGGLES } from './library/FilterSheet.tsx'
import { MapCard } from './library/MapCard.tsx'
import { ProjectCard } from './library/ProjectCard.tsx'
import { Shelves } from './library/Shelves.tsx'
import { colorFade, directory, type Entity, inkOn, openLink } from './profiles.ts'
import { inScope, parentScope, type Scope, scopeHash, scopeTitle } from './scope.ts'


const SORTS: [Sort, string][] = [
  ['recent', 'Recently added'], ['title', 'Name'], ['largest', 'Largest'], ['resolution', 'Sharpest print'],
  ['variants', 'Most variants'], ['sheets', 'Fewest sheets'],
]

const GRID = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-x-6 gap-y-8 sm:gap-y-10'

type Entry = GroupView | { key: string; creator: string; path: string; scenes: GroupView[] }

/** A level shows its direct scenes and its sub-projects; a folder around one map needs no extra click. */
function stacked(views: GroupView[], base: string): Entry[] {
  const childOf = ({ group }: GroupView) => {
    const rest = group.pack.slice(base ? base.length + 1 : 0)
    return rest ? joinPath(base, rest.split(SEPARATOR)[0]) : ''
  }
  const keyOf = (view: GroupView) => `${view.group.creator}\0${childOf(view)}`
  const children = new Map<string, GroupView[]>()
  for (const view of views) {
    if (!childOf(view)) continue
    children.set(keyOf(view), [...(children.get(keyOf(view)) ?? []), view])
  }
  const placed = new Set<string>()
  return views.flatMap<Entry>((view) => {
    const scenes = children.get(keyOf(view))
    if (!scenes || scenes.length < 2) return [view]
    if (placed.has(keyOf(view))) return []
    placed.add(keyOf(view))
    return [{ key: keyOf(view), creator: view.group.creator, path: childOf(view), scenes }]
  })
}

function ActiveFilters({ scope, filters, patch, toggle, clear, shown, total, paper }: {
  scope: Scope
  filters: Filters
  patch: (p: Partial<Filters>) => void
  toggle: (key: FacetKey, value: string) => void
  clear: () => void
  shown: number
  total: number
  paper: string
}) {
  const chip = (key: string, label: string, onRemove: () => void, swatch?: string) => (
    <Button key={key} variant="secondary" size="sm" aria-label={`Remove filter ${label}`} onClick={onRemove}>
      {swatch && <span className="size-3 rounded-full ring-1 ring-foreground/15" style={{ backgroundColor: swatch }} />}
      {label}
      <X data-icon="inline-end" />
    </Button>
  )
  return (
    <div className="flex flex-wrap items-center gap-2 px-(--gutter) pb-6">
      <p className="mr-2 text-sm text-muted-foreground tabular-nums">{shown} of {total}</p>
      {scopeTitle(scope) && (
        <Button variant="outline" size="sm" asChild>
          <a href="#/" aria-label={`Search the whole library instead of ${scopeTitle(scope)}`}>In {scopeTitle(scope)}<X data-icon="inline-end" /></a>
        </Button>
      )}
      {TOGGLES.filter((t) => filters[t.key]).map((t) => chip(t.key, t.chip, () => patch({ [t.key]: false })))}
      {filters.maxSheets > 0 && chip('sheets', `Up to ${filters.maxSheets} × ${paper}`, () => patch({ maxSheets: 0 }))}
      {FACET_KEYS.flatMap((key) => (filters.selected[key] ?? []).map((value) =>
        chip(`${key}:${value}`, value, () => toggle(key, value), key === 'color' ? SWATCHES[value] : undefined)))}
      {activeCount(filters) > 0 && <Button variant="link" size="sm" onClick={clear}>Clear all</Button>}
    </div>
  )
}

export function LibrarySkeleton() {
  return (
    <div className={`${GRID} px-(--gutter) pt-[calc(var(--bar)+0.5rem)] pb-16`} aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="aspect-4/3" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  )
}

/** The banner above a creator's or project's page. */
function EntityHero({ entity, parent, onEdit }: { entity: Entity; parent: React.ReactNode; onEdit: () => void }) {
  const { site, patreon } = entity.profile
  return (
    <div className="px-(--gutter) pt-2 pb-6">
      <div className="relative isolate overflow-hidden rounded-lg p-6 pt-28" style={{ backgroundColor: entity.color, color: inkOn(entity.color) }}>
        {entity.banner && <img src={entity.banner} alt="" className="absolute inset-0 -z-10 size-full object-cover" />}
        <span className="absolute inset-0 -z-10" style={{ background: colorFade(entity.color, 62).replace('65%', '100%') }} />
        <div className="flex flex-wrap items-end gap-4">
          {entity.kind === 'creator' && !entity.collection && <Avatar entity={entity} className="size-20 text-2xl" />}
          <div className="min-w-0 flex-1">
            {parent}
            <h1 className="flex items-center gap-2 text-3xl leading-tight font-medium text-balance">
              {entity.adventure && <Compass aria-label="Adventure" className="size-6 shrink-0" />}
              {entity.name}
            </h1>
            <p className="text-sm opacity-80">{entity.scenes.length} {entity.scenes.length === 1 ? 'scene' : 'scenes'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {site && <Button variant="secondary" size="sm" asChild><a {...openLink(site)}><ExternalLink data-icon="inline-start" />Website</a></Button>}
            {patreon && <Button variant="secondary" size="sm" asChild><a {...openLink(patreon)}><ExternalLink data-icon="inline-start" />Patreon</a></Button>}
            <Button variant="secondary" size="sm" onClick={onEdit}><Pencil data-icon="inline-start" />Edit</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Library({ library, index, scope, filters, setFilters, prefs, setPrefs, status, onFolders, onChanged }: {
  library: LibraryData
  index: Index
  scope: Scope
  filters: Filters
  setFilters: React.Dispatch<React.SetStateAction<Filters>>
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
  status: ScanStatus | null
  onFolders: (view: 'list' | 'pick') => void
  onChanged: () => void
}) {
  const deferred = useDeferredValue(filters)
  const result = useMemo(() => applyFilters(library, index, deferred, scope), [library, index, deferred, scope.creator, scope.project]) // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }))
  const toggle = (key: FacetKey, value: string) =>
    setFilters((f) => {
      const current = f.selected[key] ?? []
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value]
      return { ...f, selected: { ...f.selected, [key]: next } }
    })
  const clear = () => setFilters((f) => ({ ...NO_FILTERS, query: f.query, sort: f.sort }))

  const search = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!prefs.shortcuts || e.key !== '/' || e.metaKey || e.ctrlKey || e.defaultPrevented) return
      if ((e.target as Element).closest('input, select, textarea, [role=dialog]')) return
      e.preventDefault()
      search.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prefs.shortcuts])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [scope.creator, scope.project])

  const active = activeCount(filters)
  // Searching or filtering looks through the level; otherwise each level shows its children.
  const searching = active > 0 || !!filters.query.trim()
  const home = scope.creator === undefined && scope.project === undefined
  const flat = searching || home
  const { all: creators, creators: people, projects: topProjects, everyProject } = useMemo(() => directory(library, index), [library, index])
  const entity = scope.project !== undefined
    ? everyProject.find((p) => p.path === scope.project && p.creator === scope.creator)
    : creators.find((c) => c.name === scope.creator)
  const [editing, setEditing] = useState(false)
  const entries = useMemo(() => (flat ? result.groups : stacked(result.groups, scope.project ?? '')), [flat, result.groups, scope.project])
  const scanning = !!status?.running
  const noRoots = status && !status.roots.length
  const total = useMemo(() => library.groups.filter((g) => inScope(g, scope)).length, [library, scope.creator, scope.project]) // eslint-disable-line react-hooks/exhaustive-deps
  const title = scopeTitle(scope)
  const sortLabel = SORTS.find(([value]) => value === filters.sort)?.[1]
  const paper = PAPERS.find((p) => p.id === prefs.paperId)?.label ?? ''
  const fullBar = useMediaQuery('(min-width: 40rem)')
  const sortChoices = (
    <DropdownMenuRadioGroup value={filters.sort} onValueChange={(sort) => patch({ sort: sort as Sort })}>
      {SORTS.map(([value, label]) => <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
  )

  const shown = result.groups.length
  useEffect(() => {
    if (!searching) return
    const timer = setTimeout(() => announce(shown ? `${shown} of ${total} scenes` : 'No matches'), 600)
    return () => clearTimeout(timer)
  }, [searching, filters.query, shown, total])

  return (
    <div className="flex min-h-dvh flex-col">
      {!title && <h1 className="sr-only">Scenic map library</h1>}
      <div className="sticky top-0 z-40 bg-background">
        <AppBar>
          <Logo className="max-sm:hidden sm:mr-5" />
          {!noRoots && (
            <>
              <BrowseSheet groups={library.groups} scope={scope} />
              <InputGroup className="max-w-xl flex-1">
                <InputGroupAddon><Search /></InputGroupAddon>
                <InputGroupInput
                  ref={search}
                  type="search"
                  aria-label="Search maps"
                  placeholder={title ? `Search ${title}` : total ? `Search ${total} ${total === 1 ? 'scene' : 'scenes'}` : 'Search'}
                  value={filters.query}
                  onChange={(e) => patch({ query: e.target.value })}
                  className="[&::-webkit-search-cancel-button]:appearance-none"
                />
                {filters.query && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => patch({ query: '' })}><X /></InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <FilterSheet
                filters={filters}
                patch={patch}
                toggle={toggle}
                facets={result.facets}
                shown={result.groups.length}
                active={active}
                clear={clear}
                prefs={prefs}
                setPrefs={setPrefs}
              />
            </>
          )}
          {fullBar ? (
          <div className="ml-auto flex items-center gap-1">
            {!noRoots && (
              <>
                <IconToggle
                  label="Favourites"
                  icon={Heart}
                  pressed={filters.favorites}
                  onPressedChange={(favorites) => patch({ favorites })}
                  className="on:[&_svg]:fill-current"
                />
                <DropdownMenu>
                  <Hint label={`Sort: ${sortLabel}`}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Sort: ${sortLabel}`}><ArrowDownUp /></Button>
                    </DropdownMenuTrigger>
                  </Hint>
                  <DropdownMenuContent align="end" className="w-48">
                    <DropdownMenuGroup>{sortChoices}</DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            {scanning ? (
              <Hint label={`Indexing ${status.done} of ${status.total}`}>
                <Button variant="ghost" size="icon" aria-label="Folders, indexing" onClick={() => onFolders('list')}><Spinner /></Button>
              </Hint>
            ) : (
              <IconButton label="Folders" icon={FolderOpen} onClick={() => onFolders('list')} />
            )}
            <IconButton label="Organise" icon={ListTree} href="#/organize" />
            <IconButton label="Settings" icon={SettingsIcon} href="#/settings" />
          </div>
          ) : (
            <DropdownMenu>
              <Hint label="More">
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More" className="ml-auto"><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end" className="w-56">
                {!noRoots && (
                  <>
                    <DropdownMenuGroup>
                      <DropdownMenuCheckboxItem checked={filters.favorites} onCheckedChange={(favorites) => patch({ favorites })}>Favourites</DropdownMenuCheckboxItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>Sort</DropdownMenuLabel>
                      {sortChoices}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => onFolders('list')}><FolderOpen />{scanning ? `Folders, indexing ${status.done} of ${status.total}` : 'Folders'}</DropdownMenuItem>
                  <DropdownMenuItem asChild><a href="#/organize"><ListTree />Organise</a></DropdownMenuItem>
                  <DropdownMenuItem asChild><a href="#/settings"><SettingsIcon />Settings</a></DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </AppBar>
        {scanning && (
          <Progress
            aria-label={`Indexing ${status.done} of ${status.total}`}
            value={status.total ? (status.done / status.total) * 100 : 4}
            className="absolute inset-x-0 bottom-0 h-0.5 rounded-none bg-transparent"
          />
        )}
      </div>

      <main className="flex flex-1 flex-col pt-2">
        {noRoots ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><MapIcon /></EmptyMedia>
              <EmptyTitle className="text-2xl">Point Scenic at your maps</EmptyTitle>
              <EmptyDescription>Zip packs included.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size="lg" onClick={() => onFolders('pick')}>Add a folder</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {home && !searching && <Shelves creators={people} projects={topProjects} />}
            {entity ? (
              <EntityHero entity={entity} parent={<Trail scope={parentScope(scope)} className="[&_a]:text-current [&_li]:text-current opacity-80" />} onEdit={() => setEditing(true)} />
            ) : title && (
              <div className="flex flex-col gap-1 px-(--gutter) pt-2 pb-6">
                <Trail scope={parentScope(scope)} />
                <div className="flex items-baseline gap-3">
                  <h1 className="text-3xl leading-tight font-medium text-balance">{title}</h1>
                  <span className="text-sm text-muted-foreground tabular-nums">{total}</span>
                </div>
              </div>
            )}
            {(active > 0 || filters.query) && (
              <ActiveFilters scope={scope} filters={filters} patch={patch} toggle={toggle} clear={clear} shown={result.groups.length} total={total} paper={paper} />
            )}
            {result.groups.length ? (
              <div className={`${GRID} px-(--gutter) pb-16`}>
                {entries.map((entry) => ('scenes' in entry ? (
                  <ProjectCard
                    key={entry.key}
                    title={leafName(entry.path)}
                    creator={scope.creator === undefined ? entry.creator : ''}
                    href={scopeHash({ creator: entry.creator, project: entry.path })}
                    scenes={entry.scenes}
                  />
                ) : <MapCard key={entry.group.id} view={entry} />))}
              </div>
            ) : library.maps.length ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
                  <EmptyTitle className="text-xl">No matches</EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilters(NO_FILTERS)
                      if (!total) window.location.hash = '#/'
                    }}
                  >
                    Clear filters
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <>
                <p className="px-(--gutter) pb-6 text-sm text-muted-foreground" role="status">
                  {scanning ? `Indexing ${status.done} of ${status.total}` : 'Indexing your maps'}
                </p>
                <div className={`${GRID} px-(--gutter)`} aria-hidden="true">
                  {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-4/3" />)}
                </div>
              </>
            )}
          </>
        )}
      </main>
      {editing && entity && <EntityDialog entity={entity} creators={people.map((c) => c.name)} onClose={() => setEditing(false)} onChanged={onChanged} />}
    </div>
  )
}
