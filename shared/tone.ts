// Levels shared by the print preview and the renderer, so both use the same curve.

export interface Levels {
  /** Input values at or below `black` print black, at or above `white` print white (0-255). */
  black: number
  white: number
  /** Above 1 lifts the midtones, below 1 darkens them. */
  gamma: number
}

export const NEUTRAL_LEVELS: Levels = { black: 0, white: 255, gamma: 1 }

export const isNeutral = (l: Levels) => l.black === 0 && l.white === 255 && l.gamma === 1

/** Output (0-255) for every input value. */
export function toneCurve({ black, white, gamma }: Levels): Uint8Array {
  const curve = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - black) / (white - black)))
    curve[v] = Math.round(t ** (1 / gamma) * 255)
  }
  return curve
}
