import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Download, ExternalLink, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import {
  columnsOf, generatePages, generatePagesIn, pageLabel, PAPERS, type Plane, type Rect,
} from '../shared/layout.ts'
import { type FogItem, type FogPart, type FogShape, fogPlan, NEW_FOG, scaleFog } from '../shared/fog.ts'
import type { Library, MapRecord } from '../shared/types.ts'
import { NEUTRAL_LEVELS } from '../shared/tone.ts'
import { AppBar } from '@/components/app-bar'
import { GradeBadge, IconButton, Segmented } from '@/components/controls'
import { Trail } from '@/components/trail'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useHistory } from '@/hooks/use-history'
import { useMediaQuery } from '@/hooks/use-media-query'
import { cn } from '@/lib/utils'
import { announce } from './announce.ts'
import { api, createPrint } from './api.ts'
import { type Index, grade, pageSpec, type Prefs } from './filters.ts'
import { sceneScope } from './scope.ts'
import { Canvas } from './studio/Canvas.tsx'
import { Settings } from './studio/Settings.tsx'
import type { Filter, Fog, FogCombine, FogDraw, Grid, LabeledPage, Marks, Overlay, Tool } from './studio/types.ts'

const IN = 25.4

const QUALITIES = [['high', 'Best quality'], ['balanced', 'Balanced'], ['small', 'Smallest file']] as const

export function PrintStudio({ map, library, index, prefs, setPrefs, onChanged }: {
  map: MapRecord
  library: Library
  index: Index
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
  onChanged: () => void
}) {
  const group = library.groups.find((g) => g.id === map.groupId)!
  const siblings = useMemo(() => group.mapIds.map((id) => index.byId.get(id)!).filter(Boolean), [group, index])

  const measured: Grid = useMemo(() => ({
    type: map.gridType, cols: map.width / map.ppsX, rows: map.height / map.ppsY, offsetX: map.offsetX, offsetY: map.offsetY,
  }), [map])
  const [grid, setGrid] = useState<Grid>(measured)
  const [lockAspect, setLockAspect] = useState(true)
  const [overlay, setOverlay] = useState<Overlay>({ show: !map.hasGrid, color: '#000000', opacity: 0.35, widthMm: 0.2, numbering: false })
  const [filter, setFilter] = useState<Filter>({ mode: 'color', amount: 0.3, levels: NEUTRAL_LEVELS })
  const [marks, setMarks] = useState<Marks>({ cut: true, labels: true, overview: true })
  // Kept as a share of the map, so fog stays on the same spot when the scale changes.
  const [fogShare, setFogShare] = useState<Fog>(NEW_FOG)
  // Newest last: that one is what gets edited, and what new parts join.
  const [selectedFog, setSelectedFog] = useState<number[]>([])
  const [fogDraw, setFogDraw] = useState<FogDraw>('box')
  const [fogCombine, setFogCombine] = useState<FogCombine>('new')
  const [fogSnap, setFogSnap] = useState(true)
  const [output, setOutput] = useState<{ format: 'pdf' | 'png'; quality: 'high' | 'balanced' | 'small' }>({ format: 'pdf', quality: 'high' })
  const [manual, setManual] = useState<LabeledPage[] | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set())
  // Temporary, and kept as a share of the map so it stays on the same area when the scale changes.
  const [cropShare, setCropShare] = useState<Rect | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [job, setJob] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ url: string; key: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState('scale')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 64rem)')
  // At 200% zoom on a laptop: the canvas gets the height, everything but Create moves into the sheet.
  const short = useMediaQuery('(max-height: 30rem)') && !wide
  const resultLink = useRef<HTMLAnchorElement>(null)
  const justCreated = useRef(false)

  const spec = useMemo(() => pageSpec(prefs), [prefs])
  const sq = prefs.squareMm
  const pxX = map.width / grid.cols
  const pxY = map.height / grid.rows
  const plane: Plane = useMemo(() => ({
    w: grid.cols * sq, h: grid.rows * sq, offsetX: (grid.offsetX / pxX) * sq, offsetY: (grid.offsetY / pxY) * sq,
  }), [grid, sq, pxX, pxY])

  const crop = useMemo(() => (cropShare
    ? { x: cropShare.x * plane.w, y: cropShare.y * plane.h, w: cropShare.w * plane.w, h: cropShare.h * plane.h }
    : null), [cropShare, plane])

  const automatic = useMemo(() => {
    const pages = crop ? generatePagesIn(crop, plane, spec) : generatePages(plane, spec)
    const columns = columnsOf(pages)
    return pages.map((p, i): LabeledPage => ({ ...p, label: pageLabel(i, columns) }))
  }, [crop, plane, spec])
  const pages = manual ?? automatic
  const fog = useMemo(() => scaleFog(fogShare, plane.w, plane.h), [fogShare, plane.w, plane.h])
  const setFog = useCallback((next: Fog) => setFogShare(scaleFog(next, 1 / plane.w, 1 / plane.h)), [plane.w, plane.h])
  const fogCount = useMemo(() => {
    const reference = pages[0]
    if (!reference) return 0
    // The placement page comes first, whenever there is anything to place.
    const { sheets } = fogPlan(fog, reference.sheetW, reference.sheetH, prefs.marginMm, sq, crop)
    return sheets ? sheets + 1 : 0
  }, [crop, fog, pages, prefs.marginMm, sq])
  const looseCount = useMemo(() => {
    const loose = { ...spec, seamsOnGrid: false }
    return (crop ? generatePagesIn(crop, plane, loose) : generatePages(plane, loose)).length
  }, [crop, plane, spec])

  const editPages = useCallback(
    (change: (current: LabeledPage[]) => LabeledPage[]) => setManual((m) => change(m ?? automatic)),
    [automatic],
  )

  const changeSpec = useCallback((patch: Partial<Prefs>) => {
    setManual(null)
    setSelected(new Set())
    setPrefs(patch)
  }, [setPrefs])

  const changeCrop = useCallback((next: Rect | null) => {
    setManual(null)
    setSelected(new Set())
    setCropShare(next && { x: next.x / plane.w, y: next.y / plane.h, w: next.w / plane.w, h: next.h / plane.h })
  }, [plane])

  const changeGrid = useCallback((patch: Partial<Grid>) => {
    setSaved(false)
    setManual(null)
    setGrid((g) => {
      const next = { ...g, ...patch }
      if (lockAspect && patch.cols !== undefined) next.rows = g.rows * (patch.cols / g.cols)
      if (lockAspect && patch.rows !== undefined) next.cols = g.cols * (patch.rows / g.rows)
      return next
    })
  }, [lockAspect])

  /** One cell drawn on the map sets the scale and lines the grid up with it. */
  const measureCell = useCallback((cell: Rect) => {
    setSaved(false)
    setManual(null)
    setGrid((g) => {
      const toPxX = (map.width / g.cols) / sq
      const toPxY = (map.height / g.rows) / sq
      const across = cell.w * toPxX
      const pps = g.type === 'square' ? (across + cell.h * toPxY) / 2 : across
      return { ...g, cols: map.width / pps, rows: map.height / pps, offsetX: (cell.x * toPxX) % pps, offsetY: (cell.y * toPxY) % pps }
    })
    setTab('scale')
  }, [map.width, map.height, sq])

  const setPixelsPerSquare = useCallback((pps: number) => {
    setSaved(false)
    setManual(null)
    setGrid((g) => ({ ...g, cols: map.width / pps, rows: map.height / pps }))
  }, [map.width, map.height])

  const addFog = useCallback((shape: FogShape) => {
    const id = Math.max(0, ...fog.items.map((i) => i.id)) + 1
    const kind = shape.box ? 'Fog' : 'Shape'
    const same = fog.items.filter((i) => !i.parts[0].box === !shape.box).length
    setFog({ ...fog, on: true, items: [...fog.items, { id, name: `${kind} ${same + 1}`, on: true, mode: 'cover', parts: [{ ...shape, subtract: false }] }] })
    return id
  }, [fog, setFog])
  const changeFogParts = useCallback((id: number, parts: FogPart[]) => {
    setFog({ ...fog, items: fog.items.map((i) => (i.id === id ? { ...i, parts } : i)) })
  }, [fog, setFog])
  /** A finished drawing: a new fog, or a new part of the selected one. */
  const finishFogShape = useCallback((shape: FogShape) => {
    const target = fogCombine === 'new' ? undefined : fog.items.find((i) => i.id === selectedFog.at(-1))
    if (target) changeFogParts(target.id, [...target.parts, { ...shape, subtract: fogCombine === 'subtract' }])
    else setSelectedFog([addFog(shape)])
  }, [addFog, changeFogParts, fog, fogCombine, selectedFog])
  const mergeFog = useCallback(() => {
    const [first, ...rest] = selectedFog.map((id) => fog.items.find((i) => i.id === id)).filter((i) => !!i) as FogItem[]
    if (!first || !rest.length) return
    const merged = { ...first, parts: [first, ...rest].flatMap((i) => i.parts) }
    setFog({ ...fog, items: fog.items.filter((i) => !rest.includes(i)).map((i) => (i === first ? merged : i)) })
    setSelectedFog([first.id])
    announce(`${rest.length + 1} fogs merged`)
  }, [fog, selectedFog, setFog])
  const removeFog = useCallback((ids: number[]) => {
    setFog({ ...fog, items: fog.items.filter((i) => !ids.includes(i.id)) })
    setSelectedFog([])
  }, [fog, setFog])

  const { squareMm, paperId, orientation, marginMm, overlapMm, seamsOnGrid, centered } = prefs
  const restore = useCallback(({ grid, overlay, filter, marks, fogShare, manual, cropShare, ...paper }: {
    grid: Grid; overlay: Overlay; filter: Filter; marks: Marks; fogShare: Fog; manual: LabeledPage[] | null; cropShare: Rect | null
  } & Pick<Prefs, 'squareMm' | 'paperId' | 'orientation' | 'marginMm' | 'overlapMm' | 'seamsOnGrid' | 'centered'>) => {
    setGrid(grid)
    setOverlay(overlay)
    setFilter(filter)
    setMarks(marks)
    setFogShare(fogShare)
    setManual(manual)
    setCropShare(cropShare)
    setPrefs(paper)
    setSelected(new Set())
    setSaved(false)
  }, [setPrefs])
  const { undo, redo, canUndo, canRedo } = useHistory(
    useMemo(() => ({ grid, overlay, filter, marks, fogShare, manual, cropShare, squareMm, paperId, orientation, marginMm, overlapMm, seamsOnGrid, centered }),
      [grid, overlay, filter, marks, fogShare, manual, cropShare, squareMm, paperId, orientation, marginMm, overlapMm, seamsOnGrid, centered]),
    restore,
  )

  useEffect(() => {
    if (tool === 'fog') setTab('extras')
    if (tool === 'crop') setTab('paper')
  }, [tool])

  const request = useMemo(() => ({
    mapId: map.id,
    squareMm: sq,
    marginMm: prefs.marginMm,
    grid,
    overlay,
    pages,
    filter,
    marks,
    fog,
    output,
    ...(crop && { crop }),
  }), [map.id, sq, prefs.marginMm, grid, overlay, pages, filter, marks, fog, output, crop])
  const requestKey = useMemo(() => JSON.stringify(request), [request])
  const ready = result?.key === requestKey ? result : null

  const create = async () => {
    if (job) return
    setJob({ done: 0, total: pages.length })
    announce('Rendering started')
    let quarters = 0
    try {
      const url = await createPrint(request, (done, total) => {
        setJob({ done, total })
        const reached = Math.floor((done / total) * 4)
        if (reached > quarters && reached < 4) announce(`Rendering ${reached * 25}%`)
        quarters = reached
      })
      justCreated.current = true
      setResult({ url, key: requestKey })
      announce(`${output.format.toUpperCase()} ready`)
    } catch (e) {
      toast.error((e as Error).message)
    }
    setJob(null)
  }

  // Create is replaced by its result, so focus moves on with it.
  useEffect(() => {
    if (!ready || !justCreated.current) return
    justCreated.current = false
    resultLink.current?.focus()
  }, [ready])

  const saveGrid = useCallback(() => {
    const { cols, rows, offsetX, offsetY, type } = grid
    api.patchMap(map.id, { grid: { cols, rows, offsetX, offsetY, type } }).then(
      () => {
        setSaved(true)
        toast.success('Saved for every matching file')
        onChanged()
      },
      (e: Error) => void toast.error(e.message),
    )
  }, [grid, map.id, onChanged])

  const gridDirty = !saved && (Math.abs(grid.cols - measured.cols) > 0.001 || Math.abs(grid.rows - measured.rows) > 0.001 || grid.offsetX !== measured.offsetX || grid.offsetY !== measured.offsetY || grid.type !== measured.type)
  const ppi = pxX / (sq / IN)
  const quality = grade(ppi)
  const total = pages.length + fogCount + (marks.overview && output.format === 'pdf' ? 1 : 0)
  const printed = crop ?? plane
  const widthM = printed.w / 1000
  const heightM = printed.h / 1000
  const size = prefs.units === 'metric'
    ? `${(printed.w / 10).toFixed(0)} × ${(printed.h / 10).toFixed(0)} cm`
    : `${(printed.w / IN).toFixed(1)} × ${(printed.h / IN).toFixed(1)} in`

  const settings = (
    <Settings
      map={map}
      grid={grid}
      changeGrid={changeGrid}
      setPixelsPerSquare={setPixelsPerSquare}
      lockAspect={lockAspect}
      setLockAspect={setLockAspect}
      gridDirty={gridDirty}
      saveGrid={saveGrid}
      prefs={prefs}
      changeSpec={changeSpec}
      setPrefs={setPrefs}
      crop={crop}
      plane={plane}
      changeCrop={changeCrop}
      looseCount={looseCount}
      automaticCount={automatic.length}
      overlay={overlay}
      setOverlay={setOverlay}
      filter={filter}
      setFilter={setFilter}
      marks={marks}
      setMarks={setMarks}
      fog={fog}
      setFog={setFog}
      addFog={addFog}
      selectedFog={selectedFog}
      setSelectedFog={setSelectedFog}
      setFogDraw={setFogDraw}
      setTool={setTool}
      tab={tab}
      setTab={setTab}
    />
  )

  const settingsButton = <IconButton label="Settings" icon={SlidersHorizontal} variant="outline" onClick={() => setSettingsOpen(!settingsOpen)} />

  const summary = (
    <div className="flex items-start justify-between gap-3 p-(--gutter) max-lg:pb-3">
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <strong className="text-4xl leading-none font-medium tabular-nums max-lg:text-3xl">{total}</strong>
          <span className="text-muted-foreground">{total === 1 ? 'sheet' : 'sheets'} of {PAPERS.find((p) => p.id === prefs.paperId)?.label}</span>
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <span>{widthM >= 1 || heightM >= 1 ? `${widthM.toFixed(2)} × ${heightM.toFixed(2)} m` : size}</span>
          <GradeBadge grade={quality} />
          <span>{Math.round(ppi)} ppi</span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {manual && (
          <Button variant="ghost" size="sm" onClick={() => { setManual(null); setSelected(new Set()) }}>
            <RotateCcw data-icon="inline-start" />Reset
          </Button>
        )}
        {!wide && !short && settingsButton}
      </div>
    </div>
  )

  const formats = (
      <div className="flex gap-2">
        <Segmented label="File type" value={output.format} options={[['pdf', 'PDF'], ['png', 'PNG']]} onChange={(format) => setOutput({ ...output, format })} className="flex-1" />
        <Select value={output.quality} onValueChange={(next) => setOutput({ ...output, quality: next as typeof output.quality })}>
          <SelectTrigger aria-label="Image quality" className="min-w-0 flex-1"><SelectValue /></SelectTrigger>
          <SelectContent position="popper" align="end">
            <SelectGroup>
              {QUALITIES.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
  )

  const action = ready ? (
        <>
          <div className="flex gap-2">
            {output.format === 'pdf' && (
              <Button size="lg" className="flex-1" asChild>
                <a ref={resultLink} href={ready.url} target="_blank" rel="noreferrer"><ExternalLink data-icon="inline-start" />Open PDF</a>
              </Button>
            )}
            <Button size="lg" variant={output.format === 'pdf' ? 'secondary' : 'default'} className="flex-1" asChild>
              <a ref={output.format === 'pdf' ? undefined : resultLink} href={`${ready.url}&download=1`} download><Download data-icon="inline-start" />Download</a>
            </Button>
          </div>
          {!short && <p className="text-xs text-muted-foreground">Print at 100% / actual size, with “fit to page” off.</p>}
        </>
      ) : (
        <>
          {/* aria-disabled rather than disabled, so a keyboard user's focus stays on it while rendering. */}
          <Button size="lg" className="w-full aria-disabled:opacity-70" aria-disabled={!!job} disabled={!pages.length} onClick={create}>
            {job && <Spinner data-icon="inline-start" />}
            {job ? `Rendering ${job.done} of ${job.total}` : output.format === 'pdf' ? 'Create PDF' : 'Create PNG sheets'}
          </Button>
          {job && <Progress aria-label="Rendering progress" value={job.total ? (job.done / job.total) * 100 : 0} className="h-1" />}
        </>
      )

  return (
    <div className="fixed inset-0 flex flex-col bg-canvas lg:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AppBar>
          <IconButton label="Back" shortcut="Esc" side="right" icon={ArrowLeft} href={`#/map/${map.id}`} className="-ml-2" />
          <h1 className="sr-only">{group.title}</h1>
          <Trail scope={sceneScope(group)} scene={{ title: group.title, href: `#/map/${map.id}` }} className={siblings.length > 1 ? 'min-w-0 max-md:hidden' : 'min-w-0'} />
          {siblings.length > 1 && (
            <Select value={String(map.id)} onValueChange={(id) => (window.location.hash = `#/print/${id}`)}>
              <SelectTrigger aria-label="Variant" className="min-w-0 bg-transparent max-sm:flex-1 sm:max-w-72"><SelectValue /></SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectGroup>
                  {siblings.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>{m.variant || 'Standard'} · {m.hasGrid ? 'grid' : 'no grid'} · {m.format.toUpperCase()}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
        </AppBar>
        <main className="flex min-h-0 flex-1 flex-col">
        <Canvas
          map={map}
          plane={plane}
          spec={spec}
          gridType={grid.type}
          sq={sq}
          overlay={overlay}
          filter={filter}
          fog={fog}
          pages={pages}
          automatic={automatic}
          editPages={editPages}
          selected={selected}
          setSelected={setSelected}
          tool={tool}
          setTool={setTool}
          fogDraw={fogDraw}
          setFogDraw={setFogDraw}
          fogCombine={fogCombine}
          setFogCombine={setFogCombine}
          fogSnap={fogSnap}
          setFogSnap={setFogSnap}
          finishFogShape={finishFogShape}
          changeFogParts={changeFogParts}
          mergeFog={mergeFog}
          removeFog={removeFog}
          selectedFog={selectedFog}
          setSelectedFog={setSelectedFog}
          undo={undo}
          redo={redo}
          canUndo={canUndo}
          canRedo={canRedo}
          crop={crop}
          onCrop={changeCrop}
          onMeasure={measureCell}
          showSheets={prefs.showSheets}
          backHref={`#/map/${map.id}`}
          shortcuts={prefs.shortcuts}
        />
        </main>
      </div>

      <aside aria-label="Print settings" className="flex shrink-0 flex-col bg-card lg:w-96">
        {!short && summary}
        {wide ? settings : (
          <Sheet open={settingsOpen} onOpenChange={setSettingsOpen} modal={false}>
            <SheetContent
              side="bottom"
              aria-describedby={undefined}
              className={cn('gap-0 rounded-t-xl', short ? 'h-dvh' : 'h-[60dvh]')}
              onInteractOutside={(e) => e.preventDefault()}
              onOpenAutoFocus={(e) => e.preventDefault()}
            >
              <SheetHeader className="pb-5"><SheetTitle>Settings</SheetTitle></SheetHeader>
              {short && summary}
              {short && <div className="px-(--gutter) pb-5">{formats}</div>}
              {settings}
            </SheetContent>
          </Sheet>
        )}
        <div className={cn('flex flex-col gap-3 px-(--gutter) pb-[max(var(--gutter),env(safe-area-inset-bottom))]', short && 'pt-2 pb-2')}>
          {!short && formats}
          <div className={cn('flex flex-col gap-3', short && 'flex-row items-center gap-2 *:min-w-0')}>
            {short && settingsButton}
            <div className="flex flex-1 flex-col gap-3">{action}</div>
          </div>
        </div>
      </aside>
    </div>
  )
}
