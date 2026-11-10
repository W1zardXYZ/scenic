import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, Pipette, Plus, RotateCcw, X } from 'lucide-react'
import {
  type Band, BAND_PRESETS, CURVE_PRESETS, curveFunction, curveInputs, FUZZINESS, greyOf, HUES, isStraight, MAX_BANDS, MAX_CURVE_POINTS, MAX_SAMPLES,
  MAX_SELECTIONS, NEW_SELECTION, NO_HUES, type Selection, selectionWeights, STRAIGHT,
} from '../../shared/tone.ts'
import { ColorWell, IconButton, NumberField, Segmented, SliderField, SwitchRow } from '@/components/controls'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { Histogram, useHistogram } from './histogram.tsx'
import type { Filter } from './types.ts'
import { useDraft } from './use-draft.ts'
import { pixelsOf } from './use-prepared-image.ts'

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

/** A brightness curve over the histogram of the tones it acts on. */
function CurveEditor({ label, value, onChange, bins, presets = true }: {
  label: string
  value: Point[]
  onChange: (curve: Point[]) => void
  /** Counts of the tones that reach the curve; null while they load. */
  bins: ArrayLike<number> | null
  presets?: boolean
}) {
  const [curve, commit] = useDraft(value, onChange)
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
    <div className="flex flex-col gap-3" role="group" aria-label={label}>
      <div className="flex items-center justify-between gap-3">
        <span className={LABEL}>{label}</span>
        <div className="-my-2 flex">
          <IconButton label={`Add a point to the ${label.toLowerCase()}`} icon={Plus} disabled={curve.length >= MAX_CURVE_POINTS} onClick={addInGap} />
          <IconButton label={`Reset the ${label.toLowerCase()}`} icon={RotateCcw} disabled={curve.length === 2 && isStraight(curve)} onClick={() => { apply(STRAIGHT); setActive(0) }} />
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
            {bins ? <Histogram bins={bins} /> : <Skeleton className="absolute inset-0" />}
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

      {presets && <div className="flex flex-wrap gap-2" role="group" aria-label={`${label} presets`}>
        {CURVE_PRESETS.map(([name, points]) => (
          <Button key={name} variant="outline" size="sm" aria-pressed={same(curve, points)} onClick={() => { apply(points); setActive(0) }} className="aria-pressed:bg-accent">
            {name}
          </Button>
        ))}
      </div>}
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
  const setCurve = useCallback((curve: Point[]) => setFilter((f) => ({ ...f, curve })), [setFilter])
  return (
    <>
      <CurveEditor label="Curve" value={filter.curve} onChange={setCurve} bins={inputs} />
      <BandsControl filter={filter} setFilter={setFilter} />
      <HuesControl filter={filter} setFilter={setFilter} />
    </>
  )
}

/** Every so many pixels is plenty for a histogram. */
const HISTOGRAM_STEP = 3

/** Grey values of the pixels a selection picks, each counted by how much it belongs. */
function useSelectionHistogram(src: string, selection: Selection | undefined): Float64Array | null {
  const [bins, setBins] = useState<{ key: string; counts: Float64Array } | null>(null)
  const key = selection ? JSON.stringify([src, selection.samples, selection.fuzziness]) : ''
  useEffect(() => {
    if (!key || !selection) return
    let stopped = false
    const timer = setTimeout(async () => {
      const { data } = await pixelsOf(src)
      if (stopped) return
      const sample = new Uint8Array(Math.ceil(data.length / 4 / HISTOGRAM_STEP) * 3)
      for (let i = 0, j = 0; i < data.length; i += 4 * HISTOGRAM_STEP, j += 3) sample.set(data.subarray(i, i + 3), j)
      const [weights] = selectionWeights(sample, 3, [selection])
      const counts = new Float64Array(256)
      for (let j = 0; j < weights.length; j++) if (weights[j]) counts[greyOf(sample[j * 3], sample[j * 3 + 1], sample[j * 3 + 2])] += weights[j]
      setBins({ key, counts })
    }, 120)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return bins?.key === key ? bins.counts : null
}

const HEX = /^#?([0-9a-f]{6})$/i

/** Adds a sample by typing or choosing a colour, for keyboards and exact values. */
function SampleInput({ add, full }: { add: (color: string, subtract: boolean) => void; full: boolean }) {
  const [text, setText] = useState('#808080')
  const id = useId()
  const match = HEX.exec(text.trim())
  const color = match ? `#${match[1].toLowerCase()}` : null
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs text-muted-foreground">Colour by value</label>
      <div className="flex items-center gap-2">
        <ColorWell label="Choose a colour" value={color ?? '#808080'} onChange={setText} />
        <Input id={id} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!color} spellCheck={false} className="min-w-0 flex-1 font-mono" />
        <Button variant="outline" size="sm" disabled={!color || full} onClick={() => add(color!, false)}>Add</Button>
        <Button variant="outline" size="sm" disabled={!color || full} onClick={() => add(color!, true)}>Take out</Button>
      </div>
    </div>
  )
}

/** Photoshop's Select → Color Range: pick colours on the map, then change the brightness of just those pixels. */
export function SelectionsControl({ src, filter, setFilter, active, setActive, showMask, setShowMask, pick }: {
  src: string
  filter: Filter
  setFilter: SetFilter
  active: number
  setActive: (index: number) => void
  showMask: boolean
  setShowMask: (show: boolean) => void
  pick: () => void
}) {
  const { selections } = filter
  const index = Math.min(active, selections.length - 1)
  const current = selections[index] as Selection | undefined
  const bins = useSelectionHistogram(src, current)
  const box = useRef<HTMLDivElement>(null)

  const setSelections = (change: (list: Selection[]) => Selection[]) => setFilter((f) => ({ ...f, selections: change(f.selections) }))
  const change = (patch: Partial<Selection>) => setSelections((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)))
  const setCurve = useCallback((curve: Point[]) => setFilter((f) => ({ ...f, selections: f.selections.map((s, i) => (i === index ? { ...s, curve } : s)) })), [setFilter, index])
  const add = () => {
    setSelections((list) => [...list, NEW_SELECTION])
    setActive(selections.length)
    pick()
  }
  const move = (from: number, to: number) => {
    setSelections((list) => {
      const next = [...list]
      ;[next[from], next[to]] = [next[to], next[from]]
      return next
    })
    setActive(to)
    setTimeout(() => box.current?.querySelector<HTMLElement>(`[data-selection="${to}"]`)?.focus())
  }
  const remove = (i: number) => {
    setSelections((list) => list.filter((_, j) => j !== i))
    setActive(Math.max(0, i - 1))
    setTimeout(() => box.current?.querySelector<HTMLElement>('[data-selection], button')?.focus())
  }
  const addSample = (color: string, subtract: boolean) =>
    change({ samples: [...(current?.samples ?? []), { color, subtract }].slice(0, MAX_SAMPLES) })

  return (
    <div ref={box} className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Pick colours on the map, then lighten or darken just those pixels. Colours are matched before any grey or B&amp;W conversion, so this works in every ink mode. Later selections apply on top of earlier ones.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={pick} disabled={!current && selections.length >= MAX_SELECTIONS}>
          <Pipette data-icon="inline-start" />Pick on the map
        </Button>
        <Button variant="outline" size="sm" onClick={add} disabled={selections.length >= MAX_SELECTIONS}>
          <Plus data-icon="inline-start" />New selection
        </Button>
      </div>

      {selections.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Selections, applied top to bottom">
          {selections.map((s, i) => (
            <li key={i} className={cn('flex items-center gap-1 rounded-lg pl-1', i === index && 'bg-input')}>
              <button
                type="button"
                data-selection={i}
                aria-pressed={i === index}
                onClick={() => setActive(i)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring"
              >
                <span className="shrink-0">Selection {i + 1}</span>
                <span className="flex min-w-0 gap-0.5 overflow-hidden" aria-hidden="true">
                  {s.samples.map((x, j) => (
                    <span key={j} className={cn('size-3 shrink-0 rounded-full ring-1 ring-foreground/15', x.subtract && 'opacity-40')} style={{ backgroundColor: x.color }} />
                  ))}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.samples.length ? amountText(s.amount) : 'Nothing picked'}</span>
              </button>
              <IconButton label={`Move selection ${i + 1} up`} icon={ArrowUp} disabled={i === 0} onClick={() => move(i, i - 1)} className="shrink-0" />
              <IconButton label={`Move selection ${i + 1} down`} icon={ArrowDown} disabled={i === selections.length - 1} onClick={() => move(i, i + 1)} className="shrink-0" />
              <IconButton label={`Remove selection ${i + 1}`} icon={X} onClick={() => remove(i)} className="shrink-0" />
            </li>
          ))}
        </ul>
      )}

      {current && (
        <div className="flex flex-col gap-4" role="group" aria-label={`Selection ${index + 1}`}>
          <div className="flex flex-col gap-2">
            <span className={LABEL}>Colours in selection {index + 1}</span>
            {current.samples.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {current.samples.map((x, j) => (
                  <li key={j} className="flex items-center gap-1.5 rounded-full bg-input py-0.5 pr-0.5 pl-1.5 text-xs">
                    <span aria-hidden="true" className="size-4 rounded-full ring-1 ring-foreground/15" style={{ backgroundColor: x.color }} />
                    <span className="font-mono">{x.subtract ? '− ' : ''}{x.color}</span>
                    <IconButton
                      label={`Remove ${x.subtract ? 'taken out ' : ''}colour ${x.color}`}
                      icon={X}
                      onClick={() => change({ samples: current.samples.filter((_, k) => k !== j) })}
                      className="size-6"
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing picked yet. Use the colour picker on the map: click to pick, Shift-click to add, Alt-click to take a colour out.</p>
            )}
            <SampleInput add={addSample} full={current.samples.length >= MAX_SAMPLES} />
          </div>
          <SliderField
            label="Fuzziness"
            value={current.fuzziness}
            display={String(current.fuzziness)}
            min={FUZZINESS.min}
            max={FUZZINESS.max}
            step={1}
            onChange={(fuzziness) => change({ fuzziness })}
          />
          <SwitchRow label="Show the selection on the map" hint="Tints what is left out" checked={showMask} onCheckedChange={setShowMask} />
          <SliderField label="Lighten or darken" value={current.amount} display={amountText(current.amount)} min={-1} max={1} step={0.05} onChange={(amount) => change({ amount })} />
          <CurveEditor label="Selection curve" value={current.curve} onChange={setCurve} bins={bins} presets={false} />
        </div>
      )}
    </div>
  )
}
