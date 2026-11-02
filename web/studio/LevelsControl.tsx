import { memo, startTransition, useEffect, useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Slider as SliderPrimitive } from 'radix-ui'
import { isNeutral, type Levels, NEUTRAL_LEVELS, toneCurve } from '../../shared/tone.ts'
import { IconButton, NumberField } from '@/components/controls'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { Filter } from './types.ts'

const SAMPLE_WIDTH = 400
const cache = new Map<string, Uint32Array>()

/** Luminance counts of an image, read from a small canvas copy and kept per image. */
function useHistogram(src: string): Uint32Array | null {
  const [bins, setBins] = useState(() => cache.get(src) ?? null)
  useEffect(() => {
    if (cache.has(src)) return setBins(cache.get(src)!)
    let stopped = false
    const image = new Image()
    image.onload = () => {
      if (stopped) return
      const canvas = document.createElement('canvas')
      canvas.width = SAMPLE_WIDTH
      canvas.height = Math.max(1, Math.round((image.naturalHeight / image.naturalWidth) * SAMPLE_WIDTH))
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
      const counts = new Uint32Array(256)
      for (let i = 0; i < data.length; i += 4) counts[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++
      cache.set(src, counts)
      setBins(counts)
    }
    image.src = src
    return () => {
      stopped = true
    }
  }, [src])
  return bins
}

const Graph = memo(function Graph({ bins }: { bins: Uint32Array }) {
  const path = useMemo(() => {
    // A few spikes (pure black backgrounds) must not flatten everything else.
    const peak = [...bins].sort((a, b) => a - b)[250] || 1
    let d = 'M0 100'
    bins.forEach((n, v) => {
      d += `L${v} ${(100 - Math.min(1, n / peak) * 100).toFixed(1)}`
    })
    return `${d}L255 100Z`
  }, [bins])
  return (
    <svg viewBox="0 0 255 100" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 size-full">
      <path d={path} className="fill-muted-foreground" />
    </svg>
  )
})

const pct = (v: number) => `${(v / 255) * 100}%`
const clamp = (n: number, low: number, high: number) => Math.min(high, Math.max(low, n))

/** Where the midtone handle sits: the input that prints as 50% grey. */
const midpoint = ({ black, white, gamma }: Levels) =>
  clamp(black + (white - black) * 0.5 ** gamma, black + 1, white - 1)

function gammaAt(mid: number, { black, white }: Levels) {
  const t = clamp((mid - black) / (white - black), 0.01, 0.99)
  return Number(clamp(Math.log(t) / Math.log(0.5), 0.1, 10).toFixed(2))
}

const THUMB = 'relative block size-3 rotate-45 rounded-[2px] ring-1 ring-foreground/40 outline-none transition-shadow after:absolute after:-inset-2.5 hover:ring-2 focus-visible:ring-3 focus-visible:ring-ring'

export function LevelsControl({ src, filter, setFilter }: {
  src: string
  filter: Filter
  setFilter: React.Dispatch<React.SetStateAction<Filter>>
}) {
  const bins = useHistogram(src)
  // The handles follow the pointer at once; the preview catches up when the browser is free.
  const [levels, setLevels] = useState(filter.levels)
  const apply = (next: Levels) => {
    setLevels(next)
    startTransition(() => setFilter((f) => ({ ...f, levels: next })))
  }

  const mid = midpoint(levels)
  const onHandles = ([black, handle, white]: number[]) => {
    if (black !== levels.black || white !== levels.white) apply({ ...levels, black, white })
    else apply({ ...levels, gamma: gammaAt(handle, levels) })
  }

  // The cut-off applies after the curve, so on this input axis it moves with the handles.
  const threshold = filter.mode === 'threshold'
  const cutoff = threshold ? toneCurve(levels).findIndex((v) => v >= filter.amount * 255) : -1

  return (
    <div className="flex flex-col gap-3" role="group" aria-label="Levels">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">Levels</span>
        <IconButton label="Reset levels" icon={RotateCcw} disabled={isNeutral(levels)} onClick={() => apply(NEUTRAL_LEVELS)} className="-my-2 -mr-2" />
      </div>

      {/* Inset by half a handle, so a handle's centre lines up with its histogram value. */}
      <div className="px-1.5">
        <div className="relative h-20 overflow-hidden rounded-sm bg-input">
          {bins ? <Graph bins={bins} /> : <Skeleton className="absolute inset-0" />}
          <div className="absolute inset-y-0 left-0 bg-card/70" style={{ width: pct(levels.black) }} />
          <div className="absolute inset-y-0 right-0 bg-card/70" style={{ width: `calc(100% - ${pct(levels.white)})` }} />
          {cutoff >= 0 && <div className="absolute inset-y-0 w-px bg-primary" style={{ left: pct(cutoff) }} />}
        </div>
      </div>

      <SliderPrimitive.Root
        min={0}
        max={255}
        step={1}
        minStepsBetweenThumbs={1}
        value={[levels.black, mid, levels.white]}
        onValueChange={onHandles}
        className="relative flex h-3 w-full touch-none items-center select-none"
      >
        <SliderPrimitive.Track className="relative h-px grow bg-accent" />
        <SliderPrimitive.Thumb aria-label="Black point" className={cn(THUMB, 'bg-black')} />
        <SliderPrimitive.Thumb aria-label="Midtone" aria-valuetext={`Gamma ${levels.gamma}`} className={cn(THUMB, 'bg-neutral-500')} />
        <SliderPrimitive.Thumb aria-label="White point" className={cn(THUMB, 'bg-white')} />
      </SliderPrimitive.Root>

      <div className="grid grid-cols-3 gap-3">
        <NumberField label="Black" value={levels.black} min={0} max={254} onChange={(black) => apply({ ...levels, black: clamp(Math.round(black), 0, levels.white - 1) })} />
        <NumberField label="Gamma" value={levels.gamma} min={0.1} max={10} step={0.05} onChange={(gamma) => apply({ ...levels, gamma: clamp(gamma, 0.1, 10) })} />
        <NumberField label="White" value={levels.white} min={1} max={255} onChange={(white) => apply({ ...levels, white: clamp(Math.round(white), levels.black + 1, 255) })} />
      </div>
    </div>
  )
}
