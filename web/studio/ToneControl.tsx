import { useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, Plus, RotateCcw, X } from 'lucide-react'
import {
  type Band, BAND_PRESETS, CURVE_PRESETS, curveFunction, curveInputs, HUES, isStraight, MAX_BANDS, MAX_CURVE_POINTS, NO_HUES, STRAIGHT,
} from '../../shared/tone.ts'
import { IconButton, NumberField, Segmented, SliderField } from '@/components/controls'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Histogram, useHistogram } from './histogram.tsx'
import type { Filter } from './types.ts'
import { useDraft } from './use-draft.ts'

type Point = [number, number]
type SetFilter = React.Dispatch<React.SetStateAction<Filter>>

const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))
const pct = (v: number) => `${(v / 255) * 100}%`
const LABEL = 'text-xs text-muted-foreground'

/** Moves one point, kept between its neighbours so the curve never folds back. */
function movePoint(curve: Point[], i: number, x: number, y: number): Point[] {
  const low = i === 0 ? 0 : curve[i - 1][0] + 1
  const high = i === curve.length - 1 ? 255 : curve[i + 1][0] - 1
  return curve.map((p, j) => (j === i ? [clamp(Math.round(x), low, high), clamp(Math.round(y), 0, 255)] : p))
}

/** Adds a point at input `x`, or returns null when there is no room for one there. */
function addPoint(curve: Point[], x: number, y: number): { curve: Point[]; index: number } | null {
  x = clamp(Math.round(x), 0, 255)
  if (curve.length >= MAX_CURVE_POINTS || curve.some((p) => p[0] === x)) return null
  const after = curve.findIndex((p) => p[0] > x)
  const index = after < 0 ? curve.length : after
  return { curve: [...curve.slice(0, index), [x, clamp(Math.round(y), 0, 255)], ...curve.slice(index)], index }
}

const pointName = (i: number, count: number) => (i === 0 ? 'Dark end' : i === count - 1 ? 'Light end' : `Point ${i}`)

function CurveEditor({ bins, filter, setFilter }: { bins: Uint32Array | null; filter: Filter; setFilter: SetFilter }) {
  const [curve, commit] = useDraft(filter.curve, (next) => setFilter((f) => ({ ...f, curve: next })))
  // Pointer events can arrive before the next render; they work on the newest curve.
  const latest = useRef(curve)
  latest.current = curve
  const apply = (next: Point[]) => {
    latest.current = next
    commit(next)
  }
  const [active, setActive] = useState(0)
  const area = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const hint = useId()

  const line = useMemo(() => {
    const f = curveFunction(curve)
    return Array.from({ length: 256 }, (_, x) => `${x ? 'L' : 'M'}${x} ${(255 - f(x)).toFixed(2)}`).join('')
  }, [curve])
  // The tones that reach the curve, after levels and ranges, so the points line up with what they change.
  const inputs = useMemo(() => {
    if (!bins) return null
    const into = curveInputs(filter)
    const counts = new Uint32Array(256)
    bins.forEach((n, v) => {
      counts[Math.round(into[v])] += n
    })
    return counts
  }, [bins, filter])

  const focusPoint = (i: number) => setTimeout(() => area.current?.querySelector<HTMLElement>(`[data-point="${i}"]`)?.focus())
  const select = (i: number) => {
    setActive(i)
    focusPoint(i)
  }
  const removable = (i: number) => i > 0 && i < latest.current.length - 1
  const remove = (i: number) => {
    if (!removable(i)) return
    apply(latest.current.filter((_, j) => j !== i))
    select(i - 1)
  }

  const valueAt = (e: React.PointerEvent): Point => {
    const box = area.current!.getBoundingClientRect()
    return [((e.clientX - box.left) / box.width) * 255, (1 - (e.clientY - box.top) / box.height) * 255]
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const point = (e.target as Element).closest<HTMLElement>('[data-point]')
    let index = point ? Number(point.dataset.point) : -1
    if (index < 0) {
      const added = addPoint(latest.current, ...valueAt(e))
      if (!added) return
      apply(added.curve)
      index = added.index
    }
    e.preventDefault()
    area.current!.setPointerCapture(e.pointerId)
    dragging.current = index
    select(index)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging.current === null) return
    apply(movePoint(latest.current, dragging.current, ...valueAt(e)))
  }
  const onPointerUp = () => {
    dragging.current = null
  }

  const STEPS: Record<string, Point> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0], PageUp: [0, 16], PageDown: [0, -16] }
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const step = STEPS[e.key]
    if (step) {
      e.preventDefault()
      const by = e.shiftKey ? 10 : 1
      const [x, y] = latest.current[i]
      apply(movePoint(latest.current, i, x + step[0] * by, y + step[1] * by))
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && removable(i)) {
      e.preventDefault()
      remove(i)
    }
  }

  /** Adds a point on the curve in the middle of the widest gap, for keyboards. */
  const addInGap = () => {
    let gap = 0
    for (let i = 1; i < curve.length - 1; i++) if (curve[i + 1][0] - curve[i][0] > curve[gap + 1][0] - curve[gap][0]) gap = i
    const x = Math.round((curve[gap][0] + curve[gap + 1][0]) / 2)
    const added = addPoint(curve, x, curveFunction(curve)(x))
    if (!added) return
    apply(added.curve)
    select(added.index)
  }

  const shown = Math.min(active, curve.length - 1)
  const [x, y] = curve[shown]
  const same = (a: Point[], b: Point[]) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1])

  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Curve">
      <div className="flex items-center justify-between gap-3">
        <span className={LABEL}>Curve</span>
        <div className="-my-2 flex">
          <IconButton label="Add a point" icon={Plus} disabled={curve.length >= MAX_CURVE_POINTS} onClick={addInGap} />
          <IconButton label="Reset curve" icon={RotateCcw} disabled={curve.length === 2 && isStraight(curve)} onClick={() => { apply(STRAIGHT); setActive(0) }} />
        </div>
      </div>

      {/* Inset by half a handle, so handles at the ends stay inside the panel. */}
      <div className="p-1.5">
        <div
          ref={area}
          className="relative aspect-square cursor-crosshair touch-none rounded-sm bg-input select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="absolute inset-0 overflow-hidden rounded-sm opacity-60">
            {inputs ? <Histogram bins={inputs} /> : <Skeleton className="absolute inset-0" />}
          </div>
          <svg viewBox="0 0 255 255" preserveAspectRatio="none" aria-hidden="true" className="pointer-events-none absolute inset-0 size-full">
            <path d="M63.75 0V255M127.5 0V255M191.25 0V255M0 63.75H255M0 127.5H255M0 191.25H255" className="stroke-foreground/10" vectorEffect="non-scaling-stroke" />
            <path d="M0 255L255 0" className="stroke-foreground/25" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            <path d={line} fill="none" className="stroke-foreground" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
          </svg>
          {curve.map(([px, py], i) => (
            <div
              key={i}
              data-point={i}
              role="slider"
              tabIndex={0}
              aria-label={pointName(i, curve.length)}
              aria-orientation="vertical"
              aria-valuemin={0}
              aria-valuemax={255}
              aria-valuenow={py}
              aria-valuetext={`Input ${px}, output ${py}`}
              aria-describedby={hint}
              onKeyDown={(e) => onKeyDown(e, i)}
              onFocus={() => setActive(i)}
              onDoubleClick={() => remove(i)}
              style={{ left: pct(px), top: pct(255 - py) }}
              className={cn(
                'absolute size-3 -translate-1/2 cursor-grab rounded-full bg-foreground ring-1 ring-card outline-none transition-shadow after:absolute after:-inset-2.5 hover:ring-2 focus-visible:ring-3 focus-visible:ring-ring active:cursor-grabbing',
                i === shown && 'bg-primary',
              )}
            />
          ))}
        </div>
      </div>

      <p id={hint} className="text-xs text-muted-foreground">
        Click to add a point. Drag it, or move it with the arrow keys (Shift for bigger steps). Double-click or Delete removes it.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <NumberField
          label={`${pointName(shown, curve.length)} input`}
          value={x}
          min={0}
          max={255}
          onChange={(v) => apply(movePoint(curve, shown, v, y))}
        />
        <NumberField
          label={`${pointName(shown, curve.length)} output`}
          value={y}
          min={0}
          max={255}
          onChange={(v) => apply(movePoint(curve, shown, x, v))}
        />
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Curve presets">
        {CURVE_PRESETS.map(([name, points]) => (
          <Button key={name} variant="outline" size="sm" aria-pressed={same(curve, points)} onClick={() => { apply(points); setActive(0) }} className="aria-pressed:bg-accent">
            {name}
          </Button>
        ))}
      </div>
    </div>
  )
}

const KINDS = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights'], ['custom', 'Custom']] as const
type Kind = (typeof KINDS)[number][0]
type Preset = Exclude<Kind, 'custom'>
const PRESET_KINDS = Object.keys(BAND_PRESETS) as Preset[]

const kindOf = (b: Band): Kind =>
  PRESET_KINDS.find((k) => BAND_PRESETS[k].from === b.from && BAND_PRESETS[k].to === b.to && BAND_PRESETS[k].soft === b.soft) ?? 'custom'

const amountText = (n: number) => (n === 0 ? 'None' : `${Math.round(Math.abs(n) * 100)}% ${n > 0 ? 'lighter' : 'darker'}`)

function BandFields({ band, index, change, remove }: { band: Band; index: number; change: (band: Band) => void; remove: () => void }) {
  const [custom, setCustom] = useState(false)
  const kind = custom ? 'custom' : kindOf(band)
  return (
    <div data-band className="flex flex-col gap-3" role="group" aria-label={`Range ${index + 1}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">Range {index + 1}</span>
        <IconButton label={`Remove range ${index + 1}`} icon={X} onClick={remove} className="-my-2" />
      </div>
      <Segmented<Kind>
        label={`Range ${index + 1} tones`}
        value={kind}
        options={KINDS}
        onChange={(next) => {
          setCustom(next === 'custom')
          if (next !== 'custom') change({ ...band, ...BAND_PRESETS[next] })
        }}
      />
      <SliderField label="Lighten or darken" value={band.amount} display={amountText(band.amount)} min={-1} max={1} step={0.05} onChange={(amount) => change({ ...band, amount })} />
      {kind === 'custom' && (
        <div className="grid grid-cols-3 gap-3">
          <NumberField label="From" value={band.from} min={0} max={255} onChange={(v) => change({ ...band, from: clamp(Math.round(v), 0, band.to) })} />
          <NumberField label="To" value={band.to} min={0} max={255} onChange={(v) => change({ ...band, to: clamp(Math.round(v), band.from, 255) })} />
          <NumberField label="Soft edge" value={band.soft} min={1} max={255} onChange={(v) => change({ ...band, soft: clamp(Math.round(v), 1, 255) })} />
        </div>
      )}
    </div>
  )
}

function BandsControl({ filter, setFilter }: { filter: Filter; setFilter: SetFilter }) {
  const box = useRef<HTMLDivElement>(null)
  const setBands = (bands: Band[]) => setFilter((f) => ({ ...f, bands }))
  const add = () => {
    const free = PRESET_KINDS.find((k) => !filter.bands.some((b) => kindOf(b) === k)) ?? 'shadows'
    setBands([...filter.bands, { ...BAND_PRESETS[free], amount: 0.3 }])
    setTimeout(() => [...(box.current?.querySelectorAll<HTMLElement>('[data-band]') ?? [])].at(-1)?.querySelector<HTMLElement>('[data-state=on]')?.focus())
  }
  return (
    <div ref={box} className="flex flex-col gap-4" role="group" aria-label="Tone ranges">
      <div className="flex items-center justify-between gap-3">
        <span className={LABEL}>Tone ranges</span>
        <IconButton label="Add a tone range" icon={Plus} disabled={filter.bands.length >= MAX_BANDS} onClick={add} className="-my-2" />
      </div>
      <p className="text-xs text-muted-foreground">
        Moves one part of the range up or down while the rest stays. Tones inside keep their contrast; the soft edges take up the change, so a darker tone never prints lighter than a brighter one.
      </p>
      {filter.bands.map((band, i) => (
        <BandFields
          key={i}
          band={band}
          index={i}
          change={(next) => setBands(filter.bands.map((b, j) => (j === i ? next : b)))}
          remove={() => {
            setBands(filter.bands.filter((_, j) => j !== i))
            setTimeout(() => box.current?.querySelector<HTMLElement>('button')?.focus())
          }}
        />
      ))}
    </div>
  )
}

const SWATCHES = ['#e5484d', '#e5c33d', '#46a758', '#3eb6c4', '#3e63dd', '#c34fbf']

function HuesControl({ filter, setFilter }: { filter: Filter; setFilter: SetFilter }) {
  const changed = filter.hues.filter((h) => h !== 0).length
  return (
    <Collapsible className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group/hues -ml-2.5 text-muted-foreground">
            <ChevronRight data-icon="inline-start" className="transition-transform group-data-[state=open]/hues:rotate-90" />
            Colour ranges{changed ? ` (${changed})` : ''}
          </Button>
        </CollapsibleTrigger>
        <IconButton label="Reset colour ranges" icon={RotateCcw} disabled={!changed} onClick={() => setFilter((f) => ({ ...f, hues: NO_HUES }))} className="-my-2" />
      </div>
      <CollapsibleContent className="flex flex-col gap-4 pt-1">
        <p className="text-xs text-muted-foreground">Lighten or darken one family of colours. Greys stay as they are; in the grey modes this changes how light each colour turns.</p>
        {HUES.map((name, i) => (
          <div key={name} className="flex items-end gap-3">
            <span aria-hidden="true" className="mb-0.5 size-3 shrink-0 rounded-full" style={{ backgroundColor: SWATCHES[i] }} />
            <div className="flex-1">
              <SliderField
                label={name}
                value={filter.hues[i]}
                display={amountText(filter.hues[i])}
                min={-1}
                max={1}
                step={0.05}
                onChange={(v) => setFilter((f) => ({ ...f, hues: f.hues.map((h, j) => (j === i ? v : h)) }))}
              />
            </div>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Curve, tone ranges and colour ranges: the Photoshop-style controls next to the ink settings. */
export function ToneControl({ src, filter, setFilter }: { src: string; filter: Filter; setFilter: SetFilter }) {
  const bins = useHistogram(src)
  return (
    <>
      <CurveEditor bins={bins} filter={filter} setFilter={setFilter} />
      <BandsControl filter={filter} setFilter={setFilter} />
      <HuesControl filter={filter} setFilter={setFilter} />
    </>
  )
}
