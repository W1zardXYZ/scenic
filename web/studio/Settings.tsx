import { memo, useRef } from 'react'
import { ChevronRight, CloudFog, Crop, Eye, Lasso, Link2, Link2Off, PenTool, Ruler, Save, X } from 'lucide-react'
import { FADE_MAX_MM } from '../../shared/fade.ts'
import { circleCurve, withoutPart } from '../../shared/fog.ts'
import { gridCandidates, PAPERS, type Plane, type Rect } from '../../shared/layout.ts'
import type { MapRecord } from '../../shared/types.ts'
import {
  ColorChoice, ColorWell, Hint, IconButton, IconToggle, LengthField, NumberField, PanelGroup, Segmented, SelectField, SliderField, SwitchRow,
} from '@/components/controls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
import { thumb } from '../api.ts'
import type { Prefs } from '../filters.ts'
import { LevelsControl } from './LevelsControl.tsx'
import type { Filter, FilterMode, Fog, FogDraw, FogItem, FogPart, FogShape, Grid, Marks, Overlay, Tool } from './types.ts'

const SQUARE_PRESETS = [[String(25.4), '1 inch'], ['25', '25 mm'], ['30', '30 mm'], ['32', '32 mm']] as const
const OVERLAY_COLORS = ['#000000', '#ffffff', '#c23b32']
const INK_MODES = [['color', 'Colour'], ['light', 'Saver'], ['grey', 'Grey'], ['threshold', 'B&W']] as const
const PAPER_OPTIONS = PAPERS.map((p) => [p.id, p.label] as const)
const FOG_PAPER_OPTIONS = [['map', 'Same as the map'] as const, ...PAPER_OPTIONS]
const TAB = 'flex flex-col gap-8 pb-(--gutter)'

/** After a change that removes the focused control, once the new controls are on the page. */
const focusIn = (box: React.RefObject<HTMLElement | null>, selector: string) =>
  setTimeout(() => box.current?.querySelector<HTMLElement>(selector)?.focus())

function FogPartFields({ part, index, sq, change, remove, editPoints }: {
  part: FogPart
  index: number
  sq: number
  change: (part: FogPart) => void
  remove?: () => void
  editPoints: () => void
}) {
  const { box } = part
  const editBox = (patch: Partial<Rect>) => change({ ...part, box: { ...box!, ...patch } } as FogPart)
  return (
    <div className="flex flex-col gap-2">
      {(index > 0 || remove) && (
        <div className="flex items-center gap-1">
          {index > 0 ? (
            <Segmented
              label={`Part ${index + 1}`}
              value={part.subtract ? 'subtract' : 'add'}
              options={[['add', 'Add'], ['subtract', 'Subtract']]}
              onChange={(how) => change({ ...part, subtract: how === 'subtract' })}
              className="flex-1"
            />
          ) : <span className="flex-1 text-sm text-muted-foreground">Part 1</span>}
          {remove && <IconButton label={`Remove part ${index + 1}`} icon={X} onClick={remove} className="shrink-0" />}
        </div>
      )}
      {box ? (
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="From left" value={box.x / sq} min={0} step={1} onChange={(x) => editBox({ x: x * sq })} />
          <NumberField label="From top" value={box.y / sq} min={0} step={1} onChange={(y) => editBox({ y: y * sq })} />
          <NumberField label="Squares wide" value={box.w / sq} min={1} step={1} onChange={(w) => editBox({ w: w * sq })} />
          <NumberField label="Squares tall" value={box.h / sq} min={1} step={1} onChange={(h) => editBox({ h: h * sq })} />
        </div>
      ) : (
        <Button variant="secondary" onClick={editPoints}><PenTool data-icon="inline-start" />Edit {part.points.length} points</Button>
      )}
    </div>
  )
}

function FogRow({ item, sq, selected, change, remove, select }: {
  item: FogItem
  sq: number
  selected: boolean
  change: (patch: Partial<FogItem>) => void
  remove: () => void
  select: () => void
}) {
  return (
    <Collapsible data-fog data-selected={selected} className="rounded-lg data-[selected=true]:bg-input">
      <div className="flex items-center gap-1">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Details of ${item.name || 'this fog'}`} className="group/fog shrink-0">
            <ChevronRight className="transition-transform group-data-[state=open]/fog:rotate-90" />
          </Button>
        </CollapsibleTrigger>
        <Input aria-label="Name, printed on the fog" value={item.name} maxLength={60} onChange={(e) => change({ name: e.target.value })} className="bg-transparent px-1.5" />
        <IconToggle label={item.on ? `Hide ${item.name}` : `Show ${item.name}`} icon={Eye} pressed={item.on} onPressedChange={(on) => change({ on })} className="shrink-0" />
        <IconButton label={`Remove ${item.name}`} icon={X} onClick={remove} className="shrink-0" />
      </div>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 px-1 pt-2 pb-2">
          <Segmented
            label="What this does"
            value={item.mode}
            options={[['cover', 'Cover inside'], ['show', 'Show inside']]}
            onChange={(mode) => change({ mode })}
          />
          {item.parts.map((part, i) => (
            <FogPartFields
              key={i}
              part={part}
              index={i}
              sq={sq}
              change={(next) => change({ parts: item.parts.map((p, n) => (n === i ? next : p)) })}
              remove={item.parts.length > 1 ? () => change({ parts: withoutPart(item.parts, i) }) : undefined}
              editPoints={select}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export const Settings = memo(function Settings({
  map, grid, changeGrid, setPixelsPerSquare, lockAspect, setLockAspect, gridDirty, saveGrid, prefs, changeSpec, setPrefs, crop, plane, changeCrop, looseCount, automaticCount,
  overlay, setOverlay, filter, setFilter, fadeMm, setFadeMm, marks, setMarks, fog, setFog, addFog, selectedFog, setSelectedFog, setFogDraw, setTool, tab, setTab,
}: {
  map: MapRecord
  grid: Grid
  changeGrid: (patch: Partial<Grid>) => void
  setPixelsPerSquare: (pps: number) => void
  lockAspect: boolean
  setLockAspect: (lock: boolean) => void
  gridDirty: boolean
  saveGrid: () => void
  prefs: Prefs
  changeSpec: (patch: Partial<Prefs>) => void
  setPrefs: (patch: Partial<Prefs>) => void
  crop: Rect | null
  plane: Plane
  changeCrop: (crop: Rect | null) => void
  looseCount: number
  automaticCount: number
  overlay: Overlay
  setOverlay: (overlay: Overlay) => void
  filter: Filter
  setFilter: React.Dispatch<React.SetStateAction<Filter>>
  fadeMm: number
  setFadeMm: (fadeMm: number) => void
  marks: Marks
  setMarks: (marks: Marks) => void
  fog: Fog
  setFog: (fog: Fog) => void
  addFog: (shape: FogShape) => number
  selectedFog: number[]
  setSelectedFog: (ids: number[]) => void
  setFogDraw: (draw: FogDraw) => void
  setTool: (tool: Tool) => void
  tab: string
  setTab: (tab: string) => void
}) {
  const sq = prefs.squareMm
  const estimated = map.gridSource === 'guess' || map.gridSource === 'pattern'
  const paper = PAPERS.find((p) => p.id === prefs.paperId) ?? PAPERS[0]
  const sheetHint = `${paper.w.toFixed(0)} × ${paper.h.toFixed(0)} mm, margins overlap neighbours`
  const printArea = useRef<HTMLDivElement>(null)
  const fogBox = useRef<HTMLDivElement>(null)
  return (
    <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-0">
      <div className="px-(--gutter) pb-5">
        <TabsList className="w-full">
          <TabsTrigger value="scale">Scale</TabsTrigger>
          <TabsTrigger value="paper">Paper</TabsTrigger>
          <TabsTrigger value="look">Look</TabsTrigger>
          <TabsTrigger value="extras">Extras</TabsTrigger>
        </TabsList>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-(--gutter)">
        <TabsContent value="scale" className={TAB}>
          <PanelGroup title={grid.type === 'square' ? 'Square size' : 'Hex size'}>
            <Segmented
              label="Square size presets"
              value={SQUARE_PRESETS.find(([mm]) => Number(mm) === sq)?.[0] ?? ''}
              options={SQUARE_PRESETS}
              onChange={(mm) => changeSpec({ squareMm: Number(mm) })}
            />
            <LengthField label="Custom" mm={sq} min={1} units={prefs.units} onChange={(squareMm) => changeSpec({ squareMm })} />
          </PanelGroup>

          <PanelGroup
            title="Map grid"
            aside={<Badge variant={estimated ? 'warning' : 'secondary'}>{estimated ? 'Estimated' : map.gridSource === 'manual' ? 'Yours' : 'Detected'}</Badge>}
          >
            <Segmented label="Grid type" value={grid.type} options={[['square', 'Square'], ['hex', 'Hex flat'], ['hexPointy', 'Hex pointy']]} onChange={(type) => changeGrid({ type })} />
            {estimated && (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Likely grid sizes">
                {gridCandidates(map.width, map.height).map((c) => (
                  <Button key={c.pps} variant="secondary" size="sm" onClick={() => setPixelsPerSquare(c.pps)}>
                    {Math.round(c.cols)} × {Math.round(c.rows)}
                  </Button>
                ))}
              </div>
            )}
            <Button variant="secondary" onClick={() => setTool('measure')}><Ruler data-icon="inline-start" />Measure on the map</Button>
            <div className="flex items-end gap-2">
              <NumberField label="Squares wide" value={grid.cols} min={0.5} step={1} onChange={(cols) => changeGrid({ cols })} />
              <Hint label="Keep proportions">
                <Toggle variant="outline" aria-label="Keep proportions" pressed={lockAspect} onPressedChange={setLockAspect} className="shrink-0 p-0 on:bg-input on:text-primary">
                  {lockAspect ? <Link2 /> : <Link2Off />}
                </Toggle>
              </Hint>
              <NumberField label="Squares tall" value={grid.rows} min={0.5} step={1} onChange={(rows) => changeGrid({ rows })} />
            </div>
            <NumberField label={grid.type === 'square' ? 'Pixels per square' : 'Pixels per hex'} value={map.width / grid.cols} min={4} step={1} suffix="px" onChange={setPixelsPerSquare} />
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="group/offset -ml-2.5 text-muted-foreground">
                  <ChevronRight data-icon="inline-start" className="transition-transform group-data-[state=open]/offset:rotate-90" />
                  Offset
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid grid-cols-2 gap-3 pt-2">
                  <NumberField label="Horizontal" value={grid.offsetX} step={1} suffix="px" onChange={(offsetX) => changeGrid({ offsetX })} />
                  <NumberField label="Vertical" value={grid.offsetY} step={1} suffix="px" onChange={(offsetY) => changeGrid({ offsetY })} />
                </div>
              </CollapsibleContent>
            </Collapsible>
            {gridDirty && <Button variant="secondary" onClick={saveGrid}><Save data-icon="inline-start" />Remember for this map</Button>}
          </PanelGroup>
        </TabsContent>

        <TabsContent value="paper" className={TAB}>
          <PanelGroup
            title="Print area"
            aside={crop ? <Button variant="ghost" size="sm" className="-my-1 -mr-2.5" onClick={() => { changeCrop(null); focusIn(printArea, 'button') }}><X data-icon="inline-start" />Clear</Button> : undefined}
          >
            <div ref={printArea}>
            {crop ? (
              <div className="grid grid-cols-2 gap-3">
                <NumberField label="From left" value={crop.x / sq} min={0} step={1} onChange={(x) => changeCrop({ ...crop, x: Math.min(x * sq, plane.w - crop.w) })} />
                <NumberField label="From top" value={crop.y / sq} min={0} step={1} onChange={(y) => changeCrop({ ...crop, y: Math.min(y * sq, plane.h - crop.h) })} />
                <NumberField label="Squares wide" value={crop.w / sq} min={0.5} step={1} onChange={(w) => changeCrop({ ...crop, w: Math.min(w * sq, plane.w - crop.x) })} />
                <NumberField label="Squares tall" value={crop.h / sq} min={0.5} step={1} onChange={(h) => changeCrop({ ...crop, h: Math.min(h * sq, plane.h - crop.y) })} />
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setTool('crop')}><Crop data-icon="inline-start" />Crop on the map</Button>
                <Button variant="ghost" onClick={() => { changeCrop({ x: 0, y: 0, w: plane.w, h: plane.h }); focusIn(printArea, 'input') }}>Enter a size</Button>
              </div>
            )}
            </div>
          </PanelGroup>
          <PanelGroup>
            <SelectField label="Size" value={prefs.paperId} options={PAPER_OPTIONS} onChange={(paperId) => changeSpec({ paperId })} />
            <Segmented
              label="Orientation"
              value={prefs.orientation}
              options={[['auto', 'Auto'], ['portrait', 'Portrait'], ['landscape', 'Landscape']]}
              onChange={(orientation) => changeSpec({ orientation })}
            />
          </PanelGroup>
          <PanelGroup>
            <div className="grid grid-cols-2 gap-3">
              <LengthField label="Margin" mm={prefs.marginMm} units={prefs.units} onChange={(marginMm) => changeSpec({ marginMm })} />
              <LengthField label="Overlap" mm={prefs.overlapMm} units={prefs.units} onChange={(overlapMm) => changeSpec({ overlapMm })} />
            </div>
            <Segmented label="Units" value={prefs.units} options={[['metric', 'Metric'], ['imperial', 'Imperial']]} onChange={(units) => setPrefs({ units })} />
          </PanelGroup>
          <SwitchRow
            label="Cut along grid lines"
            checked={prefs.seamsOnGrid}
            onCheckedChange={(seamsOnGrid) => changeSpec({ seamsOnGrid })}
            hint={prefs.seamsOnGrid && looseCount !== automaticCount ? `Off uses ${looseCount} sheets` : undefined}
          />
          <SwitchRow
            label="Centre sheets on the print area"
            hint="Off starts at the top left"
            checked={prefs.centered}
            onCheckedChange={(centered) => changeSpec({ centered })}
          />
          <SwitchRow
            label="Show full sheet size"
            hint={sheetHint}
            checked={prefs.showSheets}
            onCheckedChange={(showSheets) => setPrefs({ showSheets })}
          />
        </TabsContent>

        <TabsContent value="look" className={TAB}>
          <PanelGroup>
            <SwitchRow
              label="Print a grid"
              hint={map.hasGrid ? 'This file already has one' : undefined}
              checked={overlay.show}
              onCheckedChange={(show) => setOverlay({ ...overlay, show })}
            />
            {overlay.show && (
              <>
                <ColorChoice label="Grid colour" value={overlay.color} options={OVERLAY_COLORS} onChange={(color) => setOverlay({ ...overlay, color })} />
                <SliderField label="Strength" value={overlay.opacity} display={`${Math.round(overlay.opacity * 100)}%`} min={0.05} max={1} step={0.05} onChange={(opacity) => setOverlay({ ...overlay, opacity })} />
                <SliderField label="Line width" value={overlay.widthMm} display={`${overlay.widthMm.toFixed(2)} mm`} min={0.05} max={1} step={0.05} onChange={(widthMm) => setOverlay({ ...overlay, widthMm })} />
                {grid.type === 'hex' && <SwitchRow label="BattleTech hex numbers" checked={overlay.numbering} onCheckedChange={(numbering) => setOverlay({ ...overlay, numbering })} />}
              </>
            )}
          </PanelGroup>
          <PanelGroup title="Ink" aside={<span className="text-xs text-muted-foreground tabular-nums">{Math.round(map.ink * 100)}% coverage</span>}>
            <Segmented<FilterMode> label="Colour mode" value={filter.mode} options={INK_MODES} onChange={(mode) => setFilter({ ...filter, mode })} />
            {(filter.mode === 'light' || filter.mode === 'threshold') && (
              <SliderField
                label={filter.mode === 'light' ? 'Lighten' : 'Cut-off'}
                value={filter.amount}
                display={`${Math.round(filter.amount * 100)}%`}
                min={0.05}
                max={0.95}
                step={0.05}
                onChange={(amount) => setFilter({ ...filter, amount })}
              />
            )}
            {(filter.mode === 'grey' || filter.mode === 'threshold') && (
              <LevelsControl src={thumb(map, 'large')} filter={filter} setFilter={setFilter} />
            )}
          </PanelGroup>
          <PanelGroup title="Edges">
            <SliderField
              label="Fade to paper"
              value={fadeMm}
              display={fadeMm ? `${fadeMm} mm` : 'Off'}
              min={0}
              max={FADE_MAX_MM}
              step={1}
              onChange={setFadeMm}
            />
            <p className="text-xs text-muted-foreground">Dissolves the outer edge of {crop ? 'the print area' : 'the map'} into the white of the paper and saves ink on dark maps. Seams between sheets are not faded.</p>
          </PanelGroup>
        </TabsContent>

        <TabsContent value="extras" className={TAB}>
          <PanelGroup>
            <SwitchRow label="Cut marks" checked={marks.cut} onCheckedChange={(cut) => setMarks({ ...marks, cut })} />
            <SwitchRow label="Sheet labels" checked={marks.labels} onCheckedChange={(labels) => setMarks({ ...marks, labels })} />
            <SwitchRow label="Assembly sheet" hint="Overview and a scale check" checked={marks.overview} onCheckedChange={(overview) => setMarks({ ...marks, overview })} />
          </PanelGroup>
          <PanelGroup
            title="Fog of war"
            aside={fog.items.length > 0 ? <ColorWell label="Fog cover colour" value={fog.fill} onChange={(fill) => setFog({ ...fog, fill })} /> : undefined}
          >
            <div ref={fogBox} className="flex flex-col gap-3">
              {fog.items.length > 0 && (
                <>
                  <SwitchRow label="All fog" checked={fog.on} onCheckedChange={(on) => setFog({ ...fog, on })} />
                  <div className="flex flex-col gap-1">
                    {fog.items.map((item) => (
                      <FogRow
                        key={item.id}
                        item={item}
                        sq={sq}
                        selected={selectedFog.includes(item.id)}
                        change={(patch) => setFog({ ...fog, items: fog.items.map((i) => (i.id === item.id ? { ...i, ...patch } as FogItem : i)) })}
                        remove={() => { setFog({ ...fog, items: fog.items.filter((i) => i.id !== item.id) }); focusIn(fogBox, '[data-add-fog]') }}
                        select={() => { setSelectedFog([item.id]); setFogDraw('select'); setTool('fog') }}
                      />
                    ))}
                  </div>
                </>
              )}
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" onClick={() => { setFogDraw('box'); setTool('fog') }}><CloudFog data-icon="inline-start" />Draw a box</Button>
                <Button variant="secondary" onClick={() => { setFogDraw('lasso'); setTool('fog') }}><Lasso data-icon="inline-start" />Draw a shape</Button>
                <Button data-add-fog variant="ghost" onClick={() => { addFog({ box: { x: 0, y: 0, w: sq * 5, h: sq * 5 } }); focusIn(fogBox, '[data-fog]:last-child input') }}>Add a box</Button>
                <Button variant="ghost" onClick={() => { setSelectedFog([addFog({ points: circleCurve(plane.w / 2, plane.h / 2, sq * 3) })]); setFogDraw('select'); setTool('fog') }}>Add a shape</Button>
              </div>
              {fog.items.length > 0 && (
                <>
                  <SwitchRow
                    label="Print fog separately"
                    hint={fog.separate ? 'On its own sheets, outlined to cut out. Show inside stays on the map' : 'Off prints it on the map'}
                    checked={fog.separate}
                    onCheckedChange={(separate) => setFog({ ...fog, separate })}
                  />
                  {!fog.separate && <SwitchRow label="Outline on the map" checked={fog.outline} onCheckedChange={(outline) => setFog({ ...fog, outline })} />}
                  {fog.separate && (
                    <SelectField
                      label="Fog card paper"
                      value={fog.paper ?? 'map'}
                      options={FOG_PAPER_OPTIONS}
                      onChange={(paper) => setFog({ ...fog, paper: paper === 'map' ? undefined : paper })}
                    />
                  )}
                  <SwitchRow
                    label="Print area names"
                    hint={fog.names ? 'Players will see them' : fog.separate ? 'Hidden from players. The overview still lists them' : 'Hidden from players'}
                    checked={!!fog.names}
                    onCheckedChange={(names) => setFog({ ...fog, names })}
                  />
                </>
              )}
            </div>
          </PanelGroup>
        </TabsContent>
      </ScrollArea>
    </Tabs>
  )
})
