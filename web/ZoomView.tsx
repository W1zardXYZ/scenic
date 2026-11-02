import { useCallback, useEffect, useRef, useState } from 'react'
import { Maximize, Minus, Plus, Scan, X } from 'lucide-react'
import type { MapRecord } from '../shared/types.ts'
import { IconButton } from '@/components/controls'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { fullImage, thumb } from './api.ts'

const LARGE_THUMB = 2048
const MAX_SCALE = 4
const PAN_STEP = 120

interface View {
  scale: number
  x: number
  y: number
}

/** A map you can zoom to full resolution; the original only loads once the thumbnail runs out of detail. */
export function ZoomView({ map, alt, className, lightbox, shortcuts, onToggleLightbox }: {
  map: MapRecord
  alt: string
  className?: string
  lightbox: boolean
  shortcuts: boolean
  onToggleLightbox: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View | null>(null)
  const [fit, setFit] = useState(1)
  const [fullSrc, setFullSrc] = useState('')
  const [loading, setLoading] = useState(false)
  const pan = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const centred = useCallback((scale: number): View => {
    const { clientWidth: w = 0, clientHeight: h = 0 } = box.current ?? {}
    return { scale, x: (w - map.width * scale) / 2, y: (h - map.height * scale) / 2 }
  }, [map.width, map.height])

  const measure = useCallback(() => {
    const element = box.current
    if (!element) return
    const next = Math.min(element.clientWidth / map.width, element.clientHeight / map.height)
    setFit(next)
    setView((v) => (v && v.scale > fit ? v : centred(next)))
  }, [map.width, map.height, centred, fit])

  useEffect(() => {
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box.current!)
    return () => observer.disconnect()
  }, [measure])

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((v) => {
      if (!v) return v
      const element = box.current!
      const px = cx ?? element.clientWidth / 2
      const py = cy ?? element.clientHeight / 2
      const scale = Math.min(MAX_SCALE, Math.max(fit, v.scale * factor))
      if (scale === fit) return centred(fit)
      return { scale, x: px - ((px - v.x) / v.scale) * scale, y: py - ((py - v.y) / v.scale) * scale }
    })
  }, [fit, centred])

  useEffect(() => {
    if (!view || fullSrc || view.scale * Math.max(map.width, map.height) <= LARGE_THUMB) return
    setLoading(true)
    const image = new Image()
    const src = fullImage(map)
    image.onload = () => {
      setFullSrc(src)
      setLoading(false)
    }
    image.onerror = () => setLoading(false)
    image.src = src
    return () => {
      image.onload = null
    }
  }, [view, fullSrc, map])

  useEffect(() => {
    const element = box.current!
    const wheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = element.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)), e.clientX - rect.left, e.clientY - rect.top)
      else setView((v) => (v && v.scale > fit ? { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY } : v))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [zoomAt, fit])

  const zoomed = !!view && view.scale > fit * 1.001

  // Only with focus on the map or its zoom buttons, so these keys never fire from anywhere else.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const step = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] }[e.key]
    // Arrow keys switch variants at fit; once zoomed in they belong to the map.
    if (step && zoomed) {
      e.preventDefault()
      setView((v) => v && { ...v, x: v.x + step[0], y: v.y + step[1] })
      return
    }
    if (!shortcuts) return
    if (e.key === '+' || e.key === '=') zoomAt(1.4)
    else if (e.key === '-') zoomAt(1 / 1.4)
    else if (e.key === '0') setView(centred(fit))
    else if (e.key.toLowerCase() === 'f') onToggleLightbox()
  }

  return (
    <div
      ref={box}
      role="group"
      aria-label={`${alt}, zoomable map`}
      tabIndex={0}
      data-zoom-view
      onKeyDown={onKey}
      className={cn('relative isolate size-full touch-none overflow-hidden outline-offset-[-2px] select-none', zoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in', className)}
      onDoubleClick={(e) => {
        const rect = box.current!.getBoundingClientRect()
        if (zoomed) setView(centred(fit))
        else {
          const native = Math.max(fit * 2, Math.min(1, MAX_SCALE))
          zoomAt(native / fit, e.clientX - rect.left, e.clientY - rect.top)
        }
      }}
      onPointerDown={(e) => {
        if (!view || !zoomed || (e.target as Element).closest('button')) return
        e.currentTarget.setPointerCapture(e.pointerId)
        pan.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }
      }}
      onPointerMove={(e) => {
        const start = pan.current
        if (start) setView((v) => v && { ...v, x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py })
      }}
      onPointerUp={() => (pan.current = null)}
      onPointerCancel={() => (pan.current = null)}
    >
      {view && (
        <img
          src={fullSrc || thumb(map, 'large')}
          alt={alt}
          draggable={false}
          style={{
            width: map.width,
            height: map.height,
            maxWidth: 'none',
            transformOrigin: '0 0',
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            backgroundImage: `url(${thumb(map, 'large')})`,
            backgroundSize: '100% 100%',
            imageRendering: view.scale > 1.5 ? 'pixelated' : undefined,
          }}
          className="absolute top-0 left-0"
        />
      )}
      <div role="toolbar" aria-label="Zoom" className="absolute right-3 bottom-3 z-10 flex items-center gap-0.5 rounded-xl bg-popover/90 p-1 shadow-lg">
        {loading && <Spinner className="mx-2" aria-label="Loading full size" />}
        <span className="px-2 text-xs text-muted-foreground tabular-nums">{view ? `${Math.round(view.scale * 100)}%` : ''}</span>
        <IconButton label="Zoom out" shortcut={shortcuts ? '-' : undefined} side="top" icon={Minus} onClick={() => zoomAt(1 / 1.4)} disabled={!zoomed} />
        <IconButton label="Fit" shortcut={shortcuts ? '0' : undefined} side="top" icon={Scan} onClick={() => setView(centred(fit))} disabled={!zoomed} />
        <IconButton label="Zoom in" shortcut={shortcuts ? '+' : undefined} side="top" icon={Plus} onClick={() => zoomAt(1.4)} />
        <IconButton label={lightbox ? 'Close full view' : 'Full view'} shortcut={shortcuts ? 'F' : undefined} side="top" icon={lightbox ? X : Maximize} onClick={onToggleLightbox} />
      </div>
    </div>
  )
}
