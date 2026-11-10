import { useEffect, useRef, useState } from 'react'
import { type Filter, needsPreparing, prepareColours } from '../../shared/tone.ts'

const pixels = new Map<string, Promise<ImageData>>()

function pixelsOf(src: string): Promise<ImageData> {
  let loading = pixels.get(src)
  if (!loading) {
    loading = new Promise<ImageData>((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        resolve(context.getImageData(0, 0, canvas.width, canvas.height))
      }
      image.onerror = reject
      image.src = src
    })
    pixels.set(src, loading)
    loading.catch(() => pixels.delete(src))
  }
  return loading
}

/** Leaves a slider's run of values time to settle before the image is redone. */
const SETTLE_MS = 60

/**
 * The preview image with the whole-pixel part of the filter (hue families,
 * grey) already applied by the same code the renderer runs. The per-value
 * part is cheap enough for an SVG table on top.
 */
export function usePreparedImage(src: string, filter: Filter): string {
  const needed = needsPreparing(filter)
  const grey = filter.mode === 'grey' || filter.mode === 'threshold'
  const key = needed ? JSON.stringify([src, grey, filter.hues]) : ''
  const [ready, setReady] = useState<{ src: string; grey: boolean; url: string } | null>(null)
  const latest = useRef(filter)
  latest.current = filter
  const url = useRef('')

  useEffect(() => {
    if (!key) return
    let stopped = false
    const timer = setTimeout(async () => {
      const source = await pixelsOf(src).catch(() => null)
      if (stopped || !source) return
      const image = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
      prepareColours(image.data, 4, latest.current)
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      canvas.toBlob((blob) => {
        if (stopped || !blob) return
        if (url.current) URL.revokeObjectURL(url.current)
        url.current = URL.createObjectURL(blob)
        setReady({ src, grey, url: url.current })
      })
    }, SETTLE_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [key, src, grey])

  useEffect(() => () => URL.revokeObjectURL(url.current), [])

  // An older result stands in while a new one is made, as long as it shows the same map in the same kind of colour.
  return needed && ready?.src === src && ready.grey === grey ? ready.url : src
}
