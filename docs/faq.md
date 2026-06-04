# FAQ

## "MolCraftDiff is not installed" banner appears

The `MolCraftDiff` CLI could not be found in the current Python environment. Install it following [Installation step 2](installation.md#2-install-molcraftdiffusion), then restart the backend (`./dev.sh`).

If you installed into a different environment than the one `dev.sh` is using, set the correct interpreter explicitly:

```bash
BACKEND_PYTHON=/path/to/your/python ./dev.sh
```

---

## No models appear in the generation tab

The app could not find any checkpoint folders in `MOLCRAFT_MODELS_DIR`. Each checkpoint folder must contain `edm_chem.pkl`.

Check the current models directory shown under the model list. If it is wrong, set `MOLCRAFT_MODELS_DIR` in your `.env` file and restart.

---

## xTB calculations fail immediately

`xtb` is not on the PATH used by the backend. Install it via conda-forge in the same environment:

```bash
conda install -c conda-forge xtb==6.7.1
```

Then restart the backend.

---

## Port conflict on startup

If port 8000 is already in use:

```bash
BACKEND_PORT=9000 ./dev.sh
```

Then open `http://localhost:9000`.

---

## The frontend shows a blank page or "cannot connect"

The pre-built frontend in `frontend/dist` may be missing or stale. Rebuild it:

```bash
cd webapp/database-explorer-lite/frontend
npm install && npm run build
```

Then restart `./dev.sh`. Alternatively, use `FRONTEND_DEV=1 ./dev.sh` to run Vite directly at `:5173`.

---

## An analysis job completes but "Apply" produces no new columns

The runner may have returned an empty result (e.g. all molecules timed out). Check the job log by clicking the terminal icon next to the job in the queue. Common causes:

- Timeout too short for the dataset size — increase **Timeout per molecule**.
- Molecule converter failed to assign bonds — switch **Molecule converter** from `xyz2mol` to `rdkit` (or vice versa).
- xTB method incompatible with element types in the dataset — try a different **XTB method**.

---

## Dataset is loaded but Visualization shows no plots

Panels must be added manually. Click **Add panel** in the Visualization toolbar and select a plot type, then configure its axis bindings.
