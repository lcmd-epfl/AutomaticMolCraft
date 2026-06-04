# Backend

Run locally:

```bash
cd webapp/database-explorer-lite/backend
pip install -r requirements.txt
uvicorn main:app --reload
```

## Environment loading

On startup, backend auto-loads the first `.env` file found in this order:

1. `webapp/database-explorer-lite/.env`
2. `webapp/database-explorer-lite/backend/.env` (fallback)

Only variables not already set in the process environment are loaded from file.

## Generation directories

Generation roots are configurable via:

- `MOLCRAFT_MODELS_DIR` (default: `<repo>/models`)
- `MOLCRAFT_OUTPUTS_DIR` (default: `<repo>/outputs`)

Each generation job writes to:

`<outputs_root>/<model_id>/<YYYY-MM-DD>/<HHMMSS>_<job_id>/`

Files include:

- `config.yaml`
- `job.log`
- `status.json`
- `output/*.xyz`
