import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft, ChevronRight, Compass, Folder, FolderInput, FolderPlus, Image as ImageIcon, MoreHorizontal, Pencil, Search, Tag, User, X,
} from 'lucide-react'
import { toast } from 'sonner'
import { isWithin, joinPath, leafName, parentPath } from '../shared/tree.ts'
import type { Library, MapGroup } from '../shared/types.ts'
import { projectKey } from '../shared/types.ts'
import { AppBar } from '@/components/app-bar'
import { IconButton, SelectField, SwitchRow } from '@/components/controls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { UNDO_MS } from '@/components/ui/sonner'
import { cn } from '@/lib/utils'
import { announce } from './announce.ts'
import { api } from './api.ts'
import type { Index } from './filters.ts'
import { EntityDialog } from './library/EntityDialog.tsx'
import { directory, type Entity } from './profiles.ts'

interface Item {
  id: string
  kind: 'creator' | 'project' | 'scene'
  label: string
  creator: string
  path: string
  group?: MapGroup
  entity?: Entity
  children: Item[]
  sceneCount: number
}

const ROOT_ID = 'root'

function buildTree(library: Library, index: Index): Item[] {
  const { all, everyProject } = directory(library, index)
  const projectIds = (creator: string, path: string) => `p:${projectKey(creator, path)}`
  const nodes = new Map<string, Item>()
  for (const e of all) {
    nodes.set(`c:${e.name}`, { id: `c:${e.name}`, kind: 'creator', label: e.name, creator: e.name, path: '', entity: e, children: [], sceneCount: e.scenes.length })
  }
  for (const e of everyProject) {
    const id = projectIds(e.creator, e.path)
    nodes.set(id, { id, kind: 'project', label: e.name, creator: e.creator, path: e.path, entity: e, children: [], sceneCount: e.scenes.length })
  }
  const roots: Item[] = []
  const parentOf = (creator: string, path: string) =>
    (path ? nodes.get(projectIds(creator, path)) : creator ? nodes.get(`c:${creator}`) : undefined)
  for (const e of everyProject) {
    const parent = parentOf(e.creator, parentPath(e.path))
    const node = nodes.get(projectIds(e.creator, e.path))!
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  for (const e of all) roots.push(nodes.get(`c:${e.name}`)!)
  for (const g of library.groups) {
    const scene: Item = { id: `s:${g.id}`, kind: 'scene', label: g.title, creator: g.creator, path: g.pack, group: g, children: [], sceneCount: 1 }
    const parent = parentOf(g.creator, g.pack)
    if (parent) parent.children.push(scene)
    else roots.push(scene)
  }
  const rank = (i: Item) => (i.kind === 'scene' ? 1 : 0)
  const order = (list: Item[]) => {
    list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))
    list.forEach((i) => order(i.children))
  }
  order(roots)
  return roots
}

function flatten(items: Item[]): Item[] {
  return items.flatMap((i) => [i, ...flatten(i.children)])
}

const KIND_ICON = { creator: User, project: Folder, scene: ImageIcon }

export function Organize({ library, index, onChanged }: { library: Library; index: Index; onChanged: () => void }) {
  const tree = useMemo(() => buildTree(library, index), [library, index])
  const everything = useMemo(() => flatten(tree), [tree])
  const byId = useMemo(() => new Map(everything.map((i) => [i.id, i])), [everything])
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(tree.filter((i) => i.kind !== 'scene').map((i) => i.id)))
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [dropTarget, setDropTarget] = useState('')
  const [cursor, setCursor] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Entity | null>(null)
  const [grouping, setGrouping] = useState<Item[] | null>(null)
  const [movingItems, setMovingItems] = useState<Item[] | null>(null)
  const [tagging, setTagging] = useState<Item[] | null>(null)
  const [confirm, setConfirm] = useState<{ text: string; action: string; run: () => Promise<unknown> } | null>(null)

  const run = useCallback(async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await work()
      setSelected(new Set())
      if (done) toast.success(done)
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    }
    setBusy(false)
  }, [onChanged])

  const moveInto = (items: Item[], into: { creator: string; path: string }) => {
    const nodes = items.filter((i) => i.kind !== 'scene').map((i) => ({ creator: i.creator, path: i.path }))
    const files = items.filter((i) => i.kind === 'scene').flatMap((i) => i.group!.mapIds)
    return api.tree({ op: 'move', nodes, files, into })
  }

  const dropOn = (target: Item | null, items: Item[]) => {
    if (target?.kind === 'scene') {
      if (!items.every((i) => i.kind === 'scene')) return void toast.error('Only scenes can be merged into a scene')
      const moved = items.flatMap((i) => i.group!.mapIds)
      const undo = () => api.edit(moved, { scene: null, creator: null, pack: null }).then(onChanged)
      return void run(async () => {
        await api.edit(target.group!.mapIds, { scene: target.label })
        await api.edit(moved, { scene: target.label, creator: target.creator, pack: target.path })
        toast.success(`Merged into ${target.label}`, { duration: UNDO_MS, action: { label: 'Undo', onClick: () => void undo() } })
      })
    }
    const into = target ? { creator: target.creator, path: target.path } : { creator: '', path: '' }
    void run(() => moveInto(items, into), `Moved to ${target?.label ?? 'the top level'}`)
  }

  const dragged = (id: string) => (selected.has(id) ? [...selected] : [id]).map((i) => byId.get(i)!).filter(Boolean)

  const canDrop = (target: Item | null, items: Item[]) =>
    !items.some((i) => i.id === target?.id || (target && i.kind !== 'scene' && i.creator === target.creator && isWithin(target.path, i.path) && target.kind !== 'creator'))

  const sceneToProject = (item: Item) => run(
    () => api.edit(item.group!.mapIds, { pack: joinPath(item.path, item.label) }),
    `${item.label} is now a project`,
  )

  const needle = query.trim().toLowerCase()
  const visible = useMemo(() => {
    if (!needle) return null
    const keep = new Set<string>()
    const walk = (item: Item): boolean => {
      const self = `${item.label} ${item.group?.mapIds.map((id) => index.byId.get(id)?.biomes.join(' ')).join(' ') ?? ''}`.toLowerCase().includes(needle)
      const child = item.children.map(walk).some(Boolean)
      if (self || child) keep.add(item.id)
      return self || child
    }
    tree.forEach(walk)
    return keep
  }, [needle, tree, index])

  const targets = useMemo(() => [
    ['root', 'Top level, no creator'] as const,
    ...everything.filter((i) => i.kind !== 'scene').map((i) => [i.id, i.path ? `${i.creator ? `${i.creator} / ` : ''}${i.path}` : i.label] as const),
  ], [everything])

  const rows = useMemo(() => {
    const out: { item: Item; depth: number; parent?: Item }[] = []
    const walk = (list: Item[], depth: number, parent?: Item) => {
      for (const item of list) {
        if (visible && !visible.has(item.id)) continue
        out.push({ item, depth, parent })
        if (open.has(item.id) || visible) walk(item.children, depth + 1, item)
      }
    }
    walk(tree, 0)
    return out
  }, [tree, open, visible])

  const focusId = rows.some((r) => r.item.id === cursor) ? cursor : rows[0]?.item.id

  const focusRow = (id: string) => {
    setCursor(id)
    document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus()
  }

  // The row and its parents, so focus has somewhere to land when a change takes the row away.
  const lineage = useRef<string[]>([])
  useEffect(() => {
    const chain: string[] = []
    for (let at = rows.find((r) => r.item.id === cursor); at; at = rows.find((r) => r.item.id === at!.parent?.id)) chain.push(at.item.id)
    if (chain.length) lineage.current = chain
    if (document.activeElement !== document.body) return
    const home = lineage.current.find((id) => rows.some((r) => r.item.id === id))
    if (home) focusRow(home)
  }, [rows, cursor, selected, busy, editing, grouping, movingItems, tagging, confirm])

  const said = useRef(0)
  useEffect(() => {
    if (selected.size === said.current) return
    said.current = selected.size
    announce(selected.size ? `${selected.size} selected` : 'Selection cleared')
  }, [selected])

  const onRowKey = (e: React.KeyboardEvent, item: Item) => {
    if (e.target !== e.currentTarget) return
    const at = rows.findIndex((r) => r.item.id === item.id)
    const go = (index: number) => {
      const next = rows[index]
      if (next) focusRow(next.item.id)
    }
    const expanded = open.has(item.id)
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(rows.length - 1)
    else if (e.key === 'ArrowRight') {
      if (item.children.length && !expanded) setOpen(new Set(open).add(item.id))
      else if (item.children.length) go(at + 1)
    } else if (e.key === 'ArrowLeft') {
      if (expanded) {
        const next = new Set(open)
        next.delete(item.id)
        setOpen(next)
      } else if (rows[at].parent) focusRow(rows[at].parent!.id)
    } else if (e.key === ' ') {
      const next = new Set(selected)
      if (!next.delete(item.id)) next.add(item.id)
      setSelected(next)
    } else if (e.key === 'Enter') {
      if (item.entity) setEditing(item.entity)
      else window.location.hash = `#/map/${item.group!.coverId}`
    } else return
    e.preventDefault()
  }

  const row = (item: Item, depth: number): React.ReactNode => {
    const expanded = open.has(item.id) || !!visible
    const Icon = item.entity?.adventure ? Compass : KIND_ICON[item.kind]
    const tags = [...new Set(item.group?.mapIds.flatMap((id) => index.byId.get(id)?.biomes ?? []) ?? [])]
    const items = () => (selected.has(item.id) ? [...selected].map((i) => byId.get(i)!).filter(Boolean) : [item])
    return (
        <div
          key={item.id}
          role="treeitem"
          aria-level={depth + 1}
          aria-label={`${item.label}${item.kind === 'scene' ? ', scene' : `, ${item.entity?.adventure ? 'adventure' : item.kind}, ${item.sceneCount} ${item.sceneCount === 1 ? 'scene' : 'scenes'}`}`}
          aria-expanded={item.children.length ? expanded : undefined}
          aria-selected={selected.has(item.id)}
          data-row={item.id}
          tabIndex={item.id === focusId ? 0 : -1}
          onFocus={() => setCursor(item.id)}
          onKeyDown={(e) => onRowKey(e, item)}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', item.id)
            e.dataTransfer.effectAllowed = 'move'
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDropTarget(item.id)
          }}
          onDragLeave={() => setDropTarget((t) => (t === item.id ? '' : t))}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setDropTarget('')
            const list = dragged(e.dataTransfer.getData('text/plain'))
            if (list.length && canDrop(item, list)) dropOn(item, list)
          }}
          onClick={(e) => {
            const next = new Set(e.metaKey || e.ctrlKey ? selected : [])
            if (!next.delete(item.id)) next.add(item.id)
            setSelected(next)
          }}
          style={{ paddingLeft: `${depth * 1.25 + 0.25}rem` }}
          className={cn(
            'group/row flex min-h-(--control) cursor-grab items-center gap-2 rounded-md pr-1 text-sm transition-colors select-none hover:bg-accent active:cursor-grabbing',
            selected.has(item.id) && 'bg-accent',
            dropTarget === item.id && 'ring-2 ring-primary',
          )}
        >
          {item.children.length > 0 ? (
            <Button
              variant="ghost"
              size="icon-xs"
              tabIndex={-1}
              aria-label={expanded ? `Collapse ${item.label}` : `Expand ${item.label}`}
              onClick={(e) => {
                e.stopPropagation()
                const next = new Set(open)
                if (!next.delete(item.id)) next.add(item.id)
                setOpen(next)
              }}
            >
              <ChevronRight className={cn('transition-transform', expanded && 'rotate-90')} />
            </Button>
          ) : <span className="size-6 shrink-0" />}
          <Icon className={cn('size-4 shrink-0 text-muted-foreground', item.entity?.adventure && 'text-primary')} />
          <span className="min-w-0 truncate">{item.label}</span>
          {item.entity?.collection && <Badge variant="secondary">Project</Badge>}
          {tags.slice(0, 3).map((t) => <Badge key={t} variant="secondary" className="max-sm:hidden">{t}</Badge>)}
          <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{item.kind === 'scene' ? '' : item.sceneCount}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" tabIndex={item.id === focusId ? 0 : -1} aria-label={`Actions for ${item.label}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuGroup>
                {item.entity
                  ? <DropdownMenuItem onSelect={() => setEditing(item.entity!)}><Pencil />Edit</DropdownMenuItem>
                  : <DropdownMenuItem asChild><a href={`#/map/${item.group!.coverId}`}><Pencil />Open and edit</a></DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => setMovingItems(items())}><FolderInput />Move to…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setGrouping(items())}><FolderPlus />Group into new project…</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setTagging(items())}><Tag />Add tag…</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                {item.kind === 'scene' && <DropdownMenuItem onSelect={() => void sceneToProject(item)}><Folder />Make it a project</DropdownMenuItem>}
                {item.kind === 'project' && (
                  <>
                    <DropdownMenuItem onSelect={() => void run(() => api.profile({ kind: 'project', creator: item.creator, project: item.path, patch: { type: item.entity!.adventure ? '' : 'adventure' } }))}>
                      <Compass />{item.entity!.adventure ? 'Make a plain project' : 'Make an adventure'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setConfirm({
                      text: `The ${item.label} level is removed and its ${item.sceneCount === 1 ? 'scene moves' : 'contents move'} up one level. Its name, banner and colour are lost.`,
                      action: 'Remove level',
                      run: () => api.tree({ op: 'dissolve', node: { creator: item.creator, path: item.path } }),
                    })}>
                      <ImageIcon />{item.sceneCount === 1 ? 'Make it just a scene' : 'Remove this level'}
                    </DropdownMenuItem>
                  </>
                )}
                {item.kind !== 'scene' && (
                  <DropdownMenuItem onSelect={() => setConfirm({
                    text: `Every project inside ${item.label} that holds a single scene is removed, leaving just the scene. Their names, banners and colours are lost.`,
                    action: 'Clear them out',
                    run: () => api.tree({ op: 'flatten', node: { creator: item.creator, path: item.path } }),
                  })}>
                    <X />Clear one-scene projects
                  </DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
    )
  }

  const sel = [...selected].map((i) => byId.get(i)!).filter(Boolean)

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar>
        <IconButton label="Library" icon={ArrowLeft} href="#/" className="-ml-2" />
        <h1 className="text-sm font-medium">Organise</h1>
        <InputGroup className="ml-2 max-w-sm flex-1">
          <InputGroupAddon><Search /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Find in the tree" placeholder="Find" value={query} onChange={(e) => setQuery(e.target.value)} />
        </InputGroup>
        <div className="ml-auto flex gap-1 max-sm:hidden">
          <Button variant="ghost" size="sm" onClick={() => setOpen(new Set(everything.filter((i) => i.children.length).map((i) => i.id)))}>Expand all</Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen(new Set())}>Collapse</Button>
        </div>
      </AppBar>

      <main
        className={cn('mx-auto w-full max-w-4xl flex-1 px-(--gutter) py-3', dropTarget === ROOT_ID && 'ring-2 ring-primary ring-inset')}
        onDragOver={(e) => {
          e.preventDefault()
          setDropTarget(ROOT_ID)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDropTarget('')
          const list = dragged(e.dataTransfer.getData('text/plain'))
          if (list.length) dropOn(null, list)
        }}
      >
        <div role="tree" aria-label="All creators, projects and scenes" aria-multiselectable="true">{rows.map(({ item, depth }) => row(item, depth))}</div>
      </main>

      {sel.length > 0 && (
        <div className="sticky bottom-3 z-10 mx-auto flex items-center gap-1 rounded-xl bg-popover p-1 pl-3 shadow-lg" role="toolbar" aria-label="Selection">
          <span className="mr-2 text-sm tabular-nums">{sel.length} selected</span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMovingItems(sel)}><FolderInput data-icon="inline-start" />Move</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setGrouping(sel)}><FolderPlus data-icon="inline-start" />Group</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setTagging(sel)}><Tag data-icon="inline-start" />Tag</Button>
          <IconButton label="Clear selection" icon={X} onClick={() => setSelected(new Set())} />
        </div>
      )}

      {editing && <EntityDialog entity={editing} creators={everything.filter((i) => i.kind === 'creator').map((i) => i.label)} onClose={() => setEditing(null)} onChanged={onChanged} />}

      {grouping && (
        <NameDialog
          title="Group into a new project"
          label="Project name"
          adventureOption
          onClose={() => setGrouping(null)}
          onSubmit={(name, adventure) => {
            const first = grouping[0]
            const parent = first.kind === 'creator' ? { creator: '', path: '' } : { creator: first.creator, path: first.kind === 'scene' ? first.path : parentPath(first.path) }
            const into = { creator: parent.creator, path: joinPath(parent.path, name) }
            const items = grouping
            setGrouping(null)
            void run(async () => {
              await moveInto(items, into)
              if (adventure) await api.profile({ kind: 'project', creator: into.creator, project: into.path, patch: { type: 'adventure' } })
            }, `Grouped into ${leafName(into.path)}`)
          }}
        />
      )}

      {tagging && (
        <NameDialog
          title="Add a tag"
          label="Tag"
          onClose={() => setTagging(null)}
          onSubmit={(tag) => {
            const scenes = flatten(tagging).filter((i) => i.kind === 'scene')
            setTagging(null)
            void run(async () => {
              for (const scene of scenes) {
                const current = index.byId.get(scene.group!.coverId)?.biomes ?? []
                if (!current.includes(tag)) await api.edit(scene.group!.mapIds, { tags: [...current, tag] })
              }
            }, `Tagged ${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'}`)
          }}
        />
      )}

      {movingItems && (
        <MoveDialog
          targets={targets}
          count={movingItems.length}
          onClose={() => setMovingItems(null)}
          onSubmit={(id) => {
            const list = movingItems
            setMovingItems(null)
            const target = id === 'root' ? null : byId.get(id)!
            if (canDrop(target, list)) dropOn(target, list)
            else toast.error('A project cannot move inside itself')
          }}
        />
      )}

      {confirm && (
        <Dialog open onOpenChange={(next) => !next && setConfirm(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>Are you sure?</DialogTitle><DialogDescription>{confirm.text}</DialogDescription></DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button
                variant="destructive"
                onClick={() => {
                  const { run: work } = confirm
                  setConfirm(null)
                  void run(work, 'Done')
                }}
              >
                {confirm.action}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

function NameDialog({ title, label, adventureOption, onClose, onSubmit }: {
  title: string
  label: string
  adventureOption?: boolean
  onClose: () => void
  onSubmit: (name: string, adventure: boolean) => void
}) {
  const [name, setName] = useState('')
  const [adventure, setAdventure] = useState(false)
  const [tried, setTried] = useState(false)
  const missing = tried && !name.trim()
  const input = useRef<HTMLInputElement>(null)
  const submit = () => {
    if (name.trim()) return onSubmit(name.trim().replaceAll('/', '-'), adventure)
    setTried(true)
    input.current?.focus()
  }
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <Field data-invalid={missing}>
          <FieldLabel htmlFor="organize-name">{label}</FieldLabel>
          <Input
            ref={input}
            id="organize-name"
            autoFocus
            value={name}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? 'organize-name-error' : undefined}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          {missing && <FieldError id="organize-name-error">Enter a name</FieldError>}
        </Field>
        {adventureOption && <SwitchRow label="This is an adventure" checked={adventure} onCheckedChange={setAdventure} />}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MoveDialog({ targets, count, onClose, onSubmit }: {
  targets: readonly (readonly [string, string])[]
  count: number
  onClose: () => void
  onSubmit: (id: string) => void
}) {
  const [target, setTarget] = useState(targets[0][0])
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-md">
        <DialogHeader><DialogTitle>Move {count} {count === 1 ? 'item' : 'items'}</DialogTitle></DialogHeader>
        <SelectField label="Into" value={target} options={targets} onChange={setTarget} />
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSubmit(target)}>Move</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
