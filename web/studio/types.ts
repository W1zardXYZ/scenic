import type { GridType, Page } from '../../shared/layout.ts'

export type LabeledPage = Page & { label: string }
export type Tool = 'select' | 'lasso' | 'hand' | 'page' | 'fog' | 'crop' | 'measure' | 'pick'

export interface Grid {
  type: GridType
  cols: number
  rows: number
  offsetX: number
  offsetY: number
}

export interface Overlay {
  show: boolean
  color: string
  opacity: number
  widthMm: number
  numbering: boolean
}

export interface Marks {
  cut: boolean
  labels: boolean
  overview: boolean
}

export type { Band, Filter, FilterMode, Sample, Selection } from '../../shared/tone.ts'
export type { CurvePoint, Fog, FogItem, FogPart, FogShape } from '../../shared/fog.ts'
export type FogDraw = 'select' | 'box' | 'lasso' | 'polygon'
export type FogCombine = 'new' | 'add' | 'subtract'
export type PickHow = 'new' | 'add' | 'subtract'
