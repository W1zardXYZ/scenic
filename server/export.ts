import { PassThrough, pipeline, Readable } from 'node:stream'
import sharp from 'sharp'
import yazl from 'yazl'
import type { FileRow } from './db.ts'
import { PIXEL_LIMIT } from './analyze.ts'
import { localImage, readVtt, type VttData } from './source.ts'

export const FORMATS = ['jpg', 'png', 'webp', 'avif', 'tiff', 'dd2vtt'] as const
export type ExportFormat = (typeof FORMATS)[number]

export interface ExportOptions {
  format: ExportFormat
  quality: number
  /** Target pixels per square; 0 keeps the source resolution. */
  pps: number
}

export const safeName = (name: string) => name.replace(/[^\p{L}\p{N} ._()[\]-]+/gu, '_').slice(0, 180)

function encoder(file: FileRow, input: string, options: ExportOptions, as: Exclude<ExportFormat, 'dd2vtt'>) {
  const image = sharp(input, { limitInputPixels: PIXEL_LIMIT })
  const scale = options.pps ? options.pps / (file.width / file.cols) : 1
  if (scale < 1) image.resize(Math.round(file.width * scale))
  switch (as) {
    case 'jpg': return image.flatten({ background: '#ffffff' }).jpeg({ quality: options.quality, mozjpeg: true })
    case 'png': return image.png({ compressionLevel: 8 })
    case 'webp': return image.webp({ quality: options.quality })
    case 'avif': return image.avif({ quality: options.quality })
    case 'tiff': return image.tiff({ compression: 'lzw' })
  }
}

/** Universal VTT keeps walls, portals and lights in grid units, so they survive a resize untouched. */
async function universalVtt(file: FileRow, input: string, options: ExportOptions): Promise<Buffer> {
  const sidecar: VttData | null =
    file.kind === 'vtt' ? await readVtt(file) : file.vtt_path ? await readVtt({ path: file.vtt_path, entry: file.vtt_entry ?? '', mtime: file.mtime }) : null
  const image = await encoder(file, input, options, 'webp').toBuffer()
  const { width } = await sharp(image).metadata()
  // Walls and lights are positioned in the source file's own grid units, so its grid size stays.
  const size = sidecar?.resolution.map_size ?? { x: Math.round(file.cols), y: Math.round(file.rows) }
  const output: VttData = {
    format: 0.3,
    line_of_sight: [],
    objects_line_of_sight: [],
    portals: [],
    lights: [],
    ...sidecar,
    resolution: {
      map_origin: { x: 0, y: 0 },
      map_size: size,
      pixels_per_grid: width / size.x,
    },
    image: image.toString('base64'),
  }
  return Buffer.from(JSON.stringify(output))
}

export interface Exported {
  name: string
  stream: Readable
}

export const exportName = (file: FileRow, format: ExportFormat) => `${safeName(file.name)}.${format}`

export async function exportMap(file: FileRow, options: ExportOptions): Promise<Readable> {
  const input = await localImage(file)
  if (options.format === 'dd2vtt') return Readable.from([await universalVtt(file, input, options)])
  // sharp's own stream is a duplex, which Readable.toWeb cuts short.
  const output = new PassThrough()
  pipeline(encoder(file, input, options, options.format), output, () => {})
  return output
}

/** One archive holding every file; each is converted only as the download reaches it. */
export function exportZip(files: FileRow[], options: ExportOptions): Readable {
  const zip = new yazl.ZipFile()
  const used = new Set<string>()
  for (const file of files) {
    let name = exportName(file, options.format)
    for (let n = 2; used.has(name); n++) name = `${n} ${exportName(file, options.format)}`
    used.add(name)
    const lazily = async function* () {
      yield* await exportMap(file, options)
    }
    zip.addReadStream(Readable.from(lazily(), { objectMode: false }), name, { compress: false })
  }
  zip.end()
  return zip.outputStream as Readable
}
