// Words that say where in a building a map is. Shared so the map view can lay
// variants out by floor using the same reading the scanner grouped them by.

const LEVELS: [RegExp, number][] = [
  [/^(?:sub)?basements?$|^cellars?$|^undercroft$|^sewers?$/, -1],
  [/^lower$|^downstairs$/, -0.5],
  [/^ground$|^main$|^interiors?$|^inside$|^indoors?$/, 0],
  [/^upper$|^upstairs$|^second$|^2nd$/, 1],
  [/^third$|^3rd$/, 2],
  [/^attic$|^loft$/, 3],
  [/^roofs?$|^rooftops?$|^exterior$/, 4],
]

const FLOOR_WORD = /^(?:floor|level|lvl|storey|story|deck)$/

/** Height of a map within its building, when the words say; floors count from the ground. */
export function levelOf(words: string[]): number | null {
  const lower = words.map((w) => w.toLowerCase())
  for (const [i, word] of lower.entries()) {
    const floor = /^(?:floor|level|lvl|storey|story|deck|f|l)-?(\d+)$/.exec(word)
    if (floor) return Number(floor[1])
    if (FLOOR_WORD.test(word) && /^\d+$/.test(lower[i + 1] ?? '')) return Number(lower[i + 1])
    const below = /^b-?(\d+)$/.exec(word)
    if (below) return -Number(below[1])
    for (const [pattern, height] of LEVELS) if (pattern.test(word)) return height
  }
  return null
}

/** Splits a variant label into where it is ("Exterior", "Floor 2") and how it looks ("Night Rain"). */
export function splitVariant(label: string): { floor: string; look: string; height: number | null } {
  const words = label.split(/\s+/).filter(Boolean)
  const floor: string[] = []
  const look: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (FLOOR_WORD.test(words[i].toLowerCase()) && /^\d+$/.test(words[i + 1] ?? '')) floor.push(words[i], words[++i])
    else if (levelOf([words[i]]) !== null) floor.push(words[i])
    else look.push(words[i])
  }
  return { floor: floor.join(' '), look: look.join(' '), height: levelOf(floor) }
}
