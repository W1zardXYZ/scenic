import { useEffect, useRef, useState } from 'react'
import { type Filter, needsPreparing, prepareColours, type Selection, selectionWeights } from '../../shared/tone.ts'

const pixels = new Map<string, Promise<ImageData>>()

/** The decoded pixels of an image, kept per image. */
export function pixelsOf(src: string): Promise<ImageData> {
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
 * A copy of `src` made by `make`, as an object URL, redone whenever `key`
 * changes; an empty key makes nothing. Until a new copy is ready, the last
 * one stands in while it was made from the same image under the same `kind`.
 */
function useImageFrom(src: string, key: string, kind: string, make: (image: ImageData) => void): string | null {
  const [ready, setReady] = useState<{ src: string; kind: string; url: string } | null>(null)
  const latest = useRef(make)
  latest.current = make
  const url = useRef('')

  useEffect(() => {
    if (!key) return
    let stopped = false
    const timer = setTimeout(async () => {
      const source = await pixelsOf(src).catch(() => null)
      if (stopped || !source) return
      const image = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height)
      latest.current(image)
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      canvas.toBlob((blob) => {
        if (stopped || !blob) return
        if (url.current) URL.revokeObjectURL(url.current)
        url.current = URL.createObjectURL(blob)
        setReady({ src, kind, url: url.current })
      })
    }, SETTLE_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [key, src, kind])

  useEffect(() => () => URL.revokeObjectURL(url.current), [])

  return key && ready?.src === src && ready.kind === kind ? ready.url : null
}

/**
 * The preview image with the whole-pixel part of the filter (selections, hue
 * families, grey) already applied by the same code the renderer runs. The
 * per-value part is cheap enough for an SVG table on top.
 */
export function usePreparedImage(src: string, filter: Filter): string {
  const grey = filter.mode === 'grey' || filter.mode === 'threshold'
  const key = needsPreparing(filter) ? JSON.stringify([grey, filter.hues, filter.selections]) : ''
  return useImageFrom(src, key, grey ? 'grey' : 'colour', (image) => prepareColours(image.data, 4, filter)) ?? src
}

/** Photoshop's quick mask: what the selection leaves out, tinted. */
export function useSelectionMask(src: string, selection: Selection | null): string | null {
  const key = selection ? JSON.stringify([selection.samples, selection.fuzziness]) : ''
  return useImageFrom(src, key, 'mask', (image) => {
    const [weights] = selectionWeights(image.data, 4, [selection!])
    for (let i = 0, j = 0; i < image.data.length; i += 4, j++) {
      image.data[i] = 230
      image.data[i + 1] = 30
      image.data[i + 2] = 60
      image.data[i + 3] = Math.round((1 - weights[j] / 255) * 150)
    }
  })
}
