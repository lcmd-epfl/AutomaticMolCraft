# Installation

## 1. Create the environment

```bash
conda create -n molcraft python=3.11 -y
conda activate molcraft
```

Install required system-level chemistry packages via conda-forge:

```bash
conda install -c conda-forge xtb==6.7.1 openbabel -y
```

`xtb` is a semi-empirical quantum chemistry package (used in [Analysis Tools](analysis-tools.md)). `openbabel` handles 2D structure rendering in the app.

## 2. Install MolCraftDiffusion

**Pinned to commit `b79e8aadc85f7047fbd9a70d1c41ea3aba0fc0a7` (version 1.12.0)** — an exact
pin, not a minimum. The app names Hydra config groups (`tasks`, `interference`) and
`analyze` CLI flags that shift across upstream commits (flags get renamed or moved to a
different subcommand, not just added); a package that's ahead of or behind the pin can
fail a job partway through with a `MissingConfigException` or `no such option` rather than
failing at startup. This pin is **not on PyPI** — `pypi.org/project/molcraftdiffusion`
lags the pin by several releases, so install from the exact commit via git instead:

```bash
MOLCRAFT_REF=b79e8aadc85f7047fbd9a70d1c41ea3aba0fc0a7
```

**GPU (CUDA 12.4, PyTorch 2.6):**

```bash
pip install "molcraftdiffusion[gpu] @ git+https://github.com/pregHosh/MolCraftDiffusion@${MOLCRAFT_REF}" \
    --find-links https://data.pyg.org/whl/torch-2.6.0+cu124.html
```

**CPU-only:**

```bash
pip install "molcraftdiffusion[cpu] @ git+https://github.com/pregHosh/MolCraftDiffusion@${MOLCRAFT_REF}" \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    --find-links https://data.pyg.org/whl/torch-2.6.0+cpu.html
```

After installing, `curl localhost:8000/healthz` reports `molcraft_version`,
`molcraft_commit`, and `molcraft_version_ok`/`molcraft_commit_ok` against this pin. The
pin lives in `webapp/database-explorer-lite/backend/main.py`
(`MOLCRAFT_PINNED_VERSION` / `MOLCRAFT_PINNED_COMMIT`) — this doc must match those
constants; bump both together and re-verify `TASK_FAMILIES` /
`TASK_TYPE_TO_TASKS_CONFIG` / the `analyze` CLI flags before moving the pin forward.

## 3. Install the web app backend

```bash
pip install -r webapp/database-explorer-lite/backend/requirements.txt
```

## 4. Download pretrained models

Models are hosted on Hugging Face at [pregH/MolecularDiffusion](https://huggingface.co/pregH/MolecularDiffusion). Place the downloaded checkpoint folders under `models/` at the repository root (or set `MOLCRAFT_MODELS_DIR` to a custom path — see step 5).

Each checkpoint folder must contain `edm_chem.pkl`. The optional `edm_stat.pkl` enables conditional generation statistics.

## 5. Configure environment variables (optional)

```bash
cp webapp/database-explorer-lite/.env.example webapp/database-explorer-lite/.env
```

All variables are optional; the defaults assume you run from the repository root.

| Variable | Default | Purpose |
|---|---|---|
| `MOLCRAFT_MODELS_DIR` | `<repo>/models` | Where the app looks for model checkpoints |
| `MOLCRAFT_OUTPUTS_DIR` | `<repo>/outputs` | Where generation job outputs are written |
| `MOLCRAFT_ANALYSIS_WORK_DIR` | `<repo>/analysis_jobs` | Storage for async analysis jobs |
| `MOLCRAFT_PRESETS_DIR` | `<repo>/presets` | Persistent parameter presets |
| `MOLCRAFT_CMD` | `MolCraftDiff` | CLI command name for the diffusion runner |
| `MOLCRAFT_UNLOCK_PASSWORD` | *(unset)* | Password for unlocking extended task families in the Model training tab (public families are always available) |

## 6. Build the frontend

Run once (or whenever frontend source files change):

```bash
cd webapp/database-explorer-lite/frontend
npm install
npm run build
```

`dev.sh` auto-runs this step if `frontend/dist` is absent or stale.

## 7. Launch

```bash
./dev.sh
```

Then open `http://localhost:8000` in your browser.

### Launch options

| Command | Effect |
|---|---|
| `./dev.sh` | Backend on `:8000`, serves the pre-built frontend |
| `FRONTEND_DEV=1 ./dev.sh` | Also starts Vite hot-reload server on `:5173` |
| `BACKEND_RELOAD=1 ./dev.sh` | Auto-restarts backend on Python file changes |
| `BACKEND_HOST=0.0.0.0 ./dev.sh` | Expose backend to the local network |
| `BACKEND_PORT=9000 ./dev.sh` | Run the backend on a different port (default `8000`) |
| `BACKEND_PYTHON=/path/to/python ./dev.sh` | Use a specific Python interpreter for the backend |

`dev.sh` auto-detects the Python interpreter from `$VIRTUAL_ENV`, `$CONDA_PREFIX`, or common `.venv`/`venv` paths.
