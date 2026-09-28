# FAQ

## "MolCraftDiff is not installed" banner appears

The `MolCraftDiff` CLI could not be found in the current Python environment. Run `automolcraft doctor` — it shows which Python the app uses and whether MolCraftDiffusion is installed there. Install it following [Installation](installation.md), then restart the backend.

`automolcraft serve` always uses the environment it is installed in. With `./dev.sh`, if you installed into a different environment than the one `dev.sh` picks, set the interpreter explicitly:

```bash
BACKEND_PYTHON=/path/to/your/python ./dev.sh
```

---

## No models appear in the generation tab

The app could not find any checkpoint folders in `MOLCRAFT_MODELS_DIR`. Each checkpoint folder must contain `edm_chem.pkl`.

Check the current models directory shown under the model list. If it is wrong, set `MOLCRAFT_MODELS_DIR` in your `.env` file and restart.

---

## xTB calculations fail immediately

`xtb` is not on the PATH used by the backend (`automolcraft doctor` shows it under *Analysis tools*). Install it via conda-forge in the same environment:

```bash
conda install -c conda-forge --override-channels xtb==6.7.1 xtb-python
```

`xtb-python` is needed by **XTB electronic properties**; the `xtb` binary alone covers geometry optimisation.

Then restart the backend.

---

## Port conflict on startup

If port 8000 is already in use:

```bash
automolcraft serve --port 9000
# or, with the manual install:
BACKEND_PORT=9000 ./dev.sh
```

Then open `http://localhost:9000`.

---

## The frontend shows a blank page or "cannot connect"

The pre-built frontend in `frontend/dist` may be missing or stale (for example after `git pull`). Rebuild it and start again:

```bash
automolcraft serve --rebuild
```

With the manual install, run `npm install && npm run build` in `webapp/database-explorer-lite/frontend`, then restart `./dev.sh`. To run Vite directly at `:5173` instead, use `automolcraft serve --dev` (or `FRONTEND_DEV=1 ./dev.sh`).

---

## An analysis job completes but "Apply results" produces no new columns

The runner may have returned an empty result (e.g. all molecules timed out). Check the job log by clicking the terminal icon next to the job in the queue. Common causes:

- Timeout too short for the dataset size — increase **Timeout per molecule**.
- Molecule converter failed to assign bonds — switch **Molecule converter** from `xyz2mol` to `rdkit` (or vice versa).
- xTB method incompatible with element types in the dataset — try a different **XTB method**.

---

## Dataset is loaded but Visualization shows no plots

Panels must be added manually. In the Visualization action bar, click **2D Scatter**, **3D Scatter**, or **Histogram** to add a plot panel, then click its axis labels to change the column bindings.

---

## `ValueError: numpy.dtype size changed` after installing analysis packages

pandas was downgraded to a build made for numpy 1. The usual cause is `pip install 'molcraftdiffusion[analyze]'`, which pulls in `posecheck` and its `pandas==2.0.0` pin. Reinstall a numpy-2 pandas:

```bash
pip install 'pandas>=2.3,<2.4'
```

pip will then warn that `posecheck` wants pandas 2.0.0; that only affects protein-pocket checks. The environment files avoid this by not installing `posecheck`.

---

## Where do xTB's scratch files go?

xTB writes files such as `xtbopt.log`, `charges`, `wbo` and `xtbrestart` into its working directory. Analysis and generation jobs run inside their own job folder (under `MOLCRAFT_ANALYSIS_WORK_DIR` or `MOLCRAFT_OUTPUTS_DIR`), so those files stay with the job. If you find them in the repository root, they come from an older version of the app and can be deleted.

---

## On macOS, the health check says the MolCraftDiffusion commit does not match

Expected. `environment-macos.yml` installs MolCraftDiffusion 1.12.0 at the commit that added macOS support, which is newer than the Linux pin. The version still matches. See [macOS (Apple Silicon)](installation.md#macos-apple-silicon).
