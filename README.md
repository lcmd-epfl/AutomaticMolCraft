# AutomaticMolCraft

<p align="center">
  <img src="assets/logo_full.jpg" width="420" alt="AutomaticMolCraft Logo" />
</p>

<p align="center">
  <b>A web interface for 3D molecular generation, visualization, and analysis built on top of MolCraftDiffusion.</b>
</p>

<p align="center">
  <a href="https://chemrxiv.org/engage/chemrxiv/article-details/6909e50fef936fb4a23df237">
    <img src="https://img.shields.io/badge/PDF-ChemRxiv-blue" alt="ChemRxiv">
  </a>
  <a href="https://zenodo.org/records/18121166">
    <img src="https://zenodo.org/badge/DOI/10.5281/zenodo.18121166.svg" alt="DOI">
  </a>
  <a href="https://huggingface.co/pregH/MolecularDiffusion">
    <img src="https://img.shields.io/badge/Weights-HuggingFace-yellow" alt="Hugging Face Weights">
  </a>
  <a href="https://preghosh.github.io/AutomaticMolCraftt/">
    <img src="https://img.shields.io/badge/Tutorials-Docs-blue" alt="Documentation">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License">
  </a>
</p>

## Overview

**AutomaticMolCraft** is a browser-based platform that covers the full 3D molecular generative design pipeline — from running pretrained diffusion models and inspecting outputs, through dataset curation and property enrichment, to interactive chemical space visualization. All steps are integrated in a single web interface with no scripting required.

### Generative design

The core workflow is built around [MolCraftDiffusion](https://github.com/pregHosh/MolCraftDiffusion), a unified DDPM/DDIM diffusion framework for 3D molecular generation.

- **De-novo generation**: run pretrained models directly from the browser with configurable sampling parameters and optional classifier-free guidance (CFG) toward per-property targets, each with an optional negative contrastive target.
- **Structure-guided generation (inpaint / outpaint)**: provide a reference `.xyz` scaffold and select atoms as the inpaint mask or outpaint connectors; the model modifies or extends the structure. Denoising strength, constraint strength, and connector bond order are all tunable. The checkpoint's own reference scaffold can be extracted and used directly.
- **Trajectory inspection**: each generated molecule carries a full denoising trajectory that can be played back step-by-step in the 3D viewer.
- **Multi-molecule comparison**: view up to nine generated structures side-by-side in a configurable split viewer.
- **Job management**: generation runs asynchronously with live log streaming; past job outputs can be reloaded into the viewer or fed into the data pipeline without re-running the model.
- **Configuration presets**: save and restore named parameter sets per generation page; presets are persisted on disk and survive server restarts.

### Data curation

A multi-source staging and compilation pipeline lets you assemble, clean, and enrich datasets before analysis.

- **Input formats**: CSV + XYZ folder pairs, ASE SQLite `.db` files (geometries and `key_value_pairs` extracted automatically), and outputs from any past generation job.
- **Staging**: register any number of sources independently; rename or filter columns per source before merging.
- **Compilation**: merge all staged sources into one dataset with configurable duplicate-ID (`rename` / `skip` / `block`) and column-conflict (`merge` / `suffix` / `block`) policies.
- **Property enrichment via analysis jobs** (asynchronous background execution):
  - Structural validity and connectivity checks (core / PoseBuster / geom_revised).
  - XYZ → SMILES conversion with Morgan fingerprints and Bemis–Murcko scaffold columns.
  - XTB single-point calculations (GFN1/GFN2/PTB): energy, dipole, reactivity descriptors, partial charges, Fukui indices, bond orders.
  - XTB/MMFF94 geometry optimization; optimized geometries can replace originals in-place or be registered as a new source.
  - Molecular featurization via SOAP or UMA descriptors.
  - Dimensionality reduction to 2D coordinates using UMAP or t-SNE (GPU-accelerated t-SNE supported via tsne-cuda).
  - Property prediction from a trained MolCraftDiffusion checkpoint.
- **Export**: compiled dataset downloadable as a CSV + XYZ ZIP or as an ASE `.db` file; both formats respect the current filter scope (full dataset or filtered subset, up to 5,000 rows for ZIP).

### Visualization

An interactive multi-panel workspace for exploring chemical space.

- **Linked panels**: 2D scatter plots, 3D scatter plots, and histograms share a common selection state — brushing or clicking in any panel highlights the same molecules across all others and in the 3D structure viewer.
- **GPU-accelerated rendering**: deck.gl powers both scatter plots and the interactive 3D viewer, keeping large datasets responsive.
- **Configurable layout**: panels are freely draggable and resizable; color, size, marker shape, and axis bindings are all adjustable per panel.
- **Tabular view**: a sortable, filterable data table runs alongside the plots and reflects the same selection state.

### Extensibility

A plug-in interface lets external property predictors (docking, QSAR, FEP surrogates, custom scoring functions) be wired in by dropping a `manifest.json` and `runner.py` into the tools directory — no backend code changes required.

---

## Features

### 3D Molecule Generation

Run pretrained 3D diffusion models directly from the browser.

- DDPM and DDIM sampling with configurable steps and seed.
- Fixed or range-based atom count control.
- **Conditional generation**: set per-property targets with classifier-free guidance (CFG scale). Each property supports an optional negative target for contrastive guidance.
- Asynchronous job execution with live log streaming.
- Denoising trajectory playback per generated molecule.
- Side-by-side multi-molecule viewer for comparing results.
- Export generated structures as `.xyz` files or download the full job as a ZIP.
- Reload any past generation job directly into the Visualizer without re-running.
- **Configuration presets**: save and restore named parameter sets for any generation configuration; presets are persisted on disk and survive server restarts.

---

### Structure-Guided Generation

Complete or modify existing structures using a reference input.

- Paste or upload a reference `.xyz` file as the structural scaffold.
- Atom selection: choose the inpaint mask or the outpaint connector atoms directly in the reference viewer.
- Load the reference scaffold from a model checkpoint automatically.
- **Denoising strength** control: interpolate between preserving the reference and full de-novo generation.
- Conditional property targets and CFG guidance work alongside structural guidance.
- **Configuration presets**: save and load named parameter presets the same way as in the generation tab.

---

### Visualizer

Explore molecular datasets in a synchronized multi-panel workspace.

- 2D scatter plots, 3D scatter plots, and histograms — all linked by shared selection state.
- Interactive 3D molecular structure viewer; selected points in any plot automatically highlight in the viewer.
- Linked brushing and point selection across all panels.
- GPU-accelerated rendering via deck.gl for large datasets.

---

### Data Manager

Build and manage multi-source datasets before visualization.

#### Supported input formats

| Format | Details |
|---|---|
| **CSV + XYZ folder** | CSV (first column = molecule ID, remaining columns = properties) paired with a folder of `.xyz` files (filename = molecule ID). |
| **ASE SQLite database** | Upload an ASE `.db` file directly. The backend extracts each row's geometry as XYZ (cached in memory) and its scalar `key_value_pairs` as dataset columns. |
| **Generated job output** | Browse past generation jobs and load their molecule set as a staged source, without re-running the model. |

#### Staging and compilation

- **Multi-source staging**: register multiple CSV+XYZ pairs, ASE databases, or generated job outputs as independent staged sources.
- **Column renaming and filtering** per source before merging.
- **Compile**: merge all staged sources into one dataset with configurable:
  - duplicate-ID policy: `rename` / `skip` / `block`
  - column-conflict policy: `merge` / `suffix` / `block`

#### Export

Both export options support exporting either the full dataset or only the current filtered view.

- **CSV + XYZ zip**: paired CSV and `.xyz` files in a ZIP archive (up to 5,000 rows).
- **ASE `.db` export**: compiled dataset written as an ASE SQLite database; all scalar columns are stored as `key_value_pairs` and geometries are embedded.

---

### Analysis Tools

Run quantum-chemistry and cheminformatics analyses on the current dataset as asynchronous background jobs.

| Tool | Description |
|---|---|
| **Validity and connectivity metrics** | Structural validity/connectivity checks (core / PoseBuster / geom_revised metric sets) |
| **XYZ to SMILES conversion** | Convert XYZ geometries to SMILES; compute Morgan fingerprints and scaffold columns |
| **XTB electronic properties** | GFN1-xTB / GFN2-xTB / PTB single-point calculations: energy, dipole, reactivity, charges, Fukui indices, bond orders |
| **XTB geometry optimization** | Optimize geometries with GFN1-xTB / GFN2-xTB / GFN-FF / MMFF94; replace or register the optimized structures |
| **Featurize** | Generate fixed-size molecular vectors via SOAP or UMA for downstream ML |
| **Dimensionality reduction** | Project molecular vectors to 2D coordinates using UMAP or t-SNE |
| **Predict properties** | Run MolCraftDiff property prediction from a selected model checkpoint |

Each job runs asynchronously; results can be applied to the dataset (adding columns or replacing XYZ geometries) or registered as a new staged source.

---

### Plug-in Tools

An extensible interface for external molecular property predictors.

Example use cases:
- Docking workflows.
- QSAR models.
- FEP surrogate models.
- Custom scoring functions.

To add a new tool, place a directory under `webapp/database-explorer-lite/backend/tools/<tool_id>/` containing:

```text
manifest.json   — declares inputs, output kind, and whether XYZ paths are needed
runner.py       — reads CLI args, writes JSON result to stdout
```

See `backend/tools/external_tool_manifest_reference.md` for the plug-in manifest schema.

---

## Installation

### 1. Create the environment

```bash
conda create -n molcraft python=3.11 -y
conda activate molcraft
```

Install required chemistry dependencies:

```bash
conda install -c conda-forge xtb==6.7.1 openbabel -y
```

---

### 2. Install MolCraftDiffusion

For GPU usage with CUDA 12.4 and PyTorch 2.6:

```bash
pip install molcraftdiffusion[gpu] \
    --find-links https://data.pyg.org/whl/torch-2.6.0+cu124.html
```

For CPU-only usage:

```bash
pip install molcraftdiffusion[cpu] \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    --find-links https://data.pyg.org/whl/torch-2.6.0+cpu.html
```

For more details on training, generation, and analysis workflows, see the  
[MolCraftDiffusion README](https://github.com/pregHosh/MolCraftDiffusion).

---

### 3. Download pretrained models

Pretrained models are available on Hugging Face:

[https://huggingface.co/pregH/MolecularDiffusion](https://huggingface.co/pregH/MolecularDiffusion)

Place the downloaded model files under `models/` at the repository root, or point to a custom location with `MOLCRAFT_MODELS_DIR`.

---

### 4. Configure environment variables

```bash
cp webapp/database-explorer-lite/.env.example webapp/database-explorer-lite/.env
```

Optional variables (defaults shown):

```bash
MOLCRAFT_MODELS_DIR=<repo_root>/models
MOLCRAFT_OUTPUTS_DIR=<repo_root>/outputs
MOLCRAFT_ANALYSIS_WORK_DIR=<repo_root>/analysis_jobs
MOLCRAFT_PRESETS_DIR=<repo_root>/presets
```

---

### 5. Launch the application

`dev.sh` is the single entry point for both development and local deployment.

```bash
./dev.sh                          # production-like: backend on :8000, serves frontend/dist
FRONTEND_DEV=1 ./dev.sh           # also starts the Vite hot-reload server on :5173
BACKEND_RELOAD=1 ./dev.sh         # enables uvicorn --reload (auto-restarts on Python changes)
BACKEND_PYTHON=/path/to/python ./dev.sh   # use a specific Python interpreter
```

**Python interpreter auto-detection** (applied when `BACKEND_PYTHON` is not set):
`dev.sh` searches for an active virtual environment in this order — `$VIRTUAL_ENV`, `$CONDA_PREFIX`, `<app>/.venv`, `<app>/venv`, `<repo>/.venv`, `<repo>/venv`, `<parent>/.venv`, `<parent>/venv` — and falls back to the system `python` / `python3`.

**Frontend build auto-detection**: if `frontend/dist` is absent or its referenced assets are stale, `dev.sh` automatically runs `npm install && npm run build` before starting the backend.

**Port and host overrides**:
```bash
BACKEND_HOST=0.0.0.0 BACKEND_PORT=9000 ./dev.sh
FRONTEND_HOST=0.0.0.0 FRONTEND_PORT=5174 FRONTEND_DEV=1 ./dev.sh
```

Then open `http://localhost:8000` (or the configured host/port).

---

## Using the WebUI

The WebUI is organized into seven tabs:

| Tab | Purpose |
|---|---|
| **Visualization** | Explore the active compiled dataset with linked plots, filters, a data table, and the 3D viewer. |
| **Management** | Register, organize, compile, filter, and export datasets. |
| **3D molecule generation** | Run de-novo or property-guided generation. |
| **Structure-directed generation** | Run inpaint or outpaint generation from a reference structure. |
| **Analysis tools** | Queue analysis jobs or build multi-step analysis workflows. |
| **Model training** | Configure, queue, monitor, and export MolCraftDiff training jobs. |
| **Plug-in tools** | Run locally installed external tools. |

### De-novo 3D molecule generation

1. Open **3D molecule generation** and select a model from the left panel. Model metadata and training-distribution plots are shown beneath the model selector when available.
2. In **Basic Parameters**, set:
   - **Total molecules**: total number of structures to produce.
   - **Batch size**: structures sampled per diffusion pass. Total molecules must be greater than batch size.
   - **Frames**: number of saved trajectory frames. This must be lower than **Diffusion steps**.
   - **Diffusion steps**, **Seed**, and **Max size**.
3. In **Molecular Size**, choose:
   - **random** to use the model's learned size distribution;
   - **fixed** to provide one atom count; or
   - **range** to provide minimum and maximum atom counts.
4. For a conditional model, open **Conditional Targets**, set the **CFG scale**, and enter each property **Target**. Leave **Negative** as `-` to disable the negative target. For multi-property runs, either leave every negative target as `-` or provide all of them.
5. Click **Generate** or press `Shift+Enter`.
6. In **Results**, follow the job status and log, select up to nine molecules for split-view comparison, inspect their denoising trajectories, or download an individual **XYZ**, **SVG**, or the complete **XYZ zip**.
7. Click **Use as ref** on a selected result to send it directly to **Structure-directed generation**.

Named configurations can be saved and restored from the preset bar above the form.

### Structure-directed generation

Use this tab to modify a reference molecule with **inpaint** or extend it with **outpaint**.

1. Open **Structure-directed generation** and select a compatible model from the left panel.
2. Set **Basic Parameters** as for de-novo generation. The same total-molecule, batch-size, frame, and diffusion-step constraints apply.
3. In **Input Structure**:
   - choose **inpaint** to regenerate or perturb a reference structure;
   - choose **outpaint** to extend a reference from one or more selected connector atoms;
   - upload a **Reference XYZ**, paste a backend-accessible `.xyz` path, click **Load checkpoint scaffold** when available, or use **Use as ref** from a generated molecule;
   - click atoms in the reference viewer to select them; right-click the viewer to clear the selection.
4. In **Molecular Size**, choose **fixed** or **range** and set the requested output atom count. Inpaint output size must be at least the reference atom count; outpaint output size must be greater than the reference atom count.
5. For property-conditioned structure models, use **Conditional Targets** to set **CFG scale**, targets, and optional negative targets.
6. Configure **Structure Guidance Settings**:
   - For **inpaint**, **Denoising strength** is always visible. Lower values preserve more of the reference; higher values permit stronger regeneration.
   - Open **Adjustment Panel** for advanced controls such as **Constraint strength**, **Scale factor**, retry settings, and **Initial mask noise**.
   - For **outpaint**, select at least one connector atom, then use the Adjustment Panel to set **Seed dist**, **Min dist**, **Spread**, **t_start**, and the bond order for each selected connector.
7. Click **Generate** or press `Shift+Enter`, then inspect and download structures from **Results**.

### Build and manage a dataset

1. Open **Management**.
2. Under **Upload / Register source**, register a CSV + XYZ source or an ASE `.db`; alternatively, use the generated-molecule builder to register a previous generation job.
3. In **Dataset sources organizer**, include or exclude sources and columns, rename source labels or output columns, optionally subsample rows, and add simple computed numeric columns.
4. Choose the **Duplicate ID policy** and **Column conflict policy**, then click **Compile dataset**. Visualization and analysis continue using the last successfully compiled dataset until compilation completes.
5. Review and filter **Current compiled data**.
6. Under **Download dataset**, export the full dataset, filtered rows, or selected rows as ASE `.db`, CSV + XYZ ZIP, or CSV. CSV + XYZ ZIP export is limited to 5,000 rows.

Every compiled row carries a `data_source` value. Analysis tools operate on one selected source at a time unless **all compiled sources** is explicitly selected.

### Run analysis tools

1. Compile or register a dataset, then open **Analysis tools**.
2. Select an **Analysis tool** and **Analysis source**, then configure the displayed parameters.
3. Click **Add to queue** for a single job. Completed jobs must be explicitly applied with **Apply results** before their columns, descriptors, vectors, atom properties, or replacement XYZ geometries appear in the active dataset.
4. For a repeatable sequence, click **Add workflow step**, configure each step's source and post-action, then click **Run** in the Workflow panel.
5. For completed geometry-optimization jobs:
   - **Apply results** replaces matching XYZ geometries in place.
   - **Register optimized set** creates or replaces a managed source. An empty ID prefix with the original source label uses replacement mode; changing either uses append mode and requires collision-safe IDs and a new source label.

**Clear queue** only removes the frontend queue history; it does not cancel or delete backend jobs.

### Visualize and export results

After compiling a dataset, open **Visualization**. Add 2D scatter, 3D scatter, or histogram panels from the toolbar. Plot selections, the table, filters, and the molecular viewer share the same active selection. Panels can be moved and resized, and each plot exposes its own axis, color, size, and marker settings.

### Configure model training

Open **Model training** to create a training configuration from the form or import an existing YAML file. Select the task family, choose **Run (queued)** or **Dry (YAML only)**, then configure the Data, Model, diffusion or flow-matching, optimization, logging, and engine sections. Use **Generate YAML** to inspect and download a configuration without running it, or **Queue training job** to start it. The Job History panel provides status, logs, cancellation, cloning, and YAML download actions.

### Run plug-in tools

Open **Plug-in tools**, select a loaded tool manifest, choose the required dataset/source, fill in its declared inputs, and run it. Tool availability and form fields are defined by each local `backend/tools/<tool_id>/manifest.json`; any manifest-loading problems appear as **Tool warnings** near the top of the WebUI.

---

## Related Resources

- [MolCraftDiffusion GitHub Repository](https://github.com/pregHosh/MolCraftDiffusion)
- [MolCraftDiffusion Documentation](https://preghosh.github.io/MolCraftDiffusion/)
- [Pretrained Models on Hugging Face](https://huggingface.co/pregH/MolecularDiffusion)
- [ChemRxiv Preprint](https://chemrxiv.org/engage/chemrxiv/article-details/6909e50fef936fb4a23df237)
- [Zenodo Archive](https://zenodo.org/records/18121166)

---

## Citation

If you use **AutomaticMolCraft** or **MolCraftDiffusion** in your research, please cite:

> **MolecularDiffusion: A Unified Generative-AI Framework for 3D Molecular Design**  
> [ChemRxiv Preprint](https://chemrxiv.org/engage/chemrxiv/article-details/6909e50fef936fb4a23df237)

---

## License

This project is released under the MIT License.
