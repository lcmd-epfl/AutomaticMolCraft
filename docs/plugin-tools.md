# Plug-in Tools

The **Plug-in tools** tab exposes custom external property predictors — docking workflows, QSAR models, FEP surrogates, or any scoring function that can be wrapped in a Python script.

<!-- screenshot: plugin tools tab — list of discovered plug-ins with one selected and its inputs rendered -->
![Plug-in tools tab](assets/screenshots/plugins_overview.png)

## Using a plug-in

1. Open the **Plug-in tools** tab.
2. Select a tool from the list. Its input fields are rendered automatically from the manifest.
3. Fill in the required parameters and click **Run**.
4. Results are applied to the dataset as new columns.

## Adding a plug-in

Drop a directory under `webapp/database-explorer-lite/backend/tools/<tool_id>/` containing two files:

```
<tool_id>/
  manifest.json    ← declares the tool's inputs and output format
  runner.py        ← receives CLI arguments, writes JSON to stdout
```

The backend discovers plug-ins at startup; restart the server after adding one.

### `manifest.json` structure

```json
{
  "id": "my_tool",
  "name": "My scoring function",
  "description": "One-line description shown in the UI.",
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
  },
  "needsXyz": true
}
```

**`output.kind`** controls how results are applied:

| Value | Effect |
|---|---|
| `add_columns` | Runner output is merged as new dataset columns |
| `replace_xyz` | Runner output replaces existing XYZ geometries |

**`needsXyz`**: if `true`, the XYZ paths are passed to the runner. Set to `false` if the tool only needs the scalar property CSV.

### `runner.py` contract

The runner receives the dataset (as a CSV path) and all manifest inputs as CLI flags. It must write a JSON object to stdout. Minimal example:

```python
import sys, json, argparse

parser = argparse.ArgumentParser()
parser.add_argument('--csv')
parser.add_argument('--threshold', type=float)
args = parser.parse_args()

# ... compute scores ...
print(json.dumps({"addColumns": [{"name": "score", "values": [...]}]}))
```

See `backend/tools/external_tool_manifest_reference.md` in the repository for the full manifest schema and all supported input types.
