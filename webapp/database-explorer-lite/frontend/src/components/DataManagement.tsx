import React, { useMemo, useState } from 'react'
import { useStore } from '../store/store'

export default function DataManagement() {
  const ds = useStore(s => s.dataset)
  const dropColumns = useStore(s => s.removeColumns)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const numericCols = useMemo(() => ds?.meta.numericColumns ?? [], [ds])

  const toggle = (name: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(numericCols))
  const selectNone = () => setSelected(new Set())
  const selectNumericOnly = () => setSelected(new Set(numericCols))

  const onDelete = () => {
    if (!ds) return
    if (selected.size === 0) return
    setConfirmDeleteOpen(true)
  }

  return (
    <div style={{ padding: '0 10px' }}>
      <div className="notice">
        🛠️ Data management: modify the loaded dataset (drop properties, add computed properties/descriptors, export).
      </div>

      {/* Overview (tighter) */}
      <div className="card" style={{ marginBottom: 10, padding: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>Overview</div>
        {!ds ? (
          <div className="legend" style={{ margin: 0 }}>
            No dataset loaded yet. Go to the <b>Visualization</b> tab, load/build a dataset, then come back here.
          </div>
        ) : (
          <div className="legend" style={{ margin: 0 }}>
            Dataset loaded: <b>{ds.ids.length.toLocaleString()}</b> molecules,{' '}
            <b>{Object.keys(ds.columns).length}</b> scalar properties.
          </div>
        )}
      </div>

      {/* Drop properties */}
      <div className="card" style={{ marginBottom: 10, padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Drop properties</div>

        {!ds ? (
          <div className="legend" style={{ margin: 0 }}>
            Load a dataset first.
          </div>
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.25fr 0.75fr',
              gap: 12,
              alignItems: 'stretch'
            }}
          >
            {/* Left column: buttons + list */}
            <div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                <button onClick={selectAll}>Select all</button>
                <button onClick={selectNone}>Select none</button>
                <button onClick={selectNumericOnly}>Select numeric</button>
              </div>

              <PropertyList
                title={`Properties (${numericCols.length})`}
                cols={numericCols}
                selected={selected}
                onToggle={toggle}
              />
            </div>

            {/* Right column: vertically centered */}
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                gap: 10,
                padding: '4px 0',
              }}
            >
              <div className="legend" style={{ margin: 0 }}>
                Note: in-memory only (no persistence). Plots/filters that rely on deleted properties will be
                auto-adjusted.
              </div>

              <button onClick={onDelete} disabled={selected.size === 0} style={{ width: '100%' }}>
                Delete selected
              </button>

              <div className="legend" style={{ margin: 0 }}>
                {selected.size === 0 ? (
                  <>No properties selected</>
                ) : (
                  <>
                    <b>{selected.size}</b> propert{selected.size === 1 ? 'y' : 'ies'} will be deleted
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Placeholders (compact) */}
      <div className="card" style={{ marginBottom: 10, padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Add computed property</div>
        <div className="legend" style={{ margin: 0 }}>
          Placeholder. Next we’ll add backend-powered property/descriptor generation.
        </div>
      </div>

      <div className="card" style={{ padding: 10 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Export</div>
        <div className="legend" style={{ margin: 0 }}>
          Placeholder. Next we’ll add CSV / XYZ zip / ASE DB / NPZ export.
        </div>
      </div>

      {confirmDeleteOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 9999,
            display: 'grid',
            placeItems: 'center',
            padding: 16,
          }}
          onMouseDown={() => setConfirmDeleteOpen(false)}
        >
          <div
            className="card"
            style={{ width: 'min(640px, 96vw)', padding: 14, borderRadius: 12 }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div style={{ fontWeight: 800, fontSize: 16, marginBottom: 6 }}>
              Delete selected properties?
            </div>
            <div className="legend" style={{ marginBottom: 10 }}>
              Delete {selected.size.toLocaleString()} propert{selected.size === 1 ? 'y' : 'ies'} from the
              in-memory dataset? This updates visualization immediately.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setConfirmDeleteOpen(false)}>Cancel</button>
              <button
                style={{ border: '1px solid #7a1d1d', color: '#ffb4b4' }}
                onClick={() => {
                  dropColumns(Array.from(selected))
                  setSelected(new Set())
                  setConfirmDeleteOpen(false)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PropertyList({
  title,
  cols,
  selected,
  onToggle
}: {
  title: string
  cols: string[]
  selected: Set<string>
  onToggle: (name: string) => void
}) {
  return (
    <div style={{ border: '1px solid #1f2a36', borderRadius: 8, padding: 8 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>

      {cols.length === 0 ? (
        <div className="legend" style={{ margin: 0 }}>
          None
        </div>
      ) : (
        <div style={{ maxHeight: 320, overflow: 'auto', paddingRight: 6 }}>
          {cols.map(name => (
            <label
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '3px 0',
                cursor: 'pointer',
                userSelect: 'none'
              }}
            >
              <input type="checkbox" checked={selected.has(name)} onChange={() => onToggle(name)} />
              <span>{name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
