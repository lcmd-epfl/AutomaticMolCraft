import { useStore } from './store'

export const useDataset = () => useStore(s => s.dataset)
export const usePlots = () => useStore(s => s.plots)

export const useVisibleIndices = () => useStore(s => s.visibleIndices)
export const useVisibleCount = () => useStore(s => s.visibleCount)

export const useSelection = () => useStore(s => s.selectedIndices)
export const useLoading = () => useStore(s => s.parsing)
export const useProgress = () => useStore(s => s.progress)

