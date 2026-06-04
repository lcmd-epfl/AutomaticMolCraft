# Structure-guided Generation

Structure-guided generation completes or extends an existing 3D structure. You provide a **scaffold** — a partial or complete molecule in XYZ format — and select which atoms are frozen. The model places new atoms around or within those fixed positions.

Two modes define what "guiding with a scaffold" means:

- **Inpaint**: frozen atoms are interior anchors; the model fills in atoms *within* the structure (e.g. completing missing side chains or bridging two fragments).
- **Outpaint**: frozen atoms are attachment points; the model grows *new atoms around* them (e.g. adding a substituent or extending a ring).

The tab layout is identical to [De-novo generation](index.md) — three resizable columns: Models, Generation, Results. All model selection, result inspection, download, and preset functionality work the same way.

---

## Workflow

### 1. Select a model

Same as in [de-novo generation](index.md#1-select-a-model). Check the model badge:

- **CFG** models use `sample_hybrid` sampling — property targets are available alongside structural guidance.
- **Unconditional** models use `sample` guidance — structural constraints are enforced through a geometric penalty; the Adjustment Panel exposes additional low-level controls for this mode.

### 2. Load a scaffold

Three ways to provide the reference XYZ:

**File upload** — in the **Input Structure** section, click the file picker and select a `.xyz` file.

**Path input** — type or paste an absolute path into the text box and press **Enter** or click the arrow button.

**Checkpoint scaffold** — if the selected model was trained with a reference scaffold, the **Load checkpoint scaffold** button appears next to the section title. Clicking it:
1. Fetches the scaffold XYZ embedded in the checkpoint.
2. Switches mode to **Outpaint** automatically.
3. Pre-selects the atoms that were frozen during training.

Once a scaffold loads, its 3D structure appears in an interactive viewer and the atom count fields are auto-populated (Fixed atom count = scaffold atoms + 1; Min = scaffold atoms).

<!-- screenshot: structure-guided tab — scaffold loaded, 3D viewer showing molecule with atom count and name below it -->
![Scaffold loaded](../assets/screenshots/sg_scaffold_loaded.png)

### 3. Choose inpaint or outpaint

Use the **inpaint / outpaint** segmented button (visible after a scaffold loads).

| Mode | Scaffold role | Use when |
|---|---|---|
| Inpaint | Frozen atoms define the surrounding context | You want to fill a hole or replace a fragment inside a known structure |
| Outpaint | Frozen atoms are the core; new atoms grow outward | You want to decorate or extend a known fragment |

### 4. Select frozen atoms

Click atoms in the 3D viewer to toggle them between frozen (highlighted) and free. Right-click anywhere in the viewer to clear all selections.

Selected atom indices appear as removable chips below the viewer — click a chip's ✕ to deselect that atom.

Outpaint mode requires at least one selected atom; inpaint mode works with any number (including zero, which is equivalent to de-novo generation with a positional prior).

<!-- screenshot: structure-guided tab — viewer with 4 atoms highlighted and their index chips below -->
![Atom selection in viewer](../assets/screenshots/sg_atom_selection.png)

### 5. Set connector bonds *(outpaint only)*

For each selected atom, set the **bond order** to the newly generated atoms using the number field labelled `Connector <index>`. This controls the order of the bond(s) formed between the scaffold and the new fragment:

- `1` = single bond (default — safe for any attachment point)
- `2` = double bond (use for carbonyl or vinyl attachments)
- `3` = triple bond (use sparingly)

Higher bond orders constrain the geometry more tightly.

### 6. Configure parameters and run

See the [parameter reference](#parameter-reference) below. Click **Generate** or press **Shift+Enter**.

---

## Parameter reference

### Basic parameters

Identical to [de-novo generation](index.md#basic-parameters): Total molecules, Batch size, Frames, Diffusion steps, Seed.

### Molecular size

| Mode | Fields |
|---|---|
| **fixed** | Fixed atom count (1–512) — total atoms including frozen scaffold atoms |
| **range** | Min (1–512) + Max (1–512) |

Setting Fixed atom count to scaffold size + N tells the model to add approximately N new atoms around the scaffold.

### Inpaint-specific

| Parameter | Default | Range | Chemical meaning |
|---|---|---|---|
| **Denoising strength** | 0.5 | 0–1, step 0.05 | How much of the original scaffold geometry is preserved. At 0 the output is almost identical to the reference; at 1 the reference is fully noised and re-denoised from scratch — the model has the most freedom but the output may diverge significantly from the scaffold |

### Conditional targets *(CFG / sample_hybrid models only)*

Identical to [de-novo generation](index.md#conditional-targets-cfg-models-only): CFG scale, per-property Target, and optional Negative target.

---

## Advanced: Adjustment Panel

Click **Show Adjustment Panel** in the **Structure Settings** section to reveal low-level controls. These are hidden by default because incorrect values can produce geometrically invalid outputs. Only adjust these if you understand the model's geometry constraints.

### Sample guidance mode *(unconditional models only)*

These parameters control how the geometric penalty is applied during diffusion:

| Parameter | Default | Range | What it does |
|---|---|---|---|
| Constraint strength | 0.8 | 0–1, step 0.05 | How strongly frozen atoms are anchored. Lower values give the model more flexibility to shift the scaffold slightly; higher values keep it rigid |
| Scale factor | 1.0 | 0–20, step 0.1 | Positional scale applied to the scaffold coordinates before injection. Leave at 1 unless the model was trained with a different coordinate scale |
| BQ atoms | 8 | 0–512 | Number of virtual "blank-query" atoms added around the scaffold to provide spatial context to the model |
| Retries | 5 | 0–100 | How many times to restart diffusion if generated atoms violate hard geometry constraints |
| Retry t | 10 | 0–1 000 | The denoising step at which a retry restarts (lower = restart closer to the final structure) |
| Initial mask noise | true | boolean | Whether to add noise to the masked (free) region at initialisation. Setting to false can improve convergence stability |

### Outpaint initialisation

These parameters control where new atoms are placed at the start of diffusion:

| Parameter | Default | Range | What it does |
|---|---|---|---|
| Seed dist | 1.5 Å | 0–20, step 0.1 | Mean distance from scaffold atoms at which new atoms are initialised |
| Min dist | 1.0 Å | 0–20, step 0.1 | Minimum allowed distance between newly placed atoms at initialisation |
| Spread | 1.0 | 0–20, step 0.1 | Standard deviation of the initial atom cloud — higher spread = more varied starting positions |
| t_start | 0.8 | 0–1, step 0.05 | Which denoising step to begin from. 1.0 = start from full noise; lower values start from a partially denoised state, preserving more of the initial geometry |

---

## Configuration presets

Presets save the full parameter state including the scaffold XYZ content and atom selection. See [Presets](presets.md).
