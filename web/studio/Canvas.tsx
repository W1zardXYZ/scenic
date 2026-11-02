import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CloudFog, Crop, Hand, Lasso, Magnet, Maximize, MousePointer2, Pentagon, Plus, Redo2, Ruler, RotateCw, Square, SquarePlus, SquaresSubtract, SquaresUnite, Trash2, Undo2, ZoomOut, type LucideIcon } from 'lucide-react'
import { curveFromStroke, type CurvePoint, type Fog, fogBounds, type FogPart, type FogShape, fogPath, inkOn, liveFog, nearestOnCurve, partBounds, partPath, sharpCurve, splitCurve, withoutPart } from '../../shared/fog.ts'
import { gridSegments, hexNumbers, type Page, type PageSpec, type Plane, type Rect } from '../../shared/layout.ts'
import { toneCurve } from '../../shared/tone.ts'
import type { MapRecord } from '../../shared/types.ts'
import { Hint, IconButton, IconToggle } from '@/components/controls'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { announce } from '../announce.ts'
import { thumb } from '../api.ts'
import { lassoTouches, type Point, rectsTouch } from './hit.ts'
import type { Filter, FogCombine, FogDraw, Grid, LabeledPage, Overlay, Tool } from './types.ts'

const SNAP_PX = 10
const TOOLBAR_PX = 64
const SNAP_FOG_PX = 12

const TOOL_HINT: Partial<Record<Tool, string>> = { page: 'Click to place a sheet, or press Enter to add one beside the current sheet', crop: 'Drag the area to print', measure: 'Drag over exactly one square or hex' }

const TOOLS: { value: Tool; label: string; shortcut: string; icon: LucideIcon }[] = [
  { value: 'select', label: 'Select', shortcut: 'S', icon: MousePointer2 },
  { value: 'lasso', label: 'Lasso select', shortcut: 'L', icon: Lasso },
  { value: 'hand', label: 'Hand', shortcut: 'H', icon: Hand },
  { value: 'page', label: 'Add sheet', shortcut: 'C', icon: SquarePlus },
  { value: 'crop', label: 'Print crop', shortcut: 'X', icon: Crop },
  { value: 'fog', label: 'Add fog', shortcut: 'F', icon: CloudFog },
  { value: 'measure', label: 'Measure one square', shortcut: 'M', icon: Ruler },
]

const FOG_HINT: Record<FogDraw, string> = {
  select: 'Click a fog to edit it, Shift-click to pick several. Drag to move it, Alt-drag to move one part, Backspace removes the clicked part',
  box: 'Drag to draw a box',
  lasso: 'Draw freehand; the line is smoothed when you let go',
  polygon: 'Click each corner. Click the first point, double-click or press Enter to finish',
}

const FOG_DRAWS: { value: FogDraw; label: string; shortcut: string; icon: LucideIcon }[] = [
  { value: 'select', label: 'Select and edit fog', shortcut: 'A', icon: MousePointer2 },
  { value: 'box', label: 'Box', shortcut: 'B', icon: Square },
  { value: 'lasso', label: 'Lasso', shortcut: 'L', icon: Lasso },
  { value: 'polygon', label: 'Polygon', shortcut: 'P', icon: Pentagon },
]

const FOG_COMBINES: { value: FogCombine; label: string; icon: LucideIcon }[] = [
  { value: 'new', label: 'New fog', icon: SquarePlus },
  { value: 'add', label: 'Add to the selected fog', icon: SquaresUnite },
  { value: 'subtract', label: 'Subtract from the selected fog', icon: SquaresSubtract },
]

const CROP_HANDLES: { id: string; x: number; y: number; cursor: string }[] = [
  { id: 'nw', x: 0, y: 0, cursor: 'nwse-resize' }, { id: 'n', x: 0.5, y: 0, cursor: 'ns-resize' }, { id: 'ne', x: 1, y: 0, cursor: 'nesw-resize' },
  { id: 'e', x: 1, y: 0.5, cursor: 'ew-resize' }, { id: 'se', x: 1, y: 1, cursor: 'nwse-resize' }, { id: 's', x: 0.5, y: 1, cursor: 'ns-resize' },
  { id: 'sw', x: 0, y: 1, cursor: 'nesw-resize' }, { id: 'w', x: 0, y: 0.5, cursor: 'ew-resize' },
]

const DIRECTION: Record<string, { step: [number, number]; word: string }> = {
  ArrowLeft: { step: [-1, 0], word: 'left' }, ArrowRight: { step: [1, 0], word: 'right' }, ArrowUp: { step: [0, -1], word: 'up' }, ArrowDown: { step: [0, 1], word: 'down' },
}

const isField = (target: EventTarget | null) =>
  !!(target as Element).closest?.('input, select, textarea, [role=slider], [role=listbox], [role=combobox], [role=menu]')

function snapPage<T extends Page>(page: T, others: Page[], plane: Plane, overlap: number, threshold: number, square: number, toGrid: boolean): T {
  const options = (start: number, size: number, limit: number, offset: number, near: number[], far: number[]) => {
    const list = [0, limit - size, ...near.map((v) => v - overlap), ...far.map((v) => v - size + overlap), ...near.map((v) => v - size), ...far]
    if (toGrid) {
      const k = Math.round((start - offset) / square)
      list.push(offset + k * square)
    }
    let best = start
    let distance = threshold
    for (const c of list) {
      const d = Math.abs(c - start)
      if (d < distance) {
        distance = d
        best = c
      }
    }
    return best
  }
  return {
    ...page,
    x: options(page.x, page.w, plane.w, plane.offsetX, others.map((o) => o.x + o.w), others.map((o) => o.x)),
    y: options(page.y, page.h, plane.h, plane.offsetY, others.map((o) => o.y + o.h), others.map((o) => o.y)),
  }
}

// The layers below are memoised so panning and zooming only touch the viewBox.

const SheetBacks = memo(function SheetBacks({ pages }: { pages: LabeledPage[] }) {
  return pages.map((p, i) => (
    <rect key={i} className="canvas-sheet" x={p.x - (p.sheetW - p.w) / 2} y={p.y - (p.sheetH - p.h) / 2} width={p.sheetW} height={p.sheetH} />
  ))
})

const SheetEdges = memo(function SheetEdges({ pages }: { pages: LabeledPage[] }) {
  return pages.map((p, i) => (
    <rect key={i} className="canvas-sheet-edge" x={p.x - (p.sheetW - p.w) / 2} y={p.y - (p.sheetH - p.h) / 2} width={p.sheetW} height={p.sheetH} />
  ))
})

const Art = memo(function Art({ map, plane, gridType, sq, overlay, filter }: {
  map: MapRecord
  plane: Plane
  gridType: Grid['type']
  sq: number
  overlay: Overlay
  filter: Filter
}) {
  const showGridGuide = overlay.show
  const overlayPath = useMemo(() => {
    if (!showGridGuide) return ''
    const area = { x: 0, y: 0, w: plane.w, h: plane.h }
    return gridSegments(gridType, area, sq, plane.offsetX, plane.offsetY)
      .map(([a, b, c, d]) => `M${a.toFixed(2)} ${b.toFixed(2)}L${c.toFixed(2)} ${d.toFixed(2)}`).join('')
  }, [showGridGuide, gridType, plane, sq])
  const numbers = useMemo(
    () => (showGridGuide && gridType === 'hex' && overlay.numbering ? hexNumbers({ x: 0, y: 0, w: plane.w, h: plane.h }, sq, plane.offsetX, plane.offsetY) : []),
    [showGridGuide, gridType, overlay.numbering, plane, sq],
  )
  const toned = filter.mode === 'grey' || filter.mode === 'threshold'
  const table = useMemo(() => Array.from(toneCurve(filter.levels), (v) => (v / 255).toFixed(4)).join(' '), [filter.levels])

  return (
    <>
      <defs>
        <filter id="tone" colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR type="table" tableValues={table} />
            <feFuncG type="table" tableValues={table} />
            <feFuncB type="table" tableValues={table} />
          </feComponentTransfer>
          {filter.mode === 'threshold' && (
            <feComponentTransfer>
              <feFuncR type="linear" slope="255" intercept={-255 * filter.amount} />
              <feFuncG type="linear" slope="255" intercept={-255 * filter.amount} />
              <feFuncB type="linear" slope="255" intercept={-255 * filter.amount} />
            </feComponentTransfer>
          )}
        </filter>
      </defs>
      <image href={thumb(map, 'large')} x={0} y={0} width={plane.w} height={plane.h} preserveAspectRatio="none" style={{ filter: toned ? 'url(#tone)' : undefined }} />
      {filter.mode === 'light' && <rect x={0} y={0} width={plane.w} height={plane.h} fill="#fff" opacity={filter.amount} />}
      {overlayPath && (
        <path d={overlayPath} fill="none" stroke={overlay.color} strokeOpacity={overlay.opacity} strokeWidth={overlay.widthMm} vectorEffect="non-scaling-stroke" />
      )}
      {numbers.map((n) => (
        <text key={n.text} x={n.x} y={n.y + sq * 0.1} fontSize={sq * 0.12} textAnchor="middle" fill={overlay.color} opacity={overlay.opacity}>{n.text}</text>
      ))}
    </>
  )
})

const FogLayer = memo(function FogLayer({ fog, plane }: { fog: Fog; plane: Plane }) {
  const live = liveFog(fog)
  const shows = live.filter((i) => i.mode === 'show')
  const covers = live.filter((i) => i.mode === 'cover')
  const off = fog.items.filter((i) => !live.includes(i))
  const box = { x: 0, y: 0, width: plane.w, height: plane.h }
  return (
    <>
      {live.length > 0 && (
        <>
          <mask id="fog-mask" maskUnits="userSpaceOnUse" {...box}>
            <rect {...box} fill={shows.length ? '#fff' : '#000'} />
            {shows.map((i) => <path key={i.id} d={fogPath(i)} fill="#000" />)}
            {covers.map((i) => <path key={i.id} d={fogPath(i)} fill="#fff" />)}
          </mask>
          <rect className="canvas-fog-cover" {...box} fill={fog.fill} mask="url(#fog-mask)" />
        </>
      )}
      {live.map((i) => <path key={i.id} className="canvas-fog-edge" data-mode={i.mode} d={fogPath(i)} />)}
      {covers.map((i) => {
        const b = fogBounds(i)
        return <text key={i.id} className="canvas-fog-name" x={b.x + b.w / 2} y={b.y + b.h / 2} fill={inkOn(fog.fill)} style={{ fontSize: Math.min(Math.min(b.w, b.h) * 0.14, 14) }}>{i.name}</text>
      })}
      {off.map((i) => <path key={i.id} className="canvas-fog-off" d={fogPath(i)} />)}
    </>
  )
})

/** Grab areas for every fog part, smallest on top so nothing gets buried, and the points of the one being edited. */
function FogHandles({ fog, selected, part, point, px }: { fog: Fog; selected: number[]; part: number | null; point: number | null; px: number }) {
  const area = ({ w, h }: Rect) => w * h
  const hits = fog.items
    .filter((item) => item.on && fog.on)
    .flatMap((item) => item.parts.map((p, i) => ({ item, part: p, i, size: area(partBounds(p)) })))
    .sort((a, b) => b.size - a.size)
  const editing = fog.items.find((item) => item.id === selected.at(-1))
  const active = part === null ? undefined : editing?.parts[part]
  const r = 5 * px
  return (
    <>
      {hits.map((h) => <path key={`${h.item.id}:${h.i}`} data-fog-hit={`${h.item.id}:${h.i}`} d={partPath(h.part)} fill="transparent" className="cursor-pointer" />)}
      {fog.items.filter((item) => selected.includes(item.id)).flatMap((item) => item.parts.map((p, i) => <path key={`${item.id}:${i}`} className="canvas-shape-line" d={partPath(p)} />))}
      {active?.box && ([[0, 0], [1, 0], [1, 1], [0, 1]] as const).map(([cx, cy]) => (
        <circle key={`${cx}${cy}`} data-fog-corner={`${cx}:${cy}`} className="canvas-shape-point" cx={active.box.x + active.box.w * cx} cy={active.box.y + active.box.h * cy} r={r} />
      ))}
      {active?.points && (
        <>
          <path data-fog-edge d={partPath(active)} fill="none" stroke="transparent" strokeWidth={12 * px} />
          {active.points.map((p, i) => (
            <g key={i}>
              {i === point && (['in', 'out'] as const).map((side) => {
                const [hx, hy] = side === 'in' ? [p.x + p.inX, p.y + p.inY] : [p.x + p.outX, p.y + p.outY]
                return (
                  <g key={side}>
                    <line className="canvas-shape-line" x1={p.x} y1={p.y} x2={hx} y2={hy} />
                    <circle data-fog-handle={`${i}:${side}`} className="canvas-shape-point" cx={hx} cy={hy} r={r * 0.8} />
                  </g>
                )
              })}
              <circle data-fog-point={i} data-on={i === point} className="canvas-shape-point" cx={p.x} cy={p.y} r={r} />
            </g>
          ))}
        </>
      )}
    </>
  )
}

const CropShade = memo(function CropShade({ crop, plane }: { crop: Rect; plane: Plane }) {
  return (
    <>
      <path className="canvas-crop-dim" d={`M0 0H${plane.w}V${plane.h}H0ZM${crop.x} ${crop.y}H${crop.x + crop.w}V${crop.y + crop.h}H${crop.x}Z`} />
      <rect className="canvas-crop-edge" x={crop.x} y={crop.y} width={crop.w} height={crop.h} />
    </>
  )
})

function CropHandles({ crop, size }: { crop: Rect; size: number }) {
  return (
    <>
      <rect data-crop="move" x={crop.x} y={crop.y} width={crop.w} height={crop.h} fill="transparent" className="cursor-move" />
      {CROP_HANDLES.map((h) => (
        <rect
          key={h.id}
          data-crop={h.id}
          className="canvas-crop-handle"
          style={{ cursor: h.cursor }}
          x={crop.x + crop.w * h.x - size / 2}
          y={crop.y + crop.h * h.y - size / 2}
          width={size}
          height={size}
        />
      ))}
    </>
  )
}

const PageFrames = memo(function PageFrames({ pages, selected, cursor }: { pages: LabeledPage[]; selected: ReadonlySet<number>; cursor: number }) {
  const places = (values: number[]) => [...new Set(values.map(Math.round))].sort((a, b) => a - b)
  const columns = places(pages.map((p) => p.x))
  const rows = places(pages.map((p) => p.y))
  return pages.map((p, i) => (
    <g
      key={i}
      id={`sheet-${i}`}
      role="option"
      aria-selected={selected.has(i)}
      aria-label={`Sheet ${p.label}, column ${columns.indexOf(Math.round(p.x)) + 1}, row ${rows.indexOf(Math.round(p.y)) + 1}`}
      data-page={i}
      data-selected={selected.has(i)}
      data-cursor={i === cursor}
      className="canvas-page"
    >
      <rect x={p.x} y={p.y} width={p.w} height={p.h} />
      <text x={p.x + p.w / 2} y={p.y + p.h / 2} style={{ fontSize: Math.min(p.w, p.h) * 0.14 }}>{p.label}</text>
    </g>
  ))
})

function marqueePath(points: Point[], lasso: boolean): string {
  if (lasso) return `M${points.map((p) => `${p.x} ${p.y}`).join('L')}Z`
  const [a, b = a] = points
  return `M${a.x} ${a.y}H${b.x}V${b.y}H${a.x}Z`
}

export function Canvas({
  map, plane, spec, gridType, sq, overlay, filter, fog, pages, automatic, editPages, selected, setSelected, tool, setTool, fogDraw, setFogDraw, fogCombine, setFogCombine, fogSnap, setFogSnap, finishFogShape, changeFogParts, mergeFog, removeFog, selectedFog, setSelectedFog, undo, redo, canUndo, canRedo, crop, onCrop, onMeasure, showSheets, backHref, shortcuts,
}: {
  map: MapRecord
  plane: Plane
  spec: PageSpec
  gridType: Grid['type']
  sq: number
  overlay: Overlay
  filter: Filter
  fog: Fog
  pages: LabeledPage[]
  automatic: LabeledPage[]
  editPages: (change: (current: LabeledPage[]) => LabeledPage[]) => void
  selected: ReadonlySet<number>
  setSelected: (selected: ReadonlySet<number>) => void
  tool: Tool
  setTool: (tool: Tool) => void
  fogDraw: FogDraw
  setFogDraw: (draw: FogDraw) => void
  fogCombine: FogCombine
  setFogCombine: (combine: FogCombine) => void
  fogSnap: boolean
  setFogSnap: (snap: boolean) => void
  finishFogShape: (shape: FogShape) => void
  changeFogParts: (id: number, parts: FogPart[]) => void
  mergeFog: () => void
  removeFog: (ids: number[]) => void
  selectedFog: number[]
  setSelectedFog: (ids: number[]) => void
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
  crop: Rect | null
  onCrop: (crop: Rect) => void
  onMeasure: (cell: Rect) => void
  showSheets: boolean
  backHref: string
  shortcuts: boolean
}) {
  const [view, setView] = useState<Rect>({ x: 0, y: 0, w: 1, h: 1 })
  const [draftFog, setDraftFog] = useState<Rect | null>(null)
  const [marquee, setMarquee] = useState<Point[] | null>(null)
  const [space, setSpace] = useState(false)
  const [fogPart, setFogPart] = useState<number | null>(null)
  const [fogPoint, setFogPoint] = useState<number | null>(null)
  const [polygon, setPolygon] = useState<Point[] | null>(null)
  const [polygonHover, setPolygonHover] = useState<Point | null>(null)
  const fogItem = fog.items.find((i) => i.id === selectedFog.at(-1))
  const activePart = fogPart === null ? undefined : fogItem?.parts[fogPart]
  const shapePoints = activePart?.points
  const [cursorAt, setCursor] = useState(0)
  const cursor = Math.min(cursorAt, Math.max(0, pages.length - 1))
  const active: Tool = space ? 'hand' : tool
  const svg = useRef<SVGSVGElement>(null)
  // Set by keyboard moves, so the view follows the keyboard but never a pointer drag.
  const follow = useRef(false)

  const fit = useCallback(() => {
    const box = svg.current?.getBoundingClientRect()
    if (!box) return
    const bounds = pages.reduce(
      (b, p) => ({ x: Math.min(b.x, p.x), y: Math.min(b.y, p.y), r: Math.max(b.r, p.x + p.w), b: Math.max(b.b, p.y + p.h) }),
      { x: 0, y: 0, r: plane.w, b: plane.h },
    )
    const pad = Math.max(bounds.r - bounds.x, bounds.b - bounds.y) * 0.06
    const w = bounds.r - bounds.x + pad * 2
    const h = bounds.b - bounds.y + pad * 2
    // Keep the map clear of the floating toolbar.
    const free = box.height - (box.width < 480 ? TOOLBAR_PX * 2 : TOOLBAR_PX)
    const scale = Math.max(w / box.width, h / free)
    const vw = box.width * scale
    const vh = box.height * scale
    setView({ x: bounds.x - pad - (vw - w) / 2, y: bounds.y - pad - (free * scale - h) / 2, w: vw, h: vh })
  }, [pages, plane])

  useEffect(fit, [plane.w, plane.h, spec.paperW, spec.paperH]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => svg.current?.focus({ preventScroll: true }), [])
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  const toPlane = useCallback((clientX: number, clientY: number) => {
    const box = svg.current!.getBoundingClientRect()
    return { x: view.x + ((clientX - box.left) / box.width) * view.w, y: view.y + ((clientY - box.top) / box.height) * view.h }
  }, [view])
  const mmPerPx = () => view.w / (svg.current?.getBoundingClientRect().width || 1)

  useEffect(() => {
    const element = svg.current!
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const box = element.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        // A trackpad pinch arrives as a ctrl wheel, in much smaller steps.
        const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))
        const fx = (e.clientX - box.left) / box.width
        const fy = (e.clientY - box.top) / box.height
        setView((v) => {
          const w = Math.min(Math.max(v.w * factor, 40), 40000)
          const h = (w * v.h) / v.w
          return { x: v.x + (v.w - w) * fx, y: v.y + (v.h - h) * fy, w, h }
        })
      } else {
        const lines = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
        setView((v) => {
          const scale = (v.w / box.width) * lines
          return { ...v, x: v.x + e.deltaX * scale, y: v.y + e.deltaY * scale }
        })
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  const drag = useRef<
    | { kind: 'pan'; x: number; y: number; view: Rect; tap?: number; moved?: boolean }
    | { kind: 'page'; index: number; dx: number; dy: number; origin: Map<number, Point> }
    | { kind: 'fog'; x: number; y: number }
    | { kind: 'lasso-draw' }
    | { kind: 'fog-move'; id: number; only: number | null; x: number; y: number; parts: FogPart[]; bounds: Rect }
    | { kind: 'fog-corner'; cx: number; cy: number; box: Rect }
    | { kind: 'fog-point'; index: number }
    | { kind: 'fog-handle'; index: number; side: 'in' | 'out' }
    | { kind: 'marquee'; lasso: boolean; base: ReadonlySet<number>; x: number; y: number; moved: boolean }
    | { kind: 'crop-new'; x: number; y: number }
    | { kind: 'measure'; x: number; y: number }
    | { kind: 'crop-edit'; handle: string; start: Rect; px: number; py: number }
    | null
  >(null)

  const snapSquare = (v: number, offset: number) => offset + Math.round((v - offset) / sq) * sq

  /** Pulls a spot onto a nearby grid line or the edge of a fog box, unless snapping is off or Alt is held. */
  const snapFog = (point: Point, free: boolean, moving?: { id: number; only: number | null }): Point => {
    if (!fogSnap || free) return point
    const own = (id: number, part: number) => moving?.id === id && (moving.only === null || moving.only === part)
    const boxes = fog.items.flatMap((item) => item.parts.flatMap((p, i) => (p.box && !own(item.id, i) ? [p.box] : [])))
    const nearest = (v: number, options: number[]) => options.reduce((best, c) => (Math.abs(c - v) < Math.abs(best - v) ? c : best), v + SNAP_FOG_PX * mmPerPx())
    const pull = (v: number, options: number[]) => {
      const c = nearest(v, options)
      return Math.abs(c - v) < SNAP_FOG_PX * mmPerPx() ? c : v
    }
    return {
      x: pull(point.x, [snapSquare(point.x, plane.offsetX), ...boxes.flatMap((b) => [b.x, b.x + b.w])]),
      y: pull(point.y, [snapSquare(point.y, plane.offsetY), ...boxes.flatMap((b) => [b.y, b.y + b.h])]),
    }
  }

  const setPart = (next: FogPart) => {
    if (fogItem && fogPart !== null) changeFogParts(fogItem.id, fogItem.parts.map((p, i) => (i === fogPart ? next : p)))
  }
  const finishDrawing = (shape: FogShape) => {
    finishFogShape(shape)
    setFogPart(null)
    setFogPoint(null)
  }
  const closePolygon = (points: Point[]) => {
    setPolygon(null)
    setPolygonHover(null)
    if (points.length >= 3) finishDrawing({ points: sharpCurve(points) })
  }
  const toggled = (i: number) => {
    const next = new Set(selected)
    if (!next.delete(i)) next.add(i)
    return next
  }

  const addSheet = (page: LabeledPage) => {
    const used = new Set(pages.map((p) => p.label))
    let n = pages.length + 1
    while (used.has(`P${n}`)) n++
    editPages((list) => [...list, { ...page, label: `P${n}` }])
    setSelected(new Set([pages.length]))
    setCursor(pages.length)
    setTool('select')
    announce(`Sheet P${n} added`)
  }

  /** The keyboard route: the first free spot around the current sheet. */
  const addBeside = () => {
    const base = pages[cursor] ?? automatic[0]
    if (!base) return
    const tolerance = spec.overlapMm + 1
    const spots = (pages.length ? [[1, 0], [0, 1], [-1, 0], [0, -1]] : [[0, 0]])
      .map(([a, b]) => ({ ...base, x: base.x + a * (base.w - spec.overlapMm), y: base.y + b * (base.h - spec.overlapMm) }))
    const clashes = (s: LabeledPage) => pages.some((p) => p.x < s.x + s.w - tolerance && s.x < p.x + p.w - tolerance && p.y < s.y + s.h - tolerance && s.y < p.y + p.h - tolerance)
    follow.current = true
    addSheet(spots.find((s) => !clashes(s)) ?? spots[0])
    svg.current?.focus({ preventScroll: true })
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    svg.current!.setPointerCapture(e.pointerId)
    const startPan = (tap?: number) => {
      drag.current = { kind: 'pan', x: e.clientX, y: e.clientY, view, tap }
    }
    if (e.button === 1 || active === 'hand') return startPan()
    const point = toPlane(e.clientX, e.clientY)
    if (active === 'fog') {
      const target = e.target as Element
      if (fogDraw === 'box') {
        const start = snapFog(point, e.altKey)
        drag.current = { kind: 'fog', x: start.x, y: start.y }
        return
      }
      if (fogDraw === 'polygon') {
        const spot = snapFog(point, e.altKey)
        const first = polygon?.[0]
        if (polygon && first && polygon.length >= 3 && Math.hypot(first.x - point.x, first.y - point.y) < SNAP_PX * mmPerPx()) return closePolygon(polygon)
        setPolygon([...(polygon ?? []), spot])
        return
      }
      if (fogDraw === 'lasso') {
        drag.current = { kind: 'lasso-draw' }
        setMarquee([point])
        return
      }
      const corner = target.closest<SVGElement>('[data-fog-corner]')?.dataset.fogCorner
      const handle = target.closest<SVGElement>('[data-fog-handle]')?.dataset.fogHandle
      const spot = target.closest<SVGElement>('[data-fog-point]')?.dataset.fogPoint
      if (corner && activePart?.box) {
        const [cx, cy] = corner.split(':').map(Number)
        drag.current = { kind: 'fog-corner', cx, cy, box: activePart.box }
        return
      }
      if (handle) {
        const [index, side] = handle.split(':')
        setFogPoint(Number(index))
        drag.current = { kind: 'fog-handle', index: Number(index), side: side as 'in' | 'out' }
        return
      }
      if (spot !== undefined) {
        setFogPoint(Number(spot))
        drag.current = { kind: 'fog-point', index: Number(spot) }
        return
      }
      if (target.closest('[data-fog-edge]') && shapePoints && activePart) {
        const { index, t } = nearestOnCurve(shapePoints, point)
        setPart({ ...activePart, points: splitCurve(shapePoints, index, t) })
        setFogPoint(index + 1)
        drag.current = { kind: 'fog-point', index: index + 1 }
        return
      }
      const hit = target.closest<SVGElement>('[data-fog-hit]')?.dataset.fogHit
      if (!hit) {
        setSelectedFog([])
        setFogPart(null)
        setFogPoint(null)
        return
      }
      const [id, part] = hit.split(':').map(Number)
      if (e.shiftKey) {
        setSelectedFog(selectedFog.includes(id) ? selectedFog.filter((other) => other !== id) : [...selectedFog, id])
        setFogPart(null)
        setFogPoint(null)
        return
      }
      if (!selectedFog.includes(id)) setSelectedFog([id])
      else if (selectedFog.at(-1) !== id) setSelectedFog([...selectedFog.filter((other) => other !== id), id])
      setFogPart(part)
      setFogPoint(null)
      const grabbed = fog.items.find((i) => i.id === id)!
      const only = e.altKey ? part : null
      const edges = (only === null ? grabbed.parts : [grabbed.parts[only]]).map(partBounds)
      const left = Math.min(...edges.map((b) => b.x))
      const top = Math.min(...edges.map((b) => b.y))
      const bounds = { x: left, y: top, w: Math.max(...edges.map((b) => b.x + b.w)) - left, h: Math.max(...edges.map((b) => b.y + b.h)) - top }
      drag.current = { kind: 'fog-move', id, only, x: point.x, y: point.y, parts: grabbed.parts, bounds }
      return
    }
    if (active === 'page') {
      const first = automatic[0]
      if (first) {
        addSheet(snapPage({ ...first, x: point.x - first.w / 2, y: point.y - first.h / 2 }, pages, plane, spec.overlapMm, 12 * mmPerPx(), sq, spec.seamsOnGrid))
      } else setTool('select')
      return
    }
    if (active === 'measure') {
      drag.current = { kind: 'measure', x: point.x, y: point.y }
      setMarquee([point])
      return
    }
    if (active === 'crop') {
      const handle = (e.target as Element).closest<SVGElement>('[data-crop]')?.dataset.crop
      if (handle && crop) drag.current = { kind: 'crop-edit', handle, start: crop, px: point.x, py: point.y }
      else drag.current = { kind: 'crop-new', x: point.x, y: point.y }
      return
    }
    const hit = (e.target as Element).closest<SVGElement>('[data-page]')
    const index = hit ? Number(hit.dataset.page) : null
    const adding = e.metaKey || e.ctrlKey
    if (e.pointerType === 'touch' && (index === null || !selected.has(index))) return startPan(index ?? -1)
    if (index !== null) {
      if (adding) return setSelected(toggled(index))
      const moving = selected.has(index) ? selected : new Set([index])
      setSelected(moving)
      drag.current = {
        kind: 'page', index, dx: point.x - pages[index].x, dy: point.y - pages[index].y,
        origin: new Map([...moving].map((i) => [i, { x: pages[i].x, y: pages[i].y }])),
      }
      return
    }
    drag.current = { kind: 'marquee', lasso: active === 'lasso', base: adding ? selected : new Set(), x: point.x, y: point.y, moved: false }
    setMarquee([point])
    if (!adding) setSelected(new Set())
  }

  const cropEdit = (d: Extract<NonNullable<typeof drag.current>, { kind: 'crop-edit' }>, x: number, y: number, free: boolean) => {
    const snapX = (v: number) => Math.min(plane.w, Math.max(0, free ? v : snapSquare(v, plane.offsetX)))
    const snapY = (v: number) => Math.min(plane.h, Math.max(0, free ? v : snapSquare(v, plane.offsetY)))
    const { start } = d
    if (d.handle === 'move') {
      const left = Math.min(plane.w - start.w, Math.max(0, free ? start.x + x - d.px : snapSquare(start.x + x - d.px, plane.offsetX)))
      const top = Math.min(plane.h - start.h, Math.max(0, free ? start.y + y - d.py : snapSquare(start.y + y - d.py, plane.offsetY)))
      return onCrop({ ...start, x: left, y: top })
    }
    const least = free ? 1 : sq
    let [x0, y0, x1, y1] = [start.x, start.y, start.x + start.w, start.y + start.h]
    if (d.handle.includes('w')) x0 = Math.min(snapX(x), x1 - least)
    if (d.handle.includes('e')) x1 = Math.max(snapX(x), x0 + least)
    if (d.handle.includes('n')) y0 = Math.min(snapY(y), y1 - least)
    if (d.handle.includes('s')) y1 = Math.max(snapY(y), y0 + least)
    onCrop({ x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(plane.w, x1) - Math.max(0, x0), h: Math.min(plane.h, y1) - Math.max(0, y0) })
  }

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d && polygon) setPolygonHover(snapFog(toPlane(e.clientX, e.clientY), e.altKey))
    if (!d) return
    if (d.kind === 'pan') {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true
      const scale = d.view.w / svg.current!.getBoundingClientRect().width
      setView({ ...d.view, x: d.view.x - (e.clientX - d.x) * scale, y: d.view.y - (e.clientY - d.y) * scale })
      return
    }
    const point = toPlane(e.clientX, e.clientY)
    if (d.kind === 'lasso-draw') {
      setMarquee((trail) => [...(trail ?? []), point])
    } else if (d.kind === 'fog-move') {
      const { bounds: b } = d
      const [rawX, rawY] = [point.x - d.x, point.y - d.y]
      // Whichever edge is nearest a line pulls the whole thing onto it.
      const near = snapFog({ x: b.x + rawX, y: b.y + rawY }, false, d)
      const far = snapFog({ x: b.x + b.w + rawX, y: b.y + b.h + rawY }, false, d)
      const pull = (a: number, c: number) => (a && (!c || Math.abs(a) <= Math.abs(c)) ? a : c)
      const dx = rawX + pull(near.x - (b.x + rawX), far.x - (b.x + b.w + rawX))
      const dy = rawY + pull(near.y - (b.y + rawY), far.y - (b.y + b.h + rawY))
      changeFogParts(d.id, d.parts.map((part, i) => {
        if (d.only !== null && i !== d.only) return part
        return part.box
          ? { ...part, box: { ...part.box, x: part.box.x + dx, y: part.box.y + dy } }
          : { ...part, points: part.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) }
      }))
    } else if (d.kind === 'fog-corner' && activePart) {
      const spot = snapFog(point, e.altKey)
      const [fx, fy] = [d.box.x + (d.cx ? 0 : d.box.w), d.box.y + (d.cy ? 0 : d.box.h)]
      setPart({ ...activePart, box: { x: Math.min(fx, spot.x), y: Math.min(fy, spot.y), w: Math.max(1, Math.abs(spot.x - fx)), h: Math.max(1, Math.abs(spot.y - fy)) } } as FogPart)
    } else if (d.kind === 'fog-point' && shapePoints && activePart) {
      const spot = snapFog(point, e.altKey)
      setPart({ ...activePart, points: shapePoints.map((p, i) => (i === d.index ? { ...p, ...spot } : p)) })
    } else if (d.kind === 'fog-handle' && shapePoints && activePart) {
      setPart({ ...activePart, points: shapePoints.map((p, i) => {
        if (i !== d.index) return p
        const [dx, dy] = [point.x - p.x, point.y - p.y]
        // Alt breaks the handles apart, for a corner.
        if (e.altKey) return d.side === 'in' ? { ...p, inX: dx, inY: dy } : { ...p, outX: dx, outY: dy }
        const [x, y] = d.side === 'in' ? [dx, dy] : [-dx, -dy]
        return { ...p, inX: x, inY: y, outX: -x, outY: -y }
      }) })
    } else if (d.kind === 'page') {
      const lead = d.origin.get(d.index)!
      const moved = { ...pages[d.index], x: point.x - d.dx, y: point.y - d.dy }
      const others = pages.filter((_, i) => !d.origin.has(i))
      const snapped = e.altKey ? moved : snapPage(moved, others, plane, spec.overlapMm, SNAP_PX * mmPerPx(), sq, spec.seamsOnGrid)
      const shiftX = snapped.x - lead.x
      const shiftY = snapped.y - lead.y
      editPages((list) => list.map((p, i) => {
        const from = d.origin.get(i)
        return from ? { ...p, x: from.x + shiftX, y: from.y + shiftY } : p
      }))
    } else if (d.kind === 'marquee') {
      d.moved = true
      const trail = d.lasso ? [...(marquee ?? []), point] : [{ x: d.x, y: d.y }, point]
      setMarquee(trail)
      const box = { x: Math.min(d.x, point.x), y: Math.min(d.y, point.y), w: Math.abs(point.x - d.x), h: Math.abs(point.y - d.y) }
      const next = new Set(d.base)
      pages.forEach((p, i) => {
        if (d.lasso ? lassoTouches(trail, p) : rectsTouch(box, p)) next.add(i)
      })
      setSelected(next)
    } else if (d.kind === 'measure') {
      setMarquee([{ x: d.x, y: d.y }, point])
    } else if (d.kind === 'crop-new') {
      const snapX = (v: number) => Math.min(plane.w, Math.max(0, e.altKey ? v : snapSquare(v, plane.offsetX)))
      const snapY = (v: number) => Math.min(plane.h, Math.max(0, e.altKey ? v : snapSquare(v, plane.offsetY)))
      const [x1, x2, y1, y2] = [snapX(d.x), snapX(point.x), snapY(d.y), snapY(point.y)]
      if (Math.abs(x2 - x1) > 1 && Math.abs(y2 - y1) > 1) {
        onCrop({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) })
      }
    } else if (d.kind === 'crop-edit') {
      cropEdit(d, point.x, point.y, e.altKey)
    } else if (d.kind === 'fog') {
      const end = snapFog(point, e.altKey)
      setDraftFog({ x: Math.min(d.x, end.x), y: Math.min(d.y, end.y), w: Math.abs(end.x - d.x), h: Math.abs(end.y - d.y) })
    }
  }

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (d?.kind === 'fog' && draftFog && draftFog.w > 0 && draftFog.h > 0) {
      finishDrawing({ box: draftFog })
    }
    if (d?.kind === 'lasso-draw') {
      const curve = marquee && marquee.length > 3 ? curveFromStroke(marquee, 6 * mmPerPx()) : null
      if (curve) finishDrawing({ points: curve })
    }
    if (d?.kind === 'measure' && marquee?.[1]) {
      const [a, b] = marquee
      const cell = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }
      if (cell.w > 0 && cell.h > 0) onMeasure(cell)
      setTool('select')
    }
    if (d?.kind === 'pan' && d.tap !== undefined && !d.moved) {
      if (d.tap >= 0) setSelected(e.metaKey || e.ctrlKey ? toggled(d.tap) : new Set([d.tap]))
      else setSelected(new Set())
    }
    setDraftFog(null)
    setMarquee(null)
    drag.current = null
  }

  const removeFogPoint = (index: number) => {
    if (!shapePoints || !activePart || shapePoints.length <= 3) return
    setPart({ ...activePart, points: shapePoints.filter((_, i) => i !== index) })
    setFogPoint(null)
    announce('Point removed')
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (active !== 'fog') return
    // The double-click's two presses each placed a corner on the same spot.
    if (polygon) return closePolygon(polygon.slice(0, -1))
    const spot = (e.target as Element).closest<SVGElement>('[data-fog-point]')?.dataset.fogPoint
    if (fogDraw === 'select' && spot !== undefined) removeFogPoint(Number(spot))
  }

  const count = (n: number) => `${n} ${n === 1 ? 'sheet' : 'sheets'}`

  const rotate = (which: ReadonlySet<number>) => {
    editPages((list) => list.map((p, i) => (which.has(i)
      ? { ...p, x: p.x + (p.w - p.h) / 2, y: p.y + (p.h - p.w) / 2, w: p.h, h: p.w, sheetW: p.sheetH, sheetH: p.sheetW }
      : p)))
    announce(`${count(which.size)} rotated`)
  }

  const deleteSelected = () => {
    if (!selected.size) return
    editPages((list) => list.filter((_, i) => !selected.has(i)))
    setSelected(new Set())
    announce(`${count(selected.size)} deleted`)
  }

  /** Keyboard access to sheets: arrows walk them, Space selects, Shift+arrows move them a square. */
  const onCanvasKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    // The hand tool already took this press of Space.
    if (e.key === ' ' && e.defaultPrevented) return
    const { step: dir, word } = DIRECTION[e.key] ?? {}
    const pressed = e.key === ' ' || e.key === 'Enter'
    if (active === 'fog') {
      if (polygon && e.key === 'Enter') {
        e.preventDefault()
        return closePolygon(polygon)
      }
      if (shapePoints && activePart && (e.key === '[' || e.key === ']')) {
        e.preventDefault()
        const next = ((fogPoint ?? -1) + (e.key === ']' ? 1 : -1) + shapePoints.length) % shapePoints.length
        setFogPoint(next)
        return announce(`Point ${next + 1} of ${shapePoints.length}`)
      }
      if (dir && fogPoint !== null && shapePoints && activePart) {
        e.preventDefault()
        const by = e.shiftKey ? sq : 1
        setPart({ ...activePart, points: shapePoints.map((p, i) => (i === fogPoint ? { ...p, x: p.x + dir[0] * by, y: p.y + dir[1] * by } : p)) })
      }
      return
    }
    if (active === 'page' && pressed) {
      e.preventDefault()
      return addBeside()
    }
    if (active === 'crop' && crop && dir && e.shiftKey) {
      e.preventDefault()
      onCrop({
        ...crop,
        x: Math.min(plane.w - crop.w, Math.max(0, crop.x + dir[0] * sq)),
        y: Math.min(plane.h - crop.h, Math.max(0, crop.y + dir[1] * sq)),
      })
      return announce(`Print crop moved ${word} one square`)
    }
    const here = pages[cursor]
    if (!here) return
    if (pressed) {
      e.preventDefault()
      const next = toggled(cursor)
      setSelected(next)
      announce(`${next.size} selected`)
    } else if (dir && e.shiftKey) {
      e.preventDefault()
      const moving = selected.size ? selected : new Set([cursor])
      editPages((list) => list.map((p, i) => (moving.has(i) ? { ...p, x: p.x + dir[0] * sq, y: p.y + dir[1] * sq } : p)))
      follow.current = true
      announce(`${moving.size === 1 ? `Sheet ${pages[[...moving][0]].label}` : count(moving.size)} moved ${word} one square`)
    } else if (dir) {
      e.preventDefault()
      let best = -1
      let bestScore = Infinity
      pages.forEach((p, i) => {
        const dx = p.x - here.x
        const dy = p.y - here.y
        const ahead = dx * dir[0] + dy * dir[1]
        if (i === cursor || ahead <= 0) return
        const score = ahead + Math.abs(dx * dir[1]) * 3 + Math.abs(dy * dir[0]) * 3
        if (score < bestScore) {
          bestScore = score
          best = i
        }
      })
      if (best >= 0) {
        follow.current = true
        setCursor(best)
      }
    }
  }

  useEffect(() => {
    const page = pages[cursor]
    if (!follow.current || !page) return
    follow.current = false
    const reach = (start: number, size: number, from: number, span: number) =>
      (size >= span ? start + (size - span) / 2 : Math.min(start, Math.max(from, start + size - span)))
    setView((v) => {
      const toolbar = TOOLBAR_PX * (v.w / (svg.current?.getBoundingClientRect().width || 1))
      return { ...v, x: reach(page.x, page.w, v.x, v.w), y: reach(page.y, page.h, v.y, v.h - toolbar) }
    })
  }, [pages, cursor])

  const zoom = (factor: number) => setView((v) => {
    const w = v.w * factor
    const h = v.h * factor
    return { x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h }
  })

  /** Letter keys only act with focus in the canvas or its toolbar, and can be switched off. */
  const onShortcut = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || (e.target !== svg.current && isField(e.target))) return
    const key = e.key.toLowerCase()
    if (active === 'fog') {
      if (key === 'delete' || key === 'backspace') {
        if (polygon) setPolygon(polygon.length > 1 ? polygon.slice(0, -1) : null)
        else if (fogPoint !== null) removeFogPoint(fogPoint)
        else if (selectedFog.length === 1 && fogItem && fogPart !== null && fogItem.parts.length > 1) {
          changeFogParts(fogItem.id, withoutPart(fogItem.parts, fogPart))
          setFogPart(null)
          announce('Part removed')
        } else if (selectedFog.length) removeFog(selectedFog)
        return
      }
      const next = FOG_DRAWS.find((t) => t.shortcut.toLowerCase() === key)
      if (shortcuts && next) return setFogDraw(next.value)
    }
    if (key === 'delete' || key === 'backspace') deleteSelected()
    if (!shortcuts) return
    if (key === 'r') {
      if (selected.size) rotate(selected)
      else if (e.target === svg.current && pages[cursor]) rotate(new Set([cursor]))
    } else if (key === 'd') deleteSelected()
    else if (key === '0') fit()
    else if (key === '+' || key === '=') zoom(0.8)
    else if (key === '-') zoom(1.25)
    else {
      const next = TOOLS.find((t) => t.shortcut.toLowerCase() === key)
      if (next) setTool(next.value)
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') {
        if (isField(e.target) && e.target !== svg.current) return
        if (polygon) setPolygon(null)
        else if (tool !== 'select') setTool('select')
        else if (selected.size) setSelected(new Set())
        else window.location.hash = backHref
      } else if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
        // Text fields keep their own undo.
        if (isField(e.target) && e.target !== svg.current) return
        e.preventDefault()
        const back = e.key.toLowerCase() === 'z' && !e.shiftKey
        if (back ? undo() : redo()) announce(back ? 'Undone' : 'Redone')
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a' && (e.target === svg.current || !isField(e.target))) {
        e.preventDefault()
        setSelected(new Set(pages.keys()))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, selected, pages, backHref, setTool, setSelected, undo, redo, polygon])

  // Sheets stay out of the way while fog is being edited.
  useEffect(() => {
    if (tool === 'fog') setSelected(new Set())
    else setPolygon(null)
  }, [tool]) // eslint-disable-line react-hooks/exhaustive-deps

  // Space holds the hand, in the capture phase so it neither scrolls nor presses a button
  // left focused by a click. Once keys are moving focus, Space stays with the control, so the keyboard still works.
  useEffect(() => {
    let held = false
    let tabbing = true
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.key.startsWith('Arrow')) tabbing = true
      if (e.code !== 'Space' || (e.target !== svg.current && isField(e.target)) || (tabbing && e.target !== document.body)) return
      e.preventDefault()
      held = true
      setSpace(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !held) return
      e.preventDefault()
      release()
    }
    const release = () => {
      held = false
      setSpace(false)
    }
    const pointer = () => {
      tabbing = false
    }
    window.addEventListener('pointerdown', pointer, true)
    window.addEventListener('pointermove', pointer, true)
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('pointermove', pointer, true)
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', release)
    }
  }, [])

  return (
    <div className="relative isolate min-h-0 flex-1" onKeyDown={onShortcut}>
      <svg
        ref={svg}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onCanvasKey}
        tabIndex={0}
        aria-activedescendant={pages.length ? `sheet-${cursor}` : undefined}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Print sheets"
        aria-describedby="canvas-help"
        data-tool={active}
        className="block size-full cursor-default touch-none select-none data-[tool=crop]:cursor-crosshair data-[tool=measure]:cursor-crosshair data-[tool=fog]:cursor-crosshair data-[tool=hand]:cursor-grab data-[tool=hand]:active:cursor-grabbing data-[tool=page]:cursor-crosshair"
      >
        <SheetBacks pages={pages} />
        <Art map={map} plane={plane} gridType={gridType} sq={sq} overlay={overlay} filter={filter} />
        {crop && <CropShade crop={crop} plane={plane} />}
        <FogLayer fog={fog} plane={plane} />
        {draftFog && <rect className="canvas-fog-edge" x={draftFog.x} y={draftFog.y} width={draftFog.w} height={draftFog.h} />}
        <PageFrames pages={pages} selected={selected} cursor={cursor} />
        {showSheets && <SheetEdges pages={pages} />}
        {marquee && <path className="canvas-marquee" d={marqueePath(marquee, tool === 'lasso' || tool === 'fog')} />}
        {polygon && <path className="canvas-marquee" d={`M${[...polygon, ...(polygonHover ? [polygonHover] : [])].map((p) => `${p.x} ${p.y}`).join('L')}`} />}
        {active === 'fog' && fogDraw === 'select' && <FogHandles fog={fog} selected={selectedFog} part={fogPart} point={fogPoint} px={view.w / (svg.current?.getBoundingClientRect().width || 1)} />}
        {crop && active === 'crop' && <CropHandles crop={crop} size={12 * (view.w / (svg.current?.getBoundingClientRect().width || 1))} />}
      </svg>

      <p id="canvas-help" className="sr-only">
        Arrow keys move between sheets, Space selects, Shift with arrows moves sheets one square{shortcuts ? ', R rotates, D deletes' : ''}.
        With Add sheet active, Enter adds a sheet beside the current one. With Print crop active, Shift with arrows moves the crop.
        With Fog active, A, B, L and P pick how to draw. When editing a shape, the bracket keys pick a point, arrows move it and Delete removes it.
        Crop, fog and grid can also be set by number in the settings.
      </p>

      {(tool === 'fog' || TOOL_HINT[tool]) && (
        <Badge variant="secondary" className="absolute top-3 left-1/2 max-w-[calc(100%-1rem)] -translate-x-1/2 shadow-md">{tool === 'fog' ? FOG_HINT[fogDraw] : TOOL_HINT[tool]}</Badge>
      )}

      <div className="absolute bottom-3 left-1/2 z-10 flex w-max max-w-[calc(100%-1rem)] -translate-x-1/2 flex-col items-start gap-2 sm:bottom-4">
      {tool === 'fog' && (
        <div role="toolbar" aria-label="Fog tools" className="flex max-w-full flex-wrap items-center gap-1 rounded-xl bg-popover p-1 shadow-lg">
          <ToggleGroup type="single" spacing={0.5} aria-label="How to draw" value={fogDraw} onValueChange={(next) => { if (next) { setPolygon(null); setFogDraw(next as FogDraw) } }}>
            {FOG_DRAWS.map(({ value, label, shortcut, icon: Icon }) => (
              <Hint key={value} label={label} shortcut={shortcuts ? shortcut : undefined} side="top">
                <ToggleGroupItem value={value} aria-label={label} className="on:bg-primary on:text-primary-foreground"><Icon /></ToggleGroupItem>
              </Hint>
            ))}
          </ToggleGroup>
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          <ToggleGroup type="single" spacing={0.5} aria-label="What a new drawing does" value={fogCombine} onValueChange={(next) => next && setFogCombine(next as FogCombine)}>
            {FOG_COMBINES.map(({ value, label, icon: Icon }) => (
              <Hint key={value} label={label} side="top">
                <ToggleGroupItem value={value} aria-label={label} disabled={value !== 'new' && !fogItem} className="on:bg-primary on:text-primary-foreground"><Icon /></ToggleGroupItem>
              </Hint>
            ))}
          </ToggleGroup>
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          <IconToggle label="Snap to the grid and box edges" icon={Magnet} pressed={fogSnap} onPressedChange={setFogSnap} />
          {selectedFog.length > 1 && (
            <Button variant="secondary" size="sm" onClick={mergeFog}><SquaresUnite data-icon="inline-start" />Merge {selectedFog.length}</Button>
          )}
        </div>
      )}
      <div
        role="toolbar"
        aria-label="Layout tools"
        className="flex w-max max-w-full flex-wrap items-center justify-center rounded-xl bg-popover p-1 shadow-lg sm:gap-1"
      >
        <ToggleGroup type="single" spacing={0.5} aria-label="Tool" value={tool} onValueChange={(next) => next && setTool(next as Tool)}>
          {TOOLS.map(({ value, label, shortcut, icon: Icon }) => (
            <Hint key={value} label={label} shortcut={shortcuts ? shortcut : undefined} side="top">
              <ToggleGroupItem
                value={value}
                aria-label={label}
                className="on:bg-primary on:text-primary-foreground"
                onClick={(e) => {
                  // A click with no pointer has no spot to place on, so the sheet goes beside the current one.
                  if (value !== 'page' || e.detail !== 0) return
                  e.preventDefault()
                  addBeside()
                }}
              >
                <Icon />
              </ToggleGroupItem>
            </Hint>
          ))}
        </ToggleGroup>
        <Separator orientation="vertical" className="mx-1 h-5 self-center max-sm:hidden" />
        <IconButton label="Undo" side="top" icon={Undo2} disabled={!canUndo} onClick={undo} />
        <IconButton label="Redo" side="top" icon={Redo2} disabled={!canRedo} onClick={redo} />
        <Separator orientation="vertical" className="mx-1 h-5 self-center max-sm:hidden" />
        <IconButton label="Rotate selected" shortcut={shortcuts ? 'R' : undefined} side="top" icon={RotateCw} disabled={!selected.size} onClick={() => rotate(selected)} />
        <IconButton label="Delete selected" shortcut={shortcuts ? 'D' : undefined} side="top" icon={Trash2} disabled={!selected.size} onClick={deleteSelected} />
        <Separator orientation="vertical" className="mx-1 h-5 self-center max-sm:hidden" />
        <IconButton label="Zoom out" shortcut={shortcuts ? '-' : undefined} side="top" icon={ZoomOut} onClick={() => zoom(1.25)} />
        <IconButton label="Fit to screen" shortcut={shortcuts ? '0' : undefined} side="top" icon={Maximize} onClick={fit} />
        <IconButton label="Zoom in" shortcut={shortcuts ? '+' : undefined} side="top" icon={Plus} onClick={() => zoom(0.8)} />
      </div>
      </div>
    </div>
  )
}
