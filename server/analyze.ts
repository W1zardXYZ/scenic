import sharp from 'sharp'
import { detectGrid, isConfident } from './grid.ts'
import { findLattice, type Lattice } from './lattice.ts'

sharp.cache(false)

/** Refuses decompression bombs while still allowing very large poster maps. */
export const PIXEL_LIMIT = 2_000_000_000

const LARGE = 2048
const SMALL = 640
const GRID_CROP = 4096
const SIG_SIZE = 32

export interface Analysis {
  format: string
  width: number
  height: number
  ink: number
  color: string
  colors: string[]
  sig: Int8Array
  period: { x: number; y: number; phaseX: number; phaseY: number } | null
  lattice: Lattice
}

const FAMILIES: [string, number, number][] = [
  ['Red', 345, 15], ['Orange', 15, 40], ['Yellow', 40, 70], ['Green', 70, 165],
  ['Teal', 165, 200], ['Blue', 200, 255], ['Purple', 255, 345],
]

function colorFamilies(rgb: Buffer): { color: string; colors: string[]; ink: number } {
  const weights = new Map<string, number>()
  let ink = 0, r = 0, g = 0, b = 0
  const pixels = rgb.length / 3
  const add = (name: string, weight: number) => weights.set(name, (weights.get(name) ?? 0) + weight)
  for (let i = 0; i < rgb.length; i += 3) {
    const [R, G, B] = [rgb[i], rgb[i + 1], rgb[i + 2]]
    r += R; g += G; b += B
    const max = Math.max(R, G, B)
    const min = Math.min(R, G, B)
    const chroma = max - min
    const light = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 255
    ink += 1 - light
    const saturation = max ? chroma / max : 0
    if (light < 0.08) add('Black', 1)
    else if (saturation < 0.16) add(light > 0.75 ? 'White' : 'Grey', 1)
    else {
      const hue = (max === R ? ((G - B) / chroma + 6) % 6 : max === G ? (B - R) / chroma + 2 : (R - G) / chroma + 4) * 60
      const family = FAMILIES.find(([, from, to]) => (from > to ? hue >= from || hue < to : hue >= from && hue < to))
      // Low-value oranges are what maps call brown: dirt, wood, leather.
      add(family?.[0] === 'Orange' && max < 170 ? 'Brown' : family?.[0] ?? 'Grey', 0.5 + saturation)
    }
  }
  const total = [...weights.values()].reduce((a, c) => a + c, 0)
  const colors = [...weights.entries()]
    .sort((a, c) => c[1] - a[1])
    .filter(([, w], i) => i === 0 || w / total >= 0.12)
    .slice(0, 3)
    .map(([name]) => name)
  const hex = [r, g, b].map((c) => Math.round(c / pixels).toString(16).padStart(2, '0')).join('')
  return { color: `#${hex}`, colors, ink: ink / pixels }
}

/** Edge-strength fingerprint: the same scene correlates strongly whatever its lighting. */
function signature(grey: Buffer, size: number): Int8Array {
  const edges = new Float64Array(size * size)
  let mean = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (dx: number, dy: number) =>
        grey[Math.min(size - 1, Math.max(0, y + dy)) * size + Math.min(size - 1, Math.max(0, x + dx))]
      const e = Math.abs(at(1, 0) - at(-1, 0)) + Math.abs(at(0, 1) - at(0, -1))
      edges[y * size + x] = e
      mean += e
    }
  }
  mean /= edges.length
  let peak = 1
  for (const e of edges) peak = Math.max(peak, Math.abs(e - mean))
  return Int8Array.from(edges, (e) => Math.round(((e - mean) / peak) * 127))
}

export async function analyzeImage(input: string, thumbs: { large: string; small: string }): Promise<Analysis> {
  const open = () => sharp(input, { limitInputPixels: PIXEL_LIMIT })
  const meta = await open().metadata()
  const width = meta.width
  const height = meta.pageHeight ?? meta.height
  const format = meta.format === 'jpeg' ? 'jpg' : meta.format === 'heif' ? 'avif' : meta.format

  // Everything visual comes from the large thumbnail so the source is decoded once.
  await open()
    .resize(LARGE, LARGE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .webp({ quality: 82, effort: 2 })
    .toFile(thumbs.large)
  const large = () => sharp(thumbs.large)
  await large().resize(SMALL, SMALL, { fit: 'inside' }).webp({ quality: 74, effort: 2 }).toFile(thumbs.small)

  const tiny = await large().resize(96, 96, { fit: 'fill' }).removeAlpha().raw().toBuffer()
  const sigGrey = await large().resize(SIG_SIZE, SIG_SIZE, { fit: 'fill' }).greyscale().raw().toBuffer()

  const w = Math.min(GRID_CROP, width)
  const h = Math.min(GRID_CROP, height)
  const crop = { left: (width - w) >> 1, top: (height - h) >> 1, width: w, height: h }
  const raw = await open().extract(crop).flatten({ background: '#ffffff' }).greyscale().raw().toBuffer({ resolveWithObject: true })
  const grid = detectGrid(raw.data, raw.info.width, raw.info.height)
  const confident = grid && isConfident(grid)
  const lattice = confident ? { hex: null, tile: null } : findLattice(raw.data, raw.info.width, raw.info.height)

  return {
    format,
    width,
    height,
    ...colorFamilies(tiny),
    sig: signature(sigGrey, SIG_SIZE),
    lattice,
    period: confident
      ? {
          x: grid.x.period,
          y: grid.y.period,
          phaseX: (grid.x.phase + crop.left) % grid.x.period,
          phaseY: (grid.y.phase + crop.top) % grid.y.period,
        }
      : null,
  }
}
