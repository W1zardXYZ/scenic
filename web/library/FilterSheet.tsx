import { useState } from 'react'
import { Eye, Heart, ListFilter, Tag, TriangleAlert, Waypoints, type LucideIcon } from 'lucide-react'
import { PAPERS } from '../../shared/layout.ts'
import { Hint, PanelGroup, SwitchRow } from '@/components/controls'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { type FacetKey, FACETS, type Filters, type Prefs, type Result } from '../filters.ts'

export const SWATCHES: Record<string, string> = {
  Red: '#b5403a', Orange: '#d1803c', Brown: '#7a5233', Yellow: '#d9bd55', Green: '#55884f', Teal: '#3f9288',
  Blue: '#44709f', Purple: '#7c5a9c', Grey: '#7d7a74', Black: '#26241f', White: '#e6e1d6',
}

export type ToggleKey = 'favorites' | 'vtt' | 'labelled' | 'unverified' | 'hidden'

export const TOGGLES: { key: ToggleKey; label: string; chip: string; icon: LucideIcon }[] = [
  { key: 'favorites', label: 'Favourites', chip: 'Favourites', icon: Heart },
  { key: 'vtt', label: 'Has VTT data', chip: 'VTT data', icon: Waypoints },
  { key: 'labelled', label: 'Labelled', chip: 'Labelled', icon: Tag },
  { key: 'unverified', label: 'Grid needs checking', chip: 'Grid needs checking', icon: TriangleAlert },
  { key: 'hidden', label: 'Show hidden', chip: 'Showing hidden', icon: Eye },
]

// The facets people reach for first stay open; the rest are one click away.
const FACET_ORDER: FacetKey[] = ['biome', 'time', 'size', 'weather', 'print', 'ink', 'shape', 'grid', 'format', 'creator', 'pack']
const OPEN_BY_DEFAULT = ['biome', 'time', 'size', 'color']
const PREVIEW = 8

function Facet({ id, selected, values, toggle }: {
  id: FacetKey
  selected: string[]
  values: [string, number][]
  toggle: (key: FacetKey, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const shown = open ? values : values.slice(0, PREVIEW)
  return (
    <AccordionItem value={id}>
      <AccordionTrigger>
        <span className="flex items-center gap-2">
          {FACETS[id].label}
          {selected.length > 0 && <Badge className="tabular-nums">{selected.length}</Badge>}
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-4">
        <ToggleGroup
          type="multiple"
          variant="chip"
          size="sm"
          spacing={1.5}
          aria-label={FACETS[id].label}
          value={selected}
          className="w-full flex-wrap"
        >
          {shown.map(([value, count]) => (
            <ToggleGroupItem key={value} value={value} onClick={() => toggle(id, value)} className="gap-1.5">
              {value}<span className="text-xs tabular-nums opacity-60">{count}</span>
            </ToggleGroupItem>
          ))}
          {values.length > PREVIEW && (
            <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
              {open ? 'Less' : `${values.length - PREVIEW} more`}
            </Button>
          )}
        </ToggleGroup>
      </AccordionContent>
    </AccordionItem>
  )
}

function ColourFacet({ selected, values, toggle }: {
  selected: string[]
  values: [string, number][]
  toggle: (key: FacetKey, value: string) => void
}) {
  return (
    <AccordionItem value="color">
      <AccordionTrigger>
        <span className="flex items-center gap-2">
          Colour
          {selected.length > 0 && <Badge className="tabular-nums">{selected.length}</Badge>}
        </span>
      </AccordionTrigger>
      <AccordionContent className="pb-4">
        <ToggleGroup type="multiple" spacing={3} aria-label="Colour" value={selected} className="w-full flex-wrap p-0.5">
          {values.map(([value, count]) => (
            <Hint key={value} label={`${value} · ${count}`}>
              <ToggleGroupItem
                value={value}
                aria-label={`${value}, ${count} maps`}
                style={{ backgroundColor: SWATCHES[value] }}
                onClick={() => toggle('color', value)}
                className="size-7 min-w-7 rounded-full p-0 ring-1 ring-foreground/15 on:ring-2 on:ring-primary on:ring-offset-2 on:ring-offset-card"
              />
            </Hint>
          ))}
        </ToggleGroup>
      </AccordionContent>
    </AccordionItem>
  )
}

/** Selected values stay on screen at zero, so they can always be turned off here. */
function withSelected(values: [string, number][], selected: string[] = []): [string, number][] {
  const missing = selected.filter((value) => !values.some(([v]) => v === value))
  return [...values, ...missing.map((value): [string, number] => [value, 0])]
}

export function FilterSheet({ filters, patch, toggle, facets, shown, active, clear, prefs, setPrefs }: {
  filters: Filters
  patch: (p: Partial<Filters>) => void
  toggle: (key: FacetKey, value: string) => void
  facets: Result['facets']
  shown: number
  active: number
  clear: () => void
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
}) {
  const [open, setOpen] = useState(false)
  const colours = withSelected(facets.color, filters.selected.color)
  const facet = (key: FacetKey) => {
    const values = withSelected(facets[key], filters.selected[key])
    return values.length > 0 && <Facet key={key} id={key} selected={filters.selected[key] ?? []} values={values} toggle={toggle} />
  }
  return (
    <Sheet open={open} onOpenChange={setOpen} modal={false}>
      <SheetTrigger asChild>
        <Button variant="outline" aria-label={active ? `Filters, ${active} active` : 'Filters'} className="relative max-sm:w-(--control) max-sm:px-0">
          <ListFilter data-icon="inline-start" />
          <span className="hidden sm:inline">Filters</span>
          {active > 0 && <Badge className="tabular-nums max-sm:absolute max-sm:-top-1 max-sm:-right-1 max-sm:h-4 max-sm:px-1">{active}</Badge>}
        </Button>
      </SheetTrigger>
      <SheetContent
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md"
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).focus()
        }}
      >
        <SheetHeader><SheetTitle>Filters</SheetTitle></SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-8 p-(--gutter)">
            <PanelGroup>
              {TOGGLES.map(({ key, label, icon }) => (
                <SwitchRow key={key} label={label} icon={icon} checked={filters[key]} onCheckedChange={(on) => patch({ [key]: on })} />
              ))}
            </PanelGroup>

            <PanelGroup
              title="Sheets"
              aside={(
                <div className="flex items-center gap-2">
                  <output className="text-xs text-muted-foreground tabular-nums">{filters.maxSheets ? `Up to ${filters.maxSheets}` : 'Any'}</output>
                  <Select value={prefs.paperId} onValueChange={(paperId) => setPrefs({ paperId })}>
                    <SelectTrigger size="sm" aria-label="Paper used to count sheets"><SelectValue /></SelectTrigger>
                    <SelectContent position="popper" align="end">
                      <SelectGroup>
                        {PAPERS.map((p) => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
            >
              <Slider aria-label="Maximum sheets" min={0} max={60} step={1} value={[filters.maxSheets]} onValueChange={([maxSheets]) => patch({ maxSheets })} />
            </PanelGroup>

            <Accordion type="multiple" defaultValue={OPEN_BY_DEFAULT} className="-my-2.5">
              {FACET_ORDER.slice(0, 3).map(facet)}
              {colours.length > 0 && <ColourFacet selected={filters.selected.color ?? []} values={colours} toggle={toggle} />}
              {FACET_ORDER.slice(3).map(facet)}
            </Accordion>
          </div>
        </ScrollArea>
        <SheetFooter>
          {active > 0 && <Button variant="ghost" onClick={clear}>Clear</Button>}
          <Button className="flex-1" onClick={() => setOpen(false)}>Show {shown} {shown === 1 ? 'map' : 'maps'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
