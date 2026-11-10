import { intersect, type Rect } from './layout.ts'

// The faded edge, shared by the print preview and the print generator so the
// two cannot drift apart. A white veil lies over the map and its grid: clear
// deep inside the printed area, solid white at its edge, so a dark map
// dissolves into the paper instead of ending in a hard inked rectangle.
// Positions are millimetres on the map plane, like shared/layout.ts.

/** The slider's reach; requests may ask for more. */
export const FADE_MAX_MM = 75

/** The part of the map that gets printed, and so the outline that fades: the crop, or the whole map. */
export function fadeRegion(mapW: number, mapH: number, crop?: Rect | null): Rect | null {
  const map = { x: 0, y: 0, w: mapW, h: mapH }
  return crop ? intersect(map, crop) : map
}

/** Eases in and out, so the fade has no visible start or end line the way a linear ramp does. */
const smooth = (t: number) => t * t * (3 - 2 * t)

/**
 * Per axis, how far a point lies into the fading band as a share of the band,
 * 0 at its inner side. A region narrower than two bands fades over half its size.
 */
function axisDepth(start: number, size: number, fadeMm: number) {
  const band = Math.min(fadeMm, size / 2)
  return (v: number) => Math.max(0, start + band - v, v - (start + size - band)) / band
}

/**
 * How much white covers the map at a point: 0 inside, rising to 1 at the
 * region's edge and staying 1 beyond it. The depth is measured to the inner
 * rectangle, so corners round off rather than meeting in a diagonal crease.
 */
export function fadeAt(region: Rect, fadeMm: number, x: number, y: number): number {
  if (!(fadeMm > 0)) return 0
  const t = Math.hypot(axisDepth(region.x, region.w, fadeMm)(x), axisDepth(region.y, region.h, fadeMm)(y))
  return t >= 1 ? 1 : smooth(t)
}

/**
 * The veil's alpha over `view`, `width` × `height` pixels sampled at their
 * centres, or null when none of `view` is veiled.
 */
export function fadeMask(region: Rect, fadeMm: number, view: Rect, width: number, height: number): Uint8ClampedArray | null {
  if (!(fadeMm > 0) || width < 1 || height < 1) return null
  const depthX = axisDepth(region.x, region.w, fadeMm)
  const depthY = axisDepth(region.y, region.h, fadeMm)
  const xs = Float64Array.from({ length: width }, (_, i) => depthX(view.x + ((i + 0.5) * view.w) / width) ** 2)
  const ys = Float64Array.from({ length: height }, (_, j) => depthY(view.y + ((j + 0.5) * view.h) / height) ** 2)
  if (xs.every((v) => v === 0) && ys.every((v) => v === 0)) return null
  const alpha = new Uint8ClampedArray(width * height)
  for (let j = 0; j < height; j++) {
    const row = j * width
    for (let i = 0; i < width; i++) {
      const t2 = xs[i] + ys[j]
      if (t2 > 0) alpha[row + i] = t2 >= 1 ? 255 : Math.round(smooth(Math.sqrt(t2)) * 255)
    }
  }
  return alpha
}
