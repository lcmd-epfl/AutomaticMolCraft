import React, { useCallback, useMemo } from 'react'
import GridLayout, { Layout, WidthProvider } from 'react-grid-layout'
import { useStore } from '../store/store'
import PlotPanel from './PlotPanel'

const ResponsiveGridLayout = WidthProvider(GridLayout)

export default function PanelLayout() {
  const plots = useStore(s => s.plots)
  const updatePlot = useStore(s => s.updatePlot)

  const layout: Layout[] = useMemo(
    () => plots.map(p => ({ i: p.id, x: p.panel.x, y: p.panel.y, w: p.panel.w, h: p.panel.h })),
    [plots]
  )

  const commitLayout = useCallback(
    (items: Layout[]) => {
      for (const item of items) {
        const p = plots.find(q => q.id === item.i)
        if (!p) continue
        const prev = p.panel
        if (prev.x === item.x && prev.y === item.y && prev.w === item.w && prev.h === item.h) continue
        updatePlot({ id: p.id, panel: { ...prev, x: item.x, y: item.y, w: item.w, h: item.h } } as any)
      }
    },
    [plots, updatePlot]
  )

  return (
    <div className="main">
      <ResponsiveGridLayout
        className="rgl"
        cols={12}
        rowHeight={36}
        margin={[8, 8]}
        containerPadding={[8, 8]}
        draggableHandle=".drag-handle"
        layout={layout}
        onDragStop={commitLayout}
        onResizeStop={commitLayout}
      >
        {plots.map(p => (
          <div key={p.id} data-grid={{ i: p.id, x: p.panel.x, y: p.panel.y, w: p.panel.w, h: p.panel.h }}>
            <PlotPanel plotId={p.id} />
          </div>
        ))}
      </ResponsiveGridLayout>
    </div>
  )
}

