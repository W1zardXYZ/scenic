import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Download, EyeOff, FileArchive, Heart, Pencil, Printer } from 'lucide-react'
import { toast } from 'sonner'
import type { GridSource, Library, MapRecord, VariantKind } from '../shared/types.ts'
import { GradeBadge, Hint, IconButton, IconToggle, SelectField, SliderField } from '@/components/controls'
import { Trail } from '@/components/trail'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { UNDO_MS } from '@/components/ui/sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import { splitVariant } from '../shared/levels.ts'
import { api, thumb } from './api.ts'
import { bestVersion, type Index, pageSpec, type Prefs } from './filters.ts'
import { EditDialog } from './EditDialog.tsx'
import { sceneScope } from './scope.ts'
import { ZoomView } from './ZoomView.tsx'

const SOURCE: Record<GridSource, string> = {
  manual: 'Set by you',
  visual: 'Measured from grid lines',
  vtt: 'From VTT file',
  filename: 'From file name',
  pattern: 'Estimated from floor tiles, check before printing',
  sibling: 'Measured on a matching file',
  guess: 'Estimated, check before printing',
}

const PRESETS = [
  { label: 'Foundry', hint: 'WebP, full size', format: 'webp', quality: 85, pps: 0 },
  { label: 'Roll20', hint: 'JPG, 70 px grid', format: 'jpg', quality: 85, pps: 70 },
  { label: 'Universal VTT', hint: '.dd2vtt with walls', format: 'dd2vtt', quality: 85, pps: 0 },
]

const KINDS: { label: string; kinds: VariantKind[] }[] = [
  { label: 'Levels', kinds: ['level'] },
  { label: 'Lighting', kinds: ['lighting'] },
  { label: 'Weather', kinds: ['weather'] },
  { label: 'Versions', kinds: ['labels', 'other'] },
]

const FORMATS = [['webp', 'WebP'], ['jpg', 'JPG'], ['png', 'PNG'], ['avif', 'AVIF'], ['tiff', 'TIFF'], ['dd2vtt', 'Universal VTT']] as const

const bytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`)

/** Names a file among its versions; the resolution is added when the versions differ in it, as print and VTT exports do. */
function versionLabel(m: MapRecord, versions: MapRecord[]): string {
  const kind = m.rel.toLowerCase().match(/\.(dd2vtt|df2vtt|uvtt)$/) ? 'VTT file' : m.format.toUpperCase()
  const resolutions = new Set(versions.map((v) => Math.round(v.ppsX)))
  return [m.hasGrid ? 'Grid' : 'No grid', kind, resolutions.size > 1 && `${Math.round(m.ppsX)} ppi`].filter(Boolean).join(' · ')
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="order-last text-xs text-muted-foreground">{label}</dt>
      <dd className="flex h-7 items-center text-lg font-medium tabular-nums">{children}</dd>
    </div>
  )
}

function Spec({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 tabular-nums">{children}</dd>
    </>
  )
}

function byVariant(maps: MapRecord[]): [string, MapRecord[]][] {
  const buckets = new Map<string, MapRecord[]>()
  for (const m of maps) buckets.set(m.variant, [...(buckets.get(m.variant) ?? []), m])
  return [...buckets.entries()]
}

export function MapView({ map, library, index, prefs, backHash, onChanged }: {
  map: MapRecord
  library: Library
  index: Index
  prefs: Prefs
  backHash: string
  onChanged: () => void
}) {
  const group = library.groups.find((g) => g.id === map.groupId)!
  const maps = useMemo(() => group.mapIds.map((id) => index.byId.get(id)!).filter(Boolean), [group, index])
  const variants = useMemo(() => byVariant(maps), [maps])
  // Overlays at several resolutions share a label, so each shows once, like a variant's versions.
  const overlays = useMemo(() => byVariant(group.overlayIds.map((id) => index.byId.get(id)!).filter(Boolean)), [group, index])
  const isOverlay = map.variantKind === 'overlay'
  // Each kind keeps the server's order, which is bottom to top for levels.
  const sections = useMemo(() => KINDS.map(({ label, kinds }) => ({
    label,
    variants: variants.filter(([, list]) => kinds.includes(list[0].variantKind)),
  })).filter((section) => section.variants.length), [variants])
  const ordered = useMemo(() => sections.flatMap((section) => section.variants), [sections])
  // Floors run top to bottom, how each looks runs across, once a scene varies both ways.
  const matrix = useMemo(() => {
    const cells = ordered.map((variant) => ({ variant, ...splitVariant(variant[0]) }))
    const floors = [...new Map(cells.map((c) => [c.floor, c.height ?? 0]))].sort((a, b) => b[1] - a[1]).map(([floor]) => floor)
    const looks = [...new Set(cells.map((c) => c.look))]
    if (floors.length < 2 || looks.length < 2) return null
    return { looks, rows: floors.map((floor) => ({ floor, cells: looks.map((look) => cells.find((c) => c.floor === floor && c.look === look)?.variant) })) }
  }, [ordered])
  const [format, setFormat] = useState('webp')
  const [quality, setQuality] = useState(85)
  const [pps, setPps] = useState(0)
  const current = useRef<HTMLAnchorElement>(null)
  const [lightbox, setLightbox] = useState(false)
  const [editing, setEditing] = useState(false)

  /** A variant's thumbnail; in the matrix the row and column headings name it, so `label` is only for screen readers. */
  const thumbLink = ([name, list]: [string, MapRecord[]], label?: string) => {
    const best = bestVersion(list)
    const on = name === map.variant && (list[0].variantKind === 'overlay') === isOverlay
    return (
      <a
        key={name}
        ref={on ? current : undefined}
        href={`#/map/${best.id}`}
        aria-current={on ? 'true' : undefined}
        aria-label={label}
        className="group/thumb flex w-20 shrink-0 flex-col gap-1 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring aria-[current=true]:text-foreground"
      >
        <span className={cn('block h-14 overflow-hidden rounded-md opacity-70 transition-opacity group-hover/thumb:opacity-100', on && 'opacity-100 ring-2 ring-primary')}>
          <img src={thumb(best, 'small')} alt="" loading="lazy" className="size-full object-cover" />
        </span>
        {!label && <span className="truncate" title={name || 'Standard'}>{name || 'Standard'}</span>}
      </a>
    )
  }

  const close = () => (window.location.hash = backHash)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const across = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      const down = matrix && (e.key === 'ArrowUp' || e.key === 'ArrowDown')
      if (e.defaultPrevented || !(across || down)) return
      // Arrow keys belong to whichever control has focus.
      if ((e.target as Element).closest('input, [role=slider], [role=tab], [role=radio], [role=listbox], [role=menu]')) return
      const go = (variant: [string, MapRecord[]]) => (window.location.hash = `#/map/${bestVersion(variant[1]).id}`)
      if (!matrix) {
        const at = ordered.findIndex(([v]) => v === map.variant)
        return go(ordered[(at + (e.key === 'ArrowRight' ? 1 : ordered.length - 1)) % ordered.length])
      }
      e.preventDefault()
      const { rows } = matrix
      const r = rows.findIndex((row) => row.cells.some((c) => c?.[0] === map.variant))
      const c = rows[r].cells.findIndex((cell) => cell?.[0] === map.variant)
      if (across) {
        const filled = rows[r].cells.filter((cell) => cell !== undefined)
        const at = filled.findIndex((cell) => cell[0] === map.variant)
        return go(filled[(at + (e.key === 'ArrowRight' ? 1 : filled.length - 1)) % filled.length])
      }
      const row = rows[(r + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]
      // The same column if the floor has it, else the nearest one it does.
      const nearest = row.cells
        .map((cell, i) => ({ cell, distance: Math.abs(i - c) }))
        .filter((x) => x.cell !== undefined)
        .sort((a, b) => a.distance - b.distance)[0]
      go(nearest.cell!)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ordered, matrix, map.variant])

  // Runs first so an open tooltip cannot swallow the key.
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing || document.querySelector('[role=menu], [role=listbox]')) return
      e.stopPropagation()
      if (lightbox) setLightbox(false)
      else window.location.hash = backHash
    }
    window.addEventListener('keydown', onEscape, true)
    return () => window.removeEventListener('keydown', onEscape, true)
  }, [editing, lightbox, backHash])

  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [map.variant])

  const facts = index.facts.get(map.id)!
  const spec = pageSpec(prefs)
  const versions = (isOverlay ? overlays : variants).find(([v]) => v === map.variant)?.[1] ?? [map]
  const widthCm = (facts.cols * spec.squareMm) / 10
  const heightCm = (facts.rows * spec.squareMm) / 10
  const exportUrl = `/api/maps/${map.id}/export?format=${format}&quality=${quality}&pps=${pps}`
  const zipUrl = `/api/export-zip?ids=${variants.map(([, list]) => bestVersion(list).id).join(',')}&format=${format}&quality=${quality}&pps=${pps}&name=${encodeURIComponent(group.title)}`
  const lossy = format === 'jpg' || format === 'webp' || format === 'avif'
  const preset = PRESETS.find((p) => format === p.format && pps === p.pps)?.label ?? ''
  const fail = (e: Error) => void toast.error(e.message)
  const alt = [group.title, map.variant].filter(Boolean).join(' ')

  const toggleFavorite = () => api.patchMap(map.id, { favorite: !map.favorite }).then(onChanged, fail)
  const toggleHidden = () => api.patchMap(map.id, { hidden: !map.hidden }).then(() => {
    onChanged()
    if (!map.hidden) {
      toast('Hidden from the library', {
        duration: UNDO_MS,
        action: { label: 'Undo', onClick: () => api.patchMap(map.id, { hidden: false }).then(onChanged, fail) },
      })
    }
  }, fail)

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          const content = e.currentTarget as HTMLElement
          ;(content.querySelector<HTMLElement>('[data-zoom-view]') ?? content).focus()
        }}
        className="inset-0 grid h-dvh w-full max-w-none translate-x-0 translate-y-0 grid-rows-[46dvh_minmax(0,1fr)] gap-0 rounded-none bg-background p-0 ring-0 data-open:zoom-in-100 sm:max-w-none lg:grid-cols-[minmax(0,1fr)_24rem] lg:grid-rows-1"
      >
        <div
          className="relative flex min-h-0 min-w-0 flex-col"
          style={{ backgroundColor: `color-mix(in oklch, ${map.color} 14%, var(--background))` }}
        >
          <IconButton label="Library" shortcut="Esc" side="right" icon={ArrowLeft} variant="secondary" onClick={close} className="absolute top-3 left-3 z-10 lg:top-4 lg:left-4" />
          <div className="min-h-0 flex-1 p-3 lg:p-8">
            <ZoomView key={map.id} map={map} alt={alt} lightbox={false} shortcuts={prefs.shortcuts} onToggleLightbox={() => setLightbox(true)} />
          </div>
          {lightbox && (
            <Dialog open onOpenChange={setLightbox}>
              <DialogContent
                showCloseButton={false}
                aria-describedby={undefined}
                className="inset-0 block h-dvh w-full max-w-none translate-x-0 translate-y-0 rounded-none bg-black p-0 ring-0 data-open:zoom-in-100 sm:max-w-none"
              >
                <DialogTitle className="sr-only">{alt}, full view</DialogTitle>
                <ZoomView key={map.id} map={map} alt={alt} lightbox shortcuts={prefs.shortcuts} onToggleLightbox={() => setLightbox(false)} />
              </DialogContent>
            </Dialog>
          )}
          {(variants.length > 1 || overlays.length > 0) && (
            <nav aria-label="Variants" className="flex [justify-content:safe_center] gap-6 overflow-x-auto px-3 pt-1 pb-3 [scrollbar-width:none] lg:px-8 lg:pb-6">
              {matrix ? (
                <table className="shrink-0 border-separate border-spacing-x-2 border-spacing-y-1 text-xs text-muted-foreground">
                  <thead>
                    <tr>
                      <td />
                      {matrix.looks.map((look) => <th key={look} scope="col" className="text-left font-normal">{look || 'Standard'}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.rows.map((row) => (
                      <tr key={row.floor}>
                        <th scope="row" className="pr-1 text-left font-normal">{row.floor || 'Standard'}</th>
                        {row.cells.map((cell, i) => (
                          <td key={matrix.looks[i]}>
                            {cell ? thumbLink(cell, `${row.floor} ${matrix.looks[i]}`.trim()) : <span className="block h-14 w-20 rounded-md border border-dashed border-border" />}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : sections.map((section) => (
                <section key={section.label} aria-label={section.label} className="flex shrink-0 flex-col gap-2">
                  {(sections.length > 1 || section.label !== 'Versions') && <h2 className="text-xs text-muted-foreground">{section.label}</h2>}
                  <div className="flex gap-2">
                    {section.variants.map((variant) => thumbLink(variant))}
                  </div>
                </section>
              ))}
              {overlays.length > 0 && (
                <section aria-label="Overlays" className="flex shrink-0 flex-col gap-2">
                  <h2 className="text-xs text-muted-foreground">Overlays</h2>
                  <div className="flex gap-2">{overlays.map((overlay) => thumbLink(overlay))}</div>
                </section>
              )}
            </nav>
          )}
        </div>

        <aside className="flex min-h-0 flex-col gap-6 overflow-y-auto bg-card p-(--gutter)">
          <header className="flex items-start gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Trail scope={sceneScope(group)} />
              <DialogTitle asChild>
                <h1 className="text-2xl leading-tight font-medium text-balance">{group.title}</h1>
              </DialogTitle>
              {map.variant && <p className="text-sm text-muted-foreground">{map.variant}</p>}
            </div>
            <div className="-mr-2 flex shrink-0">
              <IconButton label="Edit" icon={Pencil} onClick={() => setEditing(true)} />
              <IconToggle label={map.favorite ? 'Favourited' : 'Favourite'} icon={Heart} pressed={map.favorite} onPressedChange={toggleFavorite} className="on:[&_svg]:fill-current" />
              <IconToggle label={map.hidden ? 'Hidden, click to show' : 'Hide from the library'} icon={EyeOff} pressed={map.hidden} onPressedChange={toggleHidden} />
            </div>
          </header>

          <dl className="grid grid-cols-3 gap-3">
            <Stat label="Squares">{Math.round(facts.cols)} × {Math.round(facts.rows)}</Stat>
            <Stat label={`${prefs.paperId.toUpperCase()} sheets`}>{facts.sheets}</Stat>
            <Stat label={`${Math.round(facts.ppi)} ppi`}><GradeBadge grade={facts.grade} /></Stat>
          </dl>

          <Button size="lg" asChild>
            <a href={`#/print/${map.id}`}><Printer data-icon="inline-start" />Print</a>
          </Button>

          {versions.length > 1 && (
            <ToggleGroup
              type="single"
              variant="quiet"
              size="sm"
              spacing={1}
              aria-label="File version"
              value={String(map.id)}
              onValueChange={(id) => {
                if (id) window.location.hash = `#/map/${id}`
              }}
              className="-ml-2.5 flex-wrap"
            >
              {versions.map((v) => <ToggleGroupItem key={v.id} value={String(v.id)}>{versionLabel(v, versions)}</ToggleGroupItem>)}
            </ToggleGroup>
          )}

          <Tabs defaultValue="details" className="gap-5">
            <TabsList className="w-full">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="export">Export</TabsTrigger>
            </TabsList>

            <TabsContent value="details">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5">
                <Spec label="Grid">{SOURCE[map.gridSource]}</Spec>
                <Spec label="Image">{map.width.toLocaleString()} × {map.height.toLocaleString()} px</Spec>
                <Spec label="Per square">{map.ppsX.toFixed(map.ppsX % 1 ? 1 : 0)} px</Spec>
                <Spec label="Printed">{widthCm.toFixed(0)} × {heightCm.toFixed(0)} cm at {spec.squareMm} mm</Spec>
                <Spec label="Ink">{facts.ink}, {Math.round(map.ink * 100)}%</Spec>
                <Spec label="VTT data">{map.walls || map.lights ? `${map.walls} walls, ${map.lights} lights` : 'None'}</Spec>
                <Spec label="File">{map.format.toUpperCase()}, {bytes(map.bytes)}</Spec>
                <dd className="col-span-2 text-xs break-all text-muted-foreground" title={map.rel}>{map.rel}</dd>
              </dl>
            </TabsContent>

            <TabsContent value="export" className="flex flex-col gap-5">
              <ToggleGroup
                type="single"
                variant="quiet"
                size="sm"
                spacing={1}
                aria-label="Export preset"
                value={preset}
                onValueChange={(label) => {
                  const p = PRESETS.find((candidate) => candidate.label === label)
                  if (!p) return
                  setFormat(p.format)
                  setQuality(p.quality)
                  setPps(p.pps)
                }}
                className="-ml-2.5 flex-wrap"
              >
                {PRESETS.map((p) => (
                  <Hint key={p.label} label={p.hint}>
                    <ToggleGroupItem value={p.label}>{p.label}</ToggleGroupItem>
                  </Hint>
                ))}
              </ToggleGroup>
              <div className="grid grid-cols-2 gap-3">
                <SelectField label="Format" value={format} options={FORMATS} onChange={setFormat} />
                <SelectField
                  label="Pixels per square"
                  value={String(pps)}
                  options={[['0', 'Original'], ...[200, 150, 140, 100, 70, 50].filter((n) => n < map.ppsX).map((n) => [String(n), String(n)] as const)]}
                  onChange={(value) => setPps(Number(value))}
                />
              </div>
              {lossy && <SliderField label="Quality" value={quality} min={10} max={100} step={1} onChange={setQuality} />}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" className="flex-1" asChild>
                  <a href={exportUrl} download><Download data-icon="inline-start" />Download</a>
                </Button>
                {variants.length > 1 && (
                  <Button variant="ghost" asChild>
                    <a href={zipUrl} download><FileArchive data-icon="inline-start" />All {variants.length} (.zip)</a>
                  </Button>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </aside>
        {editing && <EditDialog map={map} group={group} library={library} onClose={() => setEditing(false)} onChanged={onChanged} />}
      </DialogContent>
    </Dialog>
  )
}
