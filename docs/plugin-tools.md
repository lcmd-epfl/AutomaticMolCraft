# Plug-in Tools

The **Plug-in tools** tab exposes custom external property predictors — docking workflows, QSAR models, FEP surrogates, or any scoring function that can be wrapped in a Python function.


## Using a plug-in

1. Open the **Plug-in tools** tab.
2. Select a tool from the list. Its input fields are rendered automatically from the manifest.
3. Fill in the required parameters and click **Run tool**.
4. Results are applied to the dataset: `add_columns` tools add new visible columns; `add_descriptor` tools store a hidden per-molecule vector and add a visible `true`/`false` presence column with the descriptor's name.

## Adding a plug-in

Drop a directory under `webapp/database-explorer-lite/backend/tools/<tool_id>/` containing two files:

```
<tool_id>/
  manifest.json       ← declares the tool's inputs and output format
  runner.py            ← defines run_tool(dataset, params), called in-process
  requirements.txt    ← optional, Python deps (not auto-installed — see below)
```

The backend re-scans `backend/tools/` on every request to `/tools` and `/tools/{tool_id}/run`, so no backend restart is needed for it to execute a new tool. The tab's tool list, however, is normally built into the frontend bundle at build time (Vite glob-imports `backend/tools/*/manifest.json`); it only falls back to the live `/tools` endpoint when that bundled list is empty. In practice, rebuild the frontend (`npm run build`, or reload under `FRONTEND_DEV=1 ./dev.sh`) after adding a tool so it appears in the tab.

If `requirements.txt` is present, install its packages manually into the backend's Python environment — the app does not install them automatically.

### `manifest.json` structure

```json
{
  "manifestVersion": 1,
  "id": "my_tool",
  "name": "My scoring function",
  "description": "One-line description shown in the UI.",
  "needsXyz": true,
  "inputs": [
    {
      "key": "threshold",
      "label": "Score threshold",
      "type": "float",
      "default": 0.5,
      "required": true
    }
  ],
  "output": {
    "kind": "add_columns"
  }
}
```

**`output.kind`** is descriptive metadata shown alongside the tool; the backend actually decides how to apply results based on which keys (`addColumns` and/or `addDescriptor`) the runner's return value contains, not on this field. Set it to document intent:

| Value | Effect |
|---|---|
| `add_columns` | Runner is expected to return `addColumns` — new visible dataset columns |
| `add_descriptor` | Runner is expected to return `addDescriptor` — a hidden per-molecule vector plus an auto-added presence column |

**`needsXyz`**: if `true`, the frontend loads each molecule's XYZ text and sends it to the backend as `dataset.xyzById` (a dict of `mol_id → xyz text`). If omitted or `false`, `xyzById` is sent empty.

See `webapp/database-explorer-lite/backend/tools/external_tool_manifest_reference.md` in the repository for the full list of supported input types (`string`, `text`, `integer`, `float`, `boolean`, `select`, `multiselect`, `slider_int`, `slider_float`, `column`, `column_multi`, `column_numeric`, `column_categorical`, `column_multi_numeric`, `column_multi_categorical`) and field properties (`options`, `min`/`max`/`step`, `help`).

### `runner.py` contract

The backend imports `runner.py` as a Python module in-process (no subprocess, no CLI flags) and calls a required function:

```python
def run_tool(dataset, params):
    ...
```

`dataset` is a dict with keys `ids`, `columns`, `meta`, `xyzById` (only populated when `needsXyz: true`), and `descriptors` (previously stored hidden descriptor vectors, keyed by descriptor name). `params` holds the user-filled values keyed by each input's `key`, coerced to the declared type.

It must return a dict containing at least one of `message`, `warnings`, `addColumns`, `addDescriptor`, or `stats`. Minimal example that adds a new numeric column:

```python
def run_tool(dataset, params):
    ids = dataset.get("ids", [])
    threshold = params.get("threshold", 0.5)

    # ... compute one score per id ...
    scores = [0.0 for _ in ids]

    return {
        "message": f"Scored {len(ids)} molecules.",
        "addColumns": [
            {"name": "score", "kind": "numeric", "values": scores}
        ],
    }
```

Rules enforced by the backend:

- `addColumns[i].values` must have exactly one entry per dataset row (`kind: "numeric"` → int/float/`None`; `kind: "categorical"` → string/`None`), and the column name must not already exist.
- `addDescriptor.valuesById` maps a subset of dataset ids to equal-length numeric vectors; the descriptor name must not collide with an existing column or descriptor.
- Raising a Python exception (or an unhandled `ModuleNotFoundError` for a missing dependency) fails the run with an error message shown in the UI; nothing partial is applied.

See `webapp/database-explorer-lite/backend/tools/external_tool_manifest_reference.md` for the full manifest and result schema, and `webapp/database-explorer-lite/backend/tools/{row_index,basic_geom_descriptor,PCA}/` for complete working examples of both output modes.
