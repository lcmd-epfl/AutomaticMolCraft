export type Column = Float32Array | Int32Array | string[]

export type NumericRange = { min: number; max: number }

export type DatasetStats = {
  /**
   * Optional precomputed ranges for numeric columns.
   * If not present, UI will lazily compute and cache.
   */
  numericRanges?: Record<string, NumericRange>
}


export type VectorSource = {
  kind: 'tool' | 'file'
  label?: string
}

export type MolecularVectorRecord = {
  name: string
  dtype: 'float32'
  valuesById: Record<string, number[]>
  missingIds: string[]
  source?: VectorSource
}

export type AtomPropertyRecord = {
  name: string
  dtype: 'float32'
  valuesById: Record<string, number[]>
  missingIds: string[]
  source?: VectorSource
}

export type Dataset = {
  ids: string[]
  columns: Record<string, Column>
  meta: { numericColumns: string[]; categoricalColumns: string[]; vectorColumns?: string[] }
  descriptors?: Record<string, DescriptorRecord>
  molecularVectors?: Record<string, MolecularVectorRecord>
  atomProperties?: Record<string, AtomPropertyRecord>

  /**
   * Optional stable order of columns to avoid Object.entries churn and keep UI consistent.
   */
  columnOrder?: string[]

  /**
   * Optional stats (ranges etc.) for big data performance.
   */
  stats?: DatasetStats
}

export type Workspace = {
  plots: PlotSpec[]
  filters: { ranges: Record<string, [number, number]>; categories: Record<string, string[]> }
  selection: Int32Array | number[]
}

export type PlotPanelSpec = { i: string; x: number; y: number; w: number; h: number }

export type ScatterMarkerShape = 'circle' | 'square' | 'diamond' | 'triangle'
export type ScatterGridDensity = 'auto' | 'light' | 'dense'
export type ScatterColorPalette = 'tealSunset' | 'viridis' | 'plasma' | 'cividis' | 'turbo'

export type Axis2DSettings = {
  range?: [number, number]
  tickCount?: number
  tickLabelSize?: number
  tickDecimals?: number
  label?: string
  labelSize?: number
}

export type Axis3DSettings = Axis2DSettings

export type ScatterSettings = {
  markerSize: number
  sizeBy?: string
  markerShape: ScatterMarkerShape
  shapeBy?: string
  markerColor: string
  colorBy?: string
  forceCategoricalColorBy?: boolean
  colorPalette?: ScatterColorPalette
  backgroundColor: string
  showColorbar: boolean
  showXAxis: boolean
  showYAxis: boolean
  showTickLabels: boolean
  showGrid: boolean
  gridDensity: ScatterGridDensity
  preserveAspectRatio: boolean
  opacity: number
  dimUnselected: boolean
  showStats: boolean
  xAxis?: Axis2DSettings
  yAxis?: Axis2DSettings
  zAxis?: Axis3DSettings
  viewCommand?: { type: 'fitAll' | 'fitVisible' | 'reset'; nonce: number }
}

export type HistogramGridDensity = 'auto' | 'light' | 'dense'

export type HistogramSettings = {
  binCount: number
  binSize?: number
  showStats: boolean
  backgroundColor: string
  barFillColor: string
  barBorderColor: string
  barOpacity: number
  showXAxis: boolean
  showYAxis: boolean
  showTickLabels: boolean
  showGrid: boolean
  gridDensity: HistogramGridDensity
  highlightSelectedBin: boolean
  dimUnselectedBins: boolean
  xAxis?: Axis2DSettings
  viewCommand?: { type: 'fitAll' | 'reset'; nonce: number }
  groupBy?: string
}

export type ScatterPlotSpec = {
  id: string
  type: 'scatter2d' | 'scatter3d'
  x: string
  y: string
  z?: string
  colorBy?: string
  sizeBy?: string
  scatterSettings?: Partial<ScatterSettings>
  view?: { xDomain?: [number, number]; yDomain?: [number, number]; zDomain?: [number, number] }
  panel: PlotPanelSpec
}

export type HistogramPlotSpec = {
  id: string
  type: 'hist1d'
  x: string
  histSettings?: Partial<HistogramSettings>
  panel: PlotPanelSpec
}

export type PlotSpec = ScatterPlotSpec | HistogramPlotSpec

export type DescriptorRecord = {
  name: string
  dim: number
  dtype: 'float32'
  valuesById: Record<string, number[]>
  missingIds: string[]
  source?: VectorSource
}
