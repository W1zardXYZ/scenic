import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'

// The NAS image has no system fonts, so every printed word comes from this
// bundled face: embedded in PDFs, and as outlines wherever SVG is rasterized.

const file = (name: string) => fileURLToPath(new URL(`./fonts/AtkinsonHyperlegible-${name}.ttf`, import.meta.url))

export const FONT_FILE = { regular: file('Regular'), bold: file('Bold') }

const faces = {
  regular: fontkit.openSync(FONT_FILE.regular) as fontkit.Font,
  bold: fontkit.openSync(FONT_FILE.bold) as fontkit.Font,
}

export type Weight = keyof typeof faces

/** Width of `text` set at `size` (font units scaled to the caller's units). */
export function textWidth(text: string, size: number, weight: Weight = 'regular'): number {
  const face = faces[weight]
  return (face.layout(text).advanceWidth * size) / face.unitsPerEm
}

/** How far above the baseline capitals reach, so text can be centred on a point by eye. */
export const capHeight = (size: number, weight: Weight = 'regular') => (faces[weight].capHeight * size) / faces[weight].unitsPerEm

/**
 * `text` as SVG path data, centred on `x` with its capitals centred on `y`.
 * librsvg would otherwise look the font up through fontconfig and draw boxes when there is none.
 */
export function textPath(text: string, x: number, y: number, size: number, weight: Weight = 'regular'): string {
  const face = faces[weight]
  const scale = size / face.unitsPerEm
  const run = face.layout(text)
  let pen = x - (run.advanceWidth * scale) / 2
  const baseline = y + capHeight(size, weight) / 2
  return run.glyphs.map((glyph, i) => {
    const at = run.positions[i]
    const d = glyph.path
      .scale(scale, -scale)
      .translate(pen + at.xOffset * scale, baseline - at.yOffset * scale)
      .toSVG()
    pen += at.xAdvance * scale
    return d
  }).join('')
}
