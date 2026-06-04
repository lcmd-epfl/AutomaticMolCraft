#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$ROOT_DIR/webapp/database-explorer-lite"
FRONTEND_DIR="$APP_DIR/frontend"
BACKEND_DIR="$APP_DIR/backend"

FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
BACKEND_PYTHON="${BACKEND_PYTHON:-python3}"
PARENT_DIR="$(cd "$ROOT_DIR/.." && pwd)"

# Default flow: backend only (serves frontend/dist when present).
# Set FRONTEND_DEV=1 to also run Vite dev server.
FRONTEND_DEV="${FRONTEND_DEV:-0}"
BACKEND_RELOAD="${BACKEND_RELOAD:-0}"

FRONTEND_PID=""
BACKEND_PID=""

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

ensure_frontend_dist() {
  local dist_dir="$FRONTEND_DIR/dist"
  local index_file="$dist_dir/index.html"

  if [[ ! -f "$index_file" ]]; then
    echo "[dev] Missing frontend build at $index_file"
  else
    local js_rel css_rel
    js_rel="$(grep -oE 'src="/assets/[^"]+\\.js"' "$index_file" | head -n1 | cut -d'"' -f2 || true)"
    css_rel="$(grep -oE 'href="/assets/[^"]+\\.css"' "$index_file" | head -n1 | cut -d'"' -f2 || true)"
    if [[ -n "$js_rel" && -n "$css_rel" && -f "$dist_dir${js_rel#/}" && -f "$dist_dir${css_rel#/}" ]]; then
      return
    fi
    echo "[dev] Frontend build exists but referenced assets are missing; rebuilding."
  fi

  require_cmd npm
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "[dev] Installing frontend dependencies"
    (
      cd "$FRONTEND_DIR"
      npm install
    )
  fi
  echo "[dev] Building frontend"
  (
    cd "$FRONTEND_DIR"
    npm run build
  )
}

load_first_env() {
  local env_candidates=(
    "$ROOT_DIR/.env"
    "$APP_DIR/.env"
    "$BACKEND_DIR/.env"
  )

  for env_path in "${env_candidates[@]}"; do
    if [[ -f "$env_path" ]]; then
      echo "[dev] Loading environment from $env_path"
      set -a
      # shellcheck source=/dev/null
      . "$env_path"
      set +a
      return
    fi
  done
}

cleanup() {
  local exit_code=$?

  set +e

  if [[ -n "$FRONTEND_PID" ]] && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
    kill "$FRONTEND_PID" >/dev/null 2>&1
    wait "$FRONTEND_PID" >/dev/null 2>&1
  fi

  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    kill "$BACKEND_PID" >/dev/null 2>&1
    wait "$BACKEND_PID" >/dev/null 2>&1
  fi

  exit "$exit_code"
}

trap cleanup EXIT INT TERM

load_first_env

# Prefer active/project virtualenv interpreter if caller did not override BACKEND_PYTHON.
if [[ "${BACKEND_PYTHON:-python3}" == "python3" ]]; then
  if [[ -n "${VIRTUAL_ENV:-}" && -x "${VIRTUAL_ENV}/bin/python" ]]; then
    BACKEND_PYTHON="${VIRTUAL_ENV}/bin/python"
  elif [[ -n "${CONDA_PREFIX:-}" && -x "${CONDA_PREFIX}/bin/python" ]]; then
    BACKEND_PYTHON="${CONDA_PREFIX}/bin/python"
  elif [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
    BACKEND_PYTHON="$BACKEND_DIR/.venv/bin/python"
  elif [[ -x "$BACKEND_DIR/venv/bin/python" ]]; then
    BACKEND_PYTHON="$BACKEND_DIR/venv/bin/python"
  elif [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
    BACKEND_PYTHON="$ROOT_DIR/.venv/bin/python"
  elif [[ -x "$ROOT_DIR/venv/bin/python" ]]; then
    BACKEND_PYTHON="$ROOT_DIR/venv/bin/python"
  elif [[ -x "$PARENT_DIR/.venv/bin/python" ]]; then
    BACKEND_PYTHON="$PARENT_DIR/.venv/bin/python"
  elif [[ -x "$PARENT_DIR/venv/bin/python" ]]; then
    BACKEND_PYTHON="$PARENT_DIR/venv/bin/python"
  elif command -v python >/dev/null 2>&1; then
    BACKEND_PYTHON="python"
  fi
fi

require_cmd "$BACKEND_PYTHON"

if ! "$BACKEND_PYTHON" -c "import uvicorn" >/dev/null 2>&1; then
  echo "[dev] Missing Python module: uvicorn in interpreter: $BACKEND_PYTHON" >&2
  echo "[dev] Install backend dependencies with:" >&2
  echo "      $BACKEND_PYTHON -m pip install -r \"$BACKEND_DIR/requirements.txt\"" >&2
  exit 1
fi

if [[ "$FRONTEND_DEV" == "1" ]]; then
  require_cmd npm
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    echo "[dev] Installing frontend dependencies"
    (
      cd "$FRONTEND_DIR"
      npm install
    )
  fi
else
  ensure_frontend_dist
fi

backend_args=(main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT")
if [[ "$BACKEND_RELOAD" == "1" ]]; then
  backend_args+=(--reload)
fi

echo "[dev] Starting backend on http://$BACKEND_HOST:$BACKEND_PORT"
(
  cd "$BACKEND_DIR"
  exec "$BACKEND_PYTHON" -m uvicorn "${backend_args[@]}"
) &
BACKEND_PID=$!

if [[ "$FRONTEND_DEV" == "1" ]]; then
  echo "[dev] Starting frontend on http://$FRONTEND_HOST:$FRONTEND_PORT"
  (
    cd "$FRONTEND_DIR"
    exec npm run dev -- --host "$FRONTEND_HOST" --port "$FRONTEND_PORT"
  ) &
  FRONTEND_PID=$!

  echo
  echo "Frontend (Vite): http://$FRONTEND_HOST:$FRONTEND_PORT"
  echo "Backend API:      http://$BACKEND_HOST:$BACKEND_PORT"
  echo "Press Ctrl+C to stop both servers."
  echo

  wait -n "$BACKEND_PID" "$FRONTEND_PID"
else
  echo
  echo "Web UI:   http://$BACKEND_HOST:$BACKEND_PORT"
  echo "API:      http://$BACKEND_HOST:$BACKEND_PORT"
  echo "Note: this mode serves frontend from frontend/dist via FastAPI."
  echo "Set FRONTEND_DEV=1 for Vite hot reload."
  echo "Press Ctrl+C to stop."
  echo

  wait "$BACKEND_PID"
fi
