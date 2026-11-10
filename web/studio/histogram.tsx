import { memo, useEffect, useMemo, useState } from 'react'
import { greyOf } from '../../shared/tone.ts'

const SAMPLE_WIDTH = 400
const cache = new Map<string, Uint32Array>()

/** Luminance counts of an image, read from a small canvas copy and kept per image. */
export function useHistogram(src: string): Uint32Array | null {
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
      for (let i = 0; i < data.length; i += 4) counts[greyOf(data[i], data[i + 1], data[i + 2])]++
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

export const Histogram = memo(function Histogram({ bins, className }: { bins: ArrayLike<number>; className?: string }) {
  const path = useMemo(() => {
    // A few spikes (pure black backgrounds) must not flatten everything else.
    const peak = [...Array.from(bins)].sort((a, b) => a - b)[250] || 1
    let d = 'M0 100'
    for (let v = 0; v < 256; v++) d += `L${v} ${(100 - Math.min(1, bins[v] / peak) * 100).toFixed(1)}`
    return `${d}L255 100Z`
  }, [bins])
  return (
    <svg viewBox="0 0 255 100" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 size-full">
      <path d={path} className={className ?? 'fill-muted-foreground'} />
    </svg>
  )
})
