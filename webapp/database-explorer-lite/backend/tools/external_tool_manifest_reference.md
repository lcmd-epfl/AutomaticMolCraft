# External Tool Manifest and Result Format

This document explains the current manifest structure for external tools, and the input and output types that are implemented in the app right now.

## 1. Tool folder structure

Each tool lives in:

`backend/tools/<tool_id>/`

Typical contents:

- `manifest.json`
- `runner.py`
- optional `requirements.txt`

## 2. Purpose of each file

### `manifest.json`
Defines:
- tool identity
- description
- UI inputs
- some execution metadata

### `runner.py`
Must define:

```python
def run_tool(dataset, params):
    ...
```

It receives:
- `dataset`: serialized dataset payload
- `params`: values filled by the user from the manifest-defined inputs

It returns a structured result object.

### `requirements.txt` (optional)
Lists Python packages needed by the tool.

In the current implementation, these requirements are not auto-installed by the app. They must be installed manually into the backend Python environment.

---

## 3. Current manifest structure

A typical manifest looks like this:

```json
{
  "manifestVersion": 1,
  "id": "row_index",
  "name": "Row index",
  "description": "Adds a simple per-row index column.",
  "needsXyz": false,
  "inputs": [
    {
      "key": "target_name",
      "label": "New column name",
      "type": "string",
      "default": "row_index",
      "required": true
    },
    {
      "key": "start_at",
      "label": "Start index at",
      "type": "integer",
      "default": 0,
      "required": true
    }
  ],
  "output": {
    "kind": "add_columns"
  }
}
```

## 4. Implemented top-level manifest fields

### `manifestVersion`
- type: integer
- currently expected value: `1`

### `id`
- type: string
- unique identifier for the tool
- should match the folder/tool identity conceptually

### `name`
- type: string
- human-readable tool name
- used in the UI tab label

### `description`
- type: string
- shown in the tool page

### `needsXyz`
- type: boolean
- optional
- if `true`, the frontend sends loaded XYZ content to the backend tool
- if omitted, it behaves as `false`

### `inputs`
- type: array of input-field objects
- defines the form rendered in the UI

### `output`
- type: object
- currently used only as descriptive metadata
- common values used so far:
  - `{ "kind": "add_columns" }`
  - `{ "kind": "add_descriptor" }`

---

## 5. Implemented input field structure

Each entry in `inputs` is an object like:

```json
{
  "key": "descriptor_name",
  "label": "Descriptor name",
  "type": "string",
  "default": "basic_geom",
  "required": true,
  "help": "Optional help text"
}
```

### Implemented field properties

#### `key`
- type: string
- required
- unique parameter name passed to `params` in `runner.py`

#### `label`
- type: string
- optional
- UI label shown to the user

#### `type`
- type: string
- required
- must be one of the implemented input types listed below

#### `default`
- optional
- default value used to initialize the field

#### `required`
- type: boolean
- optional
- if `true`, the UI/backend validate that a value is provided

#### `options`
- optional
- used by select-like field types
- can contain strings or `{ "value": "...", "label": "..." }`

#### `min`
- optional number
- used for slider field types

#### `max`
- optional number
- used for slider field types

#### `step`
- optional number
- used for slider field types

#### `help`
- optional string
- shown as explanatory text below the field

---

## 6. Implemented input types

The following input types are currently implemented.

### Basic scalar inputs

#### `string`
Single-line text input.

Example:
```json
{ "key": "name", "type": "string" }
```

#### `text`
Multi-line text area.

Example:
```json
{ "key": "notes", "type": "text" }
```

#### `integer`
Integer numeric input.

Example:
```json
{ "key": "n_components", "type": "integer" }
```

#### `float`
Floating-point numeric input.

Example:
```json
{ "key": "alpha", "type": "float" }
```

#### `boolean`
Checkbox input.

Example:
```json
{ "key": "normalize", "type": "boolean" }
```

---

### Choice inputs

#### `select`
Single-choice selector based on `options`.

Example:
```json
{
  "key": "method",
  "type": "select",
  "options": ["pca", "tsne"]
}
```

#### `multiselect`
Multiple-choice selector based on `options`.

Example:
```json
{
  "key": "modes",
  "type": "multiselect",
  "options": ["a", "b", "c"]
}
```

---

### Slider inputs

#### `slider_int`
Integer slider.

Example:
```json
{
  "key": "bins",
  "type": "slider_int",
  "min": 5,
  "max": 100,
  "step": 1
}
```

#### `slider_float`
Floating-point slider.

Example:
```json
{
  "key": "threshold",
  "type": "slider_float",
  "min": 0.0,
  "max": 1.0,
  "step": 0.05
}
```

---

### Dataset-column selectors

#### `column`
Choose one column from all dataset columns.

#### `column_multi`
Choose multiple columns from all dataset columns.

#### `column_numeric`
Choose one numeric column.

#### `column_categorical`
Choose one categorical column.

#### `column_multi_numeric`
Choose multiple numeric columns.

#### `column_multi_categorical`
Choose multiple categorical columns.

These are driven by the current dataset metadata:
- `meta.numericColumns`
- `meta.categoricalColumns`

---

## 7. Data received by `runner.py`

The backend passes a serialized dataset object to the tool.

Current dataset payload may contain:

```python
{
    "ids": [...],
    "columns": {...},
    "meta": {...},
    "xyzById": {...},
    "descriptors": {...}
}
```

### `ids`
List of dataset entry identifiers.

### `columns`
Dictionary of table-visible columns:
```python
{
    "energy": [...],
    "basic_geom_pc1": [...],
    ...
}
```

### `meta`
Dataset metadata, including:
- `numericColumns`
- `categoricalColumns`

### `xyzById`
Optional dictionary of loaded XYZ text, keyed by dataset id.
Only included meaningfully when the tool manifest uses:
- `"needsXyz": true`

Example:
```python
{
    "mol_001": "5\ncomment\nC 0 0 0\n...",
    ...
}
```

### `descriptors`
Dictionary of hidden stored descriptors keyed by descriptor name.

Example:
```python
{
    "basic_geom": {
        "name": "basic_geom",
        "dim": 4,
        "dtype": "float32",
        "valuesById": {
            "mol_001": [5.0, 1.2, 0.5, 3.1]
        },
        "missingIds": [...],
        "source": {
            "kind": "tool",
            "label": "Basic geom descriptor"
        }
    }
}
```

---

## 8. Current implemented output structure from `runner.py`

The tool must return a dictionary.

Implemented top-level output keys are:

- `message`
- `warnings`
- `addColumns`
- `addDescriptor`
- `stats`

At least one meaningful output section must be present.

---

## 9. Implemented output fields

### `message`
- type: string
- optional
- success/info message shown to the user

Example:
```python
"message": "Generated descriptor 'basic_geom'."
```

### `warnings`
- type: list of strings
- optional
- warnings shown to the user without failing the tool

Example:
```python
"warnings": ["12 entries did not receive descriptor values."]
```

### `stats`
- type: dictionary
- optional
- summary information shown in the UI
- values should be JSON-serializable scalars

Example:
```python
"stats": {
    "dim": 4,
    "nPresent": 1200,
    "nMissing": 37
}
```

---

## 10. Implemented standard output mode: `addColumns`

Use `addColumns` when the tool creates normal visible dataset columns.

Example:
```python
{
    "message": "Added PCA columns.",
    "addColumns": [
        {
            "name": "basic_geom_pc1",
            "kind": "numeric",
            "values": [0.1, 0.2, None, 0.4]
        },
        {
            "name": "basic_geom_pc2",
            "kind": "numeric",
            "values": [1.1, 1.2, None, 1.4]
        }
    ]
}
```

### Structure of one `addColumns` entry

#### `name`
- type: string
- required
- visible dataset column name
- must not duplicate an existing column name
- must not duplicate another output column in the same run

#### `kind`
- type: string
- required
- currently implemented values:
  - `"numeric"`
  - `"categorical"`

#### `values`
- type: list
- required
- must have exactly one value per dataset row
- length must equal `len(dataset["ids"])`

### Allowed values by kind

#### If `kind == "numeric"`
Each value must be:
- int
- float
- or `None`

#### If `kind == "categorical"`
Each value must be:
- string
- or `None`

---

## 11. Implemented descriptor output mode: `addDescriptor`

Use `addDescriptor` when the tool creates a hidden per-entry descriptor vector.

Example:
```python
{
    "message": "Generated descriptor 'basic_geom'.",
    "warnings": ["5 entries failed during descriptor generation."],
    "addDescriptor": {
        "name": "basic_geom",
        "valuesById": {
            "mol_001": [5.0, 1.2, 0.5, 3.1],
            "mol_004": [7.0, 1.9, 0.7, 4.2]
        },
        "dtype": "float32",
        "source": {
            "kind": "tool",
            "label": "Basic geom descriptor"
        }
    },
    "stats": {
        "dim": 4,
        "nPresent": 2,
        "nMissing": 2
    }
}
```

### Implemented `addDescriptor` fields

#### `name`
- type: string
- required
- descriptor name
- must be unique
- must not collide with an existing visible column name
- later becomes the visible true/false presence column name in the dataset table

#### `valuesById`
- type: dictionary
- required
- keys are dataset ids
- values are numeric vectors

Example:
```python
"valuesById": {
    "mol_001": [0.1, 0.2, 0.3],
    "mol_002": [0.4, 0.5, 0.6]
}
```

Rules:
- each key must be a valid dataset id
- each value must be a non-empty list of numbers
- all vectors must have the same dimension

#### `dtype`
- type: string
- optional
- currently implemented/validated value:
  - `"float32"`

#### `source`
- type: dictionary
- optional
- metadata describing where the descriptor came from

Implemented `source.kind` values:
- `"tool"`
- `"file"`

Example:
```python
"source": {
    "kind": "tool",
    "label": "Basic geom descriptor"
}
```

### What happens in the frontend when `addDescriptor` is returned

The app currently:
1. stores the descriptor hidden in `dataset.descriptors`
2. automatically adds a visible categorical column with the same name
3. fills that visible column with:
   - `"true"` if the entry has a descriptor vector
   - `"false"` otherwise

So the descriptor itself is hidden, while the table only shows presence/absence.

---

## 12. Duplicate name behavior

Current implemented rules:

### For visible columns
A tool cannot create a column with a name that already exists.

### For descriptors
A tool cannot create a descriptor if:
- a descriptor with that name already exists
- or a visible column with that name already exists

So descriptor names must be unique.

---

## 13. Current limitations

The following are not part of the implemented manifest/output system right now:

- automatic package installation from `requirements.txt`
- isolated Python environments per tool
- file outputs from tools
- row addition/removal from tools
- descriptor selector field type in the manifest UI
- direct export format declaration in the manifest
- nested custom UI components beyond the implemented basic input set

---

## 14. Minimal example: add a normal column

### `manifest.json`
```json
{
  "manifestVersion": 1,
  "id": "row_index",
  "name": "Row index",
  "description": "Adds a simple per-row index column.",
  "inputs": [
    {
      "key": "target_name",
      "label": "New column name",
      "type": "string",
      "default": "row_index",
      "required": true
    }
  ],
  "output": {
    "kind": "add_columns"
  }
}
```

### `runner.py`
```python
def run_tool(dataset, params):
    ids = dataset.get("ids", [])
    name = params.get("target_name") or "row_index"
    values = list(range(len(ids)))

    return {
        "message": f"Added column '{name}'.",
        "addColumns": [
            {
                "name": name,
                "kind": "numeric",
                "values": values
            }
        ],
        "stats": {
            "rowsProcessed": len(ids)
        }
    }
```

---

## 15. Minimal example: add a descriptor

### `manifest.json`
```json
{
  "manifestVersion": 1,
  "id": "fake_descriptor",
  "name": "Fake descriptor",
  "description": "Creates a simple example descriptor.",
  "inputs": [
    {
      "key": "descriptor_name",
      "label": "Descriptor name",
      "type": "string",
      "default": "fake_desc",
      "required": true
    }
  ],
  "output": {
    "kind": "add_descriptor"
  }
}
```

### `runner.py`
```python
def run_tool(dataset, params):
    ids = dataset.get("ids", [])
    name = params.get("descriptor_name") or "fake_desc"

    values_by_id = {
        entry_id: [float(i), float(i + 1)]
        for i, entry_id in enumerate(ids[:5])
    }

    return {
        "message": f"Generated descriptor '{name}'.",
        "warnings": [f"{max(0, len(ids) - len(values_by_id))} entries are missing values."],
        "addDescriptor": {
            "name": name,
            "valuesById": values_by_id,
            "dtype": "float32",
            "source": {
                "kind": "tool",
                "label": "Fake descriptor"
            }
        },
        "stats": {
            "dim": 2,
            "nPresent": len(values_by_id),
            "nMissing": len(ids) - len(values_by_id)
        }
    }
```
