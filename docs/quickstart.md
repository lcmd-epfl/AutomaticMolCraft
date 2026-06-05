# Quick Start

This page walks from a fresh launch to a generated molecule and a simple visualization in ~15 minutes. It assumes [Installation](installation.md) is complete.

---

## 1. Launch

```bash
conda activate molcraft
./dev.sh
```

Open `http://localhost:8000`. The app opens on the **Management** tab by default.


---

## 2. Generate a molecule

### 2a. Open the generation tab

Click **3D molecule generation** in the tab bar.

!!! warning "MolCraftDiff not installed"
    If a yellow banner appears, the `MolCraftDiff` CLI is missing. Install it following [Installation step 2](installation.md#2-install-molcraftdiffusion) and restart the backend.

### 2b. Select a model

The **Models** panel (left column) lists every checkpoint folder found under `MOLCRAFT_MODELS_DIR`. Models labelled **CFG** support property-targeted generation; models labelled **Unconditional** generate freely. Click one to select it.

If the list is empty, check that your checkpoint folders each contain `edm_chem.pkl` and that `MOLCRAFT_MODELS_DIR` points to the right location (shown as grey text under the model list).


### 2c. Configure parameters

Keep defaults for the first run:

- **Total molecules**: 1
- **Diffusion steps**: 50
- **Size mode**: random
- **CFG scale**: 1 (if the model is conditional)

### 2d. Run

Click **Generate** (top-right of the centre panel) or press **Shift+Enter**.

The **Results** panel (right column) shows:
- A status badge cycling `queued → running → completed`
- A live log tail updating every 2 seconds


### 2e. Inspect the result

When the status shows `completed`, the molecule name appears as a pill in the results list. Click the pill to load it.


In the viewer:

- **Rotate**: left-click drag
- **Zoom**: scroll wheel
- Download the structure: click **XYZ** or **SVG** below the viewer

To compare multiple molecules at once, change **Split** to 2–9 and click additional pills.

---

## 3. Load the result into Management

Click **Use as ref** (→ button) to send the molecule to the Structure-directed generation tab — *or* follow the steps below to load the whole job as a dataset for visualization.

1. Click the **Management** tab.
2. In **Add generated molecules**, click **Refresh** if your new job is not listed.
3. Select the **Model**, **Date**, and **Token / run** that match the completed generation job.
4. Keep **ID prefix** as `molGen`, or change it if you want a different row-id prefix.
5. Set **Data source label** to a short name such as `generated_1`.
6. Click **Register generated molecules**. The generated output is added as a staged source.
7. Click **Compile dataset**.

A progress bar appears while the dataset is built. On completion, the header card shows the molecule and column count.


!!! tip "Loading non-generated data"
    For existing data, use the source registration panel instead. Choose **CSV + XYZ folder** or **ASE database (.db)**, pick files or paste paths, then click **Register source** to stage and inspect columns or **Register and compile** for a one-step load.

---

## 4. Explore in Visualization

1. Click the **Visualization** tab.
2. In the action bar, click **2D Scatter**. A panel appears with the first two numeric columns on the axes.
3. Click the **X** or **Y** axis label to change the column binding.
4. Left-click drag to draw a lasso and select a subset of molecules.
5. The built-in **3D Structure Viewer** panel updates to show the selected molecule.


---

## Next steps

| What you want to do | Where to go |
|---|---|
| Tune generation parameters | [De-novo generation](generation/index.md) |
| Generate around a known scaffold | [Structure-guided generation](generation/structure-guided.md) |
| Compute xTB properties or UMAP layout | [Analysis tools](analysis-tools.md) |
| Build a dataset from multiple sources | [Data Manager](data-manager.md) |
| Full end-to-end example workflows | [Workflows](workflows/index.md) |
