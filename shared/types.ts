/** `overlay` marks a piece laid over the scene's maps; overlays are listed apart from the variants. */
export type VariantKind = 'level' | 'lighting' | 'weather' | 'labels' | 'other' | 'overlay'

export type GridSource = 'manual' | 'vtt' | 'visual' | 'filename' | 'pattern' | 'sibling' | 'guess'

export type GridType = 'square' | 'hex' | 'hexPointy'

export interface MapRecord {
  id: number
  name: string
  rel: string
  creator: string
  pack: string
  format: string
  bytes: number
  width: number
  height: number
  /** Pixels per square along each axis; equal unless a manual grid stretches the map. */
  ppsX: number
  ppsY: number
  /** Pixel position of the first grid line. */
  offsetX: number
  offsetY: number
  gridSource: GridSource
  gridType: GridType
  edited: boolean
  hasGrid: boolean
  labelled: boolean
  groupId: number
  variant: string
  variantKind: VariantKind
  /** 0 is a white page and 1 solid black. */
  ink: number
  color: string
  colors: string[]
  time: string
  weather: string
  biomes: string[]
  walls: number
  lights: number
  favorite: boolean
  hidden: boolean
  mtime: number
}

export interface MapGroup {
  id: number
  title: string
  creator: string
  pack: string
  coverId: number
  mapIds: number[]
  /** Overlays of this scene's maps, which are not among `mapIds`. */
  overlayIds: number[]
}

export interface Profile {
  site?: string
  patreon?: string
  /** Chosen colour; without one the box takes the image's or the maps' colour. */
  color?: string
  avatar?: string
  avatarColor?: string
  banner?: string
  bannerColor?: string
  /** A top-level folder that is one big project rather than a person: its projects become sub-projects. */
  asProject?: string
  /** 'adventure' marks a project that groups the maps of one adventure. */
  type?: string
}

export interface Library {
  maps: MapRecord[]
  groups: MapGroup[]
  /** Keyed by name. */
  creators: Record<string, Profile>
  /** Keyed by `projectKey`. */
  projects: Record<string, Profile>
}

export const projectKey = (creator: string, project: string) => JSON.stringify([creator, project])

export interface Root {
  id: number
  path: string
  online: boolean
}

export interface ScanStatus {
  running: boolean
  phase: 'idle' | 'walking' | 'analyzing' | 'grouping'
  done: number
  total: number
  current: string
  failed: number
  indexed: number
  roots: Root[]
}

export interface FailedFile {
  rel: string
  error: string
}

/** Hand corrections; each survives rescans and file moves. `null` restores the detected value. */
export interface MapEdit {
  scene?: string | null
  variant?: string | null
  kind?: VariantKind | null
  order?: number | null
  creator?: string | null
  pack?: string | null
  tags?: string[] | null
  favorite?: boolean | null
  hidden?: boolean | null
}
