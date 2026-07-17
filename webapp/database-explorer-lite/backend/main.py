from __future__ import annotations

import io
import json
import math
import os
import pickle
import pickletools
import struct
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
import zipfile
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from threading import Condition, Thread
from typing import Any, Dict, Literal

import yaml
from fastapi import FastAPI, Header, HTTPException, Query, UploadFile, File
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, JSONResponse, Response, FileResponse
from fastapi.staticfiles import StaticFiles

from tool_runtime import discover_tools, run_tool, ToolError
from training_config import (
    TASK_FAMILIES,
    PUBLIC_TASK_FAMILIES,
    ValidationError as TrainingValidationError,
    validate_payload as validate_training_payload,
    build_yaml_text,
    yaml_to_form_payload as _yaml_to_form_payload,
)

app = FastAPI()


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip()
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        os.environ[key] = value


def _load_env_discovery() -> None:
    here = Path(__file__).parent.resolve()
    app_root = here.parent
    repo_root = here.parents[2]
    candidates = [repo_root / ".env", app_root / ".env", here / ".env"]
    for candidate in candidates:
        if candidate.exists():
            _load_env_file(candidate)
            os.environ.setdefault("MOLCRAFT_ENV_FILE", str(candidate.resolve()))
            return


_load_env_discovery()

# -------------------------------------------------------------------
# CORS
# - For Vite dev (http://localhost:5173) calling backend (8000)
# - Also safe for local usage. (You can tighten later if desired.)
# -------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------------------------------------------
# CSV+XYZ mode: serve XYZ from local folder
# -------------------------------------------------------------------
XYZ_BASE = Path(os.environ.get("XYZ_BASE", "./xyz")).resolve()
XYZ_BASE.mkdir(parents=True, exist_ok=True)

# -------------------------------------------------------------------
# ASE mode: cache XYZ in memory after /ase/load
# -------------------------------------------------------------------
# Loads merge into this cache instead of replacing it: staged frontend
# sources resolve their XYZ lazily, so wiping the cache on a new load
# would orphan every previously staged source.
ASE_XYZ: Dict[str, str] = {}
ASE_XYZ_LOWER: Dict[str, str] = {}


def _ase_xyz_store(key: str, xyz: str) -> None:
    ASE_XYZ[key] = xyz
    ASE_XYZ_LOWER[key.lower()] = key

# -------------------------------------------------------------------
# MolCraftDiffusion generation mode
# -------------------------------------------------------------------
HERE = Path(__file__).parent.resolve()
REPO_ROOT = HERE.parents[2]
GEN_MODELS_DIR = Path(os.environ.get("MOLCRAFT_MODELS_DIR", REPO_ROOT / "models")).resolve()
GEN_OUTPUTS_DIR = Path(
    os.environ.get("MOLCRAFT_OUTPUTS_DIR", REPO_ROOT / "outputs")
).resolve()
PRESETS_DIR = Path(
    os.environ.get("MOLCRAFT_PRESETS_DIR", REPO_ROOT / "presets")
).resolve()
PREDICT_MODELS_DIR = Path(
    os.environ.get(
        "MOLCRAFT_PREDICT_MODELS_DIR",
        REPO_ROOT / "models" / "predictive_model",
    )
).resolve()
PREDICT_CONFIG_PATH = Path(
    os.environ.get("MOLCRAFT_PREDICT_CONFIG", REPO_ROOT / "predict.yaml")
).resolve()
MOLCRAFT_CMD = os.environ.get("MOLCRAFT_CMD", "MolCraftDiff")
ACTIVE_GENERATION_PROCS: Dict[str, subprocess.Popen] = {}

# -------------------------------------------------------------------
# MolCraftDiffusion training mode
# -------------------------------------------------------------------
_molcraft_outputs_env = os.environ.get("MOLCRAFT_OUTPUTS_DIR")
TRAIN_OUTPUTS_DIR = (
    Path(_molcraft_outputs_env).resolve() / "train"
    if _molcraft_outputs_env
    else (REPO_ROOT / "outputs" / "train").resolve()
)
TRAIN_DRY_DIR = TRAIN_OUTPUTS_DIR / "dry"
TRAIN_DB_PATH = HERE / "training_jobs.db"

TRAINING_QUEUE: list[str] = []
TRAINING_QUEUE_PAYLOADS: dict[str, dict[str, Any]] = {}
TRAINING_QUEUE_CONDITION = Condition()
TRAINING_QUEUE_WORKER_STARTED = False
ACTIVE_TRAINING_PROCS: Dict[str, subprocess.Popen] = {}

# Password-gated unlock — tokens live for the server process lifetime.
# Insertion-ordered dict so we can evict the oldest tokens (cap at 100).
_UNLOCK_TOKENS: dict[str, None] = {}
_UNLOCK_TOKENS_MAX = 100


def _unlock_password() -> str | None:
    return os.environ.get("MOLCRAFT_UNLOCK_PASSWORD") or None


def _check_token(token: str | None) -> bool:
    if not token:
        return False
    return token in _UNLOCK_TOKENS


def _allowed_task_families(token: str | None = None) -> dict[str, Any]:
    if os.environ.get("MOLCRAFT_ALL_FAMILIES", "0").lower() in ("1", "true", "yes"):
        return TASK_FAMILIES
    if _check_token(token):
        return TASK_FAMILIES
    return {k: v for k, v in TASK_FAMILIES.items() if k in PUBLIC_TASK_FAMILIES}
DEFAULT_ATOM_VOCAB = [
    "H",
    "B",
    "C",
    "N",
    "O",
    "F",
    "Al",
    "Si",
    "P",
    "S",
    "Cl",
    "As",
    "Se",
    "Br",
    "I",
    "Hg",
    "Bi",
]
ATOMIC_NUMBER_SYMBOLS = {
    1: "H",
    2: "He",
    3: "Li",
    4: "Be",
    5: "B",
    6: "C",
    7: "N",
    8: "O",
    9: "F",
    10: "Ne",
    11: "Na",
    12: "Mg",
    13: "Al",
    14: "Si",
    15: "P",
    16: "S",
    17: "Cl",
    18: "Ar",
    33: "As",
    34: "Se",
    35: "Br",
    53: "I",
    80: "Hg",
    83: "Bi",
}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_now_parts() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%d"), now.strftime("%H%M%S")


def _status_path(job_dir: Path) -> Path:
    return job_dir / "status.json"


def _job_index_path() -> Path:
    return GEN_OUTPUTS_DIR / ".job_index.json"


def _read_job_index() -> dict[str, str]:
    path = _job_index_path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items()}
    except Exception:
        return {}
    return {}


_GEN_INDEX_LOCK = threading.Lock()
# Guards read-modify-write of generation status.json (worker finish vs cancel).
_GEN_STATUS_LOCK = threading.Lock()


def _atomic_write_text(path: Path, text: str) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(text, encoding="utf-8")
    os.replace(tmp_path, path)


def _write_job_index(data: dict[str, str]) -> None:
    GEN_OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(
        _job_index_path(), json.dumps(data, indent=2, sort_keys=True)
    )


def _register_job_dir(job_id: str, job_dir: Path) -> None:
    with _GEN_INDEX_LOCK:
        index = _read_job_index()
        index[job_id] = str(job_dir.resolve())
        _write_job_index(index)


def _resolve_job_dir(job_id: str) -> Path:
    index = _read_job_index()
    indexed = index.get(job_id)
    if indexed:
        return Path(indexed).resolve()
    legacy = (GEN_OUTPUTS_DIR / job_id).resolve()
    if _status_path(legacy).exists():
        return legacy
    raise HTTPException(status_code=404, detail=f"Generation job not found: {job_id}")


def _job_dir(job_id: str) -> Path:
    if not job_id or "/" in job_id or "\\" in job_id or ".." in job_id:
        raise HTTPException(status_code=400, detail="Invalid job id")
    return _resolve_job_dir(job_id)


def _ensure_under(base: Path, path: Path) -> Path:
    base = base.resolve()
    path = path.resolve()
    try:
        path.relative_to(base)
    except ValueError:
        raise HTTPException(status_code=400, detail="Path escapes generation directory")
    return path


def _read_status(job_id: str) -> dict[str, Any]:
    job_dir = _job_dir(job_id)
    path = _status_path(job_dir)
    status: dict[str, Any] | None = None
    read_error: Exception | None = None
    # One short retry: a poll can catch the file mid-replacement.
    for attempt in range(2):
        try:
            status = json.loads(path.read_text(encoding="utf-8"))
            read_error = None
            break
        except Exception as exc:
            read_error = exc
            if attempt == 0:
                time.sleep(0.05)
    if status is None:
        raise HTTPException(status_code=500, detail=f"Could not read job status: {read_error}")
    proc = ACTIVE_GENERATION_PROCS.get(job_id)
    if proc is not None and proc.poll() is None:
        status["status"] = "running"
    return status


def _write_status(job_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    job_dir = _resolve_job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    status = {}
    path = _status_path(job_dir)
    if path.exists():
        try:
            status = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            status = {}
    status.update(patch)
    status["updated_at"] = _utc_now()
    _atomic_write_text(path, json.dumps(status, indent=2, sort_keys=True))
    return status


def _tail_lines(path: Path, max_lines: int) -> str:
    """Last max_lines of a file, reading only the tail instead of the whole file."""
    # ponytail: 256 bytes/line heuristic (min 64KB); good enough for log tails.
    read_bytes = max(64 * 1024, max_lines * 256)
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - read_bytes))
            data = fh.read()
    except OSError:
        return ""
    lines = data.decode("utf-8", errors="replace").splitlines()
    return "\n".join(lines[-max_lines:])


def _log_tail(job_dir: Path, max_lines: int = 120) -> str:
    log_path = job_dir / "job.log"
    if not log_path.exists():
        return ""
    return _tail_lines(log_path, max_lines)


def _generation_xyz_files(job_dir: Path) -> list[Path]:
    output_dir = job_dir / "output"
    if not output_dir.exists():
        return []
    return sorted(p for p in output_dir.iterdir() if p.is_file() and p.suffix.lower() == ".xyz")


def _safe_job_file(job_id: str, filename: str, suffix: str) -> Path:
    clean = Path(filename).name
    if clean != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    if not clean.lower().endswith(suffix):
        raise HTTPException(status_code=400, detail=f"Expected a {suffix} file")
    path = _job_dir(job_id) / "output" / clean
    _ensure_under(_job_dir(job_id) / "output", path)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {clean}")
    return path


def _trajectory_source_for_molecule(job_id: str, filename: str) -> tuple[str, Path]:
    clean = Path(filename).name
    if clean != filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    match = re.fullmatch(r"molecule_(\d+)\.xyz", clean, flags=re.IGNORECASE)
    if not match:
        raise HTTPException(status_code=400, detail="Expected molecule_XXXX.xyz")

    output_dir = (_job_dir(job_id) / "output").resolve()
    mol_index = int(match.group(1))
    mol_dir = output_dir / f"mol_{mol_index}"
    _ensure_under(output_dir, mol_dir)
    candidates = [
        mol_dir / "denoising.gjf",
        mol_dir / "denoising_trajectory.xyz",
        mol_dir / "denoising.xyz",
    ]
    trajectory_path = next((p for p in candidates if p.exists()), None)
    if trajectory_path is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Denoising trajectory not found for {clean}. "
                "Expected one of: denoising.gjf, denoising_trajectory.xyz, denoising.xyz"
            ),
        )
    return clean, trajectory_path


def _load_model_sidecar(model_dir: Path) -> dict[str, Any]:
    sidecar = model_dir / "model.json"
    if not sidecar.exists():
        return {}
    try:
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _infer_stat_properties(model_dir: Path) -> list[str]:
    stat = model_dir / "edm_stat.pkl"
    if not stat.exists():
        return []

    payload = _safe_stats_load(stat)
    if not isinstance(payload, dict):
        return []

    prop = payload.get("prop")
    if prop is None:
        return []

    distributions = _mapping_get(prop, "distributions")
    if isinstance(distributions, dict):
        return [str(name) for name in distributions]

    return _coerce_string_list(_mapping_get(prop, "property_names"))


def _infer_chem_from_pickle(model_dir: Path) -> dict[str, Any]:
    """Scan edm_chem.pkl without importing unknown modules (e.g. MolecularDiffusion).

    Extracts condition_names list and whether reference_indices is present by
    reading pickle opcodes directly, so this works even when the model's Python
    package is not installed on this machine.
    """
    chem = model_dir / "edm_chem.pkl"
    if not chem.exists():
        return {}
    try:
        with open(chem, "rb") as f:
            header = f.read(4)
        data: bytes | None = None
        if header[:2] == b"PK":
            # torch.save uses ZIP; the main pickle is <root>/data.pkl inside
            with zipfile.ZipFile(chem) as zf:
                pkl_name = next(
                    (n for n in zf.namelist() if n.endswith("data.pkl")), None
                )
                if pkl_name:
                    with zf.open(pkl_name) as f:
                        data = f.read()
        else:
            with open(chem, "rb") as f:
                data = f.read()
        if data is None:
            return {}

        # Build memo table: ref_id -> string value
        # A string op immediately followed by a PUT stores that string in the memo.
        memo: dict[int, str] = {}
        ops = [(op.name, arg) for op, arg, _pos in pickletools.genops(io.BytesIO(data))]
        for i, (name, arg) in enumerate(ops):
            if name in {"SHORT_BINUNICODE", "BINUNICODE", "UNICODE"} and isinstance(arg, str):
                if i + 1 < len(ops) and ops[i + 1][0] in {"LONG_BINPUT", "BINPUT", "PUT"}:
                    memo[ops[i + 1][1]] = arg

        condition_names: list[str] = []
        has_reference_indices = False

        for i, (name, arg) in enumerate(ops):
            if name in {"SHORT_BINUNICODE", "BINUNICODE", "UNICODE"} and isinstance(arg, str):
                if arg == "reference_indices" and not has_reference_indices:
                    # Value follows after optional PUT ops; non-None means the field exists
                    j = i + 1
                    while j < len(ops) and ops[j][0] in {"LONG_BINPUT", "BINPUT", "PUT"}:
                        j += 1
                    if j < len(ops) and ops[j][0] != "NONE":
                        has_reference_indices = True

                if arg == "condition_names" and not condition_names:
                    # Pattern: condition_names → [PUT...] → EMPTY_LIST → [PUT...] → MARK → BINGET... → APPENDS
                    j = i + 1
                    while j < len(ops) and ops[j][0] in {"LONG_BINPUT", "BINPUT", "PUT"}:
                        j += 1
                    if j < len(ops) and ops[j][0] == "EMPTY_LIST":
                        j += 1
                        while j < len(ops) and ops[j][0] in {"LONG_BINPUT", "BINPUT", "PUT"}:
                            j += 1
                        if j < len(ops) and ops[j][0] == "MARK":
                            j += 1
                            while j < len(ops) and ops[j][0] != "APPENDS":
                                if ops[j][0] in {"LONG_BINGET", "BINGET", "GET"} and ops[j][1] in memo:
                                    condition_names.append(memo[ops[j][1]])
                                j += 1

        return {"condition_names": condition_names, "has_reference_indices": has_reference_indices}
    except Exception:
        return {}


def _safe_pickle_load(path: Path) -> Any | None:
    try:
        with path.open("rb") as fh:
            return pickle.load(fh)
    except Exception:
        return None


_LEGACY_TORCH_MAGIC = 119547037146038801333356

_STORAGE_DTYPE: dict[str, tuple[str, int]] = {
    "FloatStorage": ("<f", 4),
    "DoubleStorage": ("<d", 8),
    "LongStorage": ("<q", 8),
    "IntStorage": ("<i", 4),
    "ShortStorage": ("<h", 2),
    "ByteStorage": ("<B", 1),
    "CharStorage": ("<b", 1),
    "HalfStorage": ("<e", 2),
    "BFloat16Storage": ("<e", 2),
}


class _StorageProxy:
    """Thin wrapper around raw float data extracted from a legacy PyTorch pickle."""

    def __init__(self, data: list[float] | None = None) -> None:
        self._data: list[float] = data or []

    def tolist(self) -> list[float]:
        return self._data

    @property
    def probs(self) -> "_StorageProxy":
        return self

    def item(self) -> float:
        return self._data[0] if self._data else 0.0


class _TensorProxy:
    """Simulates a torch Tensor (any rank) backed by a _StorageProxy."""

    def __init__(
        self,
        storage: _StorageProxy,
        offset: int,
        size: tuple[int, ...],
        stride: tuple[int, ...] | None = None,
    ) -> None:
        self._storage = storage
        self._offset = offset
        self._size = size
        # Compute C-contiguous stride if not provided
        if stride:
            self._stride: tuple[int, ...] = tuple(stride)
        else:
            s, strides = 1, []
            for d in reversed(size):
                strides.insert(0, s)
                s *= d
            self._stride = tuple(strides)

    def tolist(self) -> Any:
        data = self._storage._data
        if not data or not self._size:
            return []

        def _recurse(offset: int, dims: tuple[int, ...], strides: tuple[int, ...]) -> Any:
            if len(dims) == 1:
                return [data[offset + i * strides[0]] for i in range(dims[0])]
            return [_recurse(offset + i * strides[0], dims[1:], strides[1:]) for i in range(dims[0])]

        result = _recurse(self._offset, self._size, self._stride)
        return result

    @property
    def probs(self) -> "_TensorProxy":
        return self

    def item(self) -> float:
        data = self._storage._data
        if not data:
            return 0.0
        return float(data[self._offset])


def _rebuild_tensor_v2_stub(
    storage: Any,
    storage_offset: int,
    size: Any,
    stride: Any,
    requires_grad: bool,
    backward_hooks: Any,
) -> Any:
    if isinstance(storage, _StorageProxy):
        return _TensorProxy(
            storage,
            storage_offset,
            tuple(size) if size else (),
            tuple(stride) if stride else None,
        )
    return storage


def _legacy_load_from_bytes(b: bytes) -> Any:
    """Parse bytes in old PyTorch legacy format (magic=119547037146038801333356, pre-1.6)."""
    buf = io.BytesIO(b)
    try:
        magic = pickle.load(buf)
        if magic != _LEGACY_TORCH_MAGIC:
            return None
        pickle.load(buf)  # protocol version
        sys_info = pickle.load(buf)
    except Exception:
        return None

    little_endian = isinstance(sys_info, dict) and sys_info.get("little_endian", True)
    endian = "<" if little_endian else ">"

    storage_meta: dict[str, tuple[str, int]] = {}  # key -> (type_name, n_elems)

    class _LegacyStorageUnpickler(pickle.Unpickler):
        def find_class(self, module: str, name: str) -> Any:
            if module == "torch" and name.endswith("Storage"):
                return type(name, (), {})
            try:
                return super().find_class(module, name)
            except Exception:
                return type(name, (), {})

        def persistent_load(self, pid: Any) -> Any:  # type: ignore[override]
            if not isinstance(pid, (list, tuple)) or not pid or pid[0] != "storage":
                return pid
            storage_cls = pid[1]
            key = str(pid[2])
            n_elems = int(pid[4]) if len(pid) > 4 else 0
            type_name = getattr(storage_cls, "__name__", str(storage_cls))
            storage_meta[key] = (type_name, n_elems)
            proxy = object.__new__(_StorageProxy)
            proxy._data = []
            return proxy

    up = _LegacyStorageUnpickler(buf)
    try:
        obj = up.load()
    except Exception:
        return None

    try:
        keys_list: list[str] = [str(k) for k in pickle.load(buf)]
    except Exception:
        return obj

    for key in keys_list:
        type_name, n_elems = storage_meta.get(key, ("FloatStorage", 0))
        _, elem_size = _STORAGE_DTYPE.get(type_name, ("<f", 4))
        fmt_letter = _STORAGE_DTYPE.get(type_name, ("<f", 4))[0][1:]  # strip endian prefix
        # Old format has an 8-byte int64 size header before the raw element bytes
        size_hdr = buf.read(8)
        if len(size_hdr) == 8:
            stored_size = struct.unpack("<q", size_hdr)[0]
            n_elems = stored_size if stored_size > 0 else n_elems
        raw = buf.read(n_elems * elem_size)
        if len(raw) >= n_elems * elem_size > 0:
            data: list[float] = list(struct.unpack(endian + fmt_letter * n_elems, raw[: n_elems * elem_size]))
        else:
            data = []
        if isinstance(obj, _StorageProxy) and key == keys_list[0]:
            obj._data = data
        else:
            # multi-storage case: find proxy in object graph by key
            pass

    return obj


class _StubPickleObject:
    """Fallback class for unknown model-specific modules in stats pickles."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def __setstate__(self, state: Any) -> None:
        if isinstance(state, dict):
            self.__dict__.update(state)


class _SafeStatsUnpickler(pickle.Unpickler):
    _STUB_PREFIXES = (
        "torchdrug.models.en_diffusion",
        "MolecularDiffusion.",
        "omegaconf",
    )

    def find_class(self, module: str, name: str) -> Any:
        if any(module.startswith(p) for p in self._STUB_PREFIXES):
            return type(name, (_StubPickleObject,), {})
        if module == "torch.storage" and name == "_load_from_bytes":
            return _legacy_load_from_bytes
        if module == "torch._utils" and name == "_rebuild_tensor_v2":
            return _rebuild_tensor_v2_stub
        try:
            return super().find_class(module, name)
        except Exception:
            return type(name, (_StubPickleObject,), {})


def _safe_stats_load(path: Path) -> Any | None:
    try:
        with path.open("rb") as fh:
            return _SafeStatsUnpickler(fh).load()
    except Exception:
        return _safe_pickle_load(path)


def _safe_torch_load(path: Path) -> Any | None:
    try:
        import torch

        return torch.load(path, map_location="cpu", weights_only=False)
    except Exception:
        return None


@lru_cache(maxsize=2)
def _load_generation_checkpoint_cached(chem: Path, mtime: float) -> Any | None:
    payload = _safe_torch_load(chem)
    if payload is None:
        payload = _safe_pickle_load(chem)
    return payload


def _load_generation_checkpoint(model_dir: Path) -> Any | None:
    chem = model_dir / "edm_chem.pkl"
    try:
        mtime = chem.stat().st_mtime
    except OSError:
        return None
    return _load_generation_checkpoint_cached(chem, mtime)


def _mapping_get(data: Any, key: str, default: Any = None) -> Any:
    if isinstance(data, dict):
        return data.get(key, default)
    getter = getattr(data, "get", None)
    if callable(getter):
        try:
            return getter(key, default)
        except Exception:
            pass
    return getattr(data, key, default)


def _coerce_int_list(value: Any) -> list[int]:
    if value is None:
        return []
    if hasattr(value, "detach"):
        try:
            value = value.detach().cpu().tolist()
        except Exception:
            return []
    elif hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception:
            return []
    if isinstance(value, (str, bytes)):
        return []
    try:
        raw_values = list(value)
    except TypeError:
        raw_values = [value]
    out: list[int] = []
    for raw in raw_values:
        try:
            out.append(int(raw))
        except Exception:
            continue
    return out


def _coerce_string(value: Any) -> str | None:
    if value is None:
        return None
    scalar = _to_json_scalar(value)
    if scalar is not None:
        return str(scalar)
    return str(value)


def _coerce_string_list(value: Any) -> list[str]:
    if value is None or isinstance(value, (str, bytes)):
        return []
    try:
        raw_values = list(value)
    except TypeError:
        return []
    out: list[str] = []
    for raw in raw_values:
        item = _coerce_string(raw)
        if item:
            out.append(item)
    return out


def _atom_vocab_from_checkpoint(payload: Any) -> list[str]:
    hparams = _mapping_get(payload, "hyperparameters", {})
    vocab = _mapping_get(hparams, "atom_vocab")
    if vocab is None:
        vocab = _mapping_get(payload, "atom_vocab")
    if isinstance(vocab, (str, bytes)) or vocab is None:
        return DEFAULT_ATOM_VOCAB
    try:
        values = [str(item) for item in list(vocab)]
    except TypeError:
        return DEFAULT_ATOM_VOCAB
    return values or DEFAULT_ATOM_VOCAB


def _extract_structure_capabilities(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {
            "structure_completion": False,
            "reference_indices": [],
            "reference_freeze_mode": None,
            "has_reference_scaffold": False,
        }

    hparams = _mapping_get(payload, "hyperparameters", {})
    task = _mapping_get(hparams, "task", {})
    reference_indices = _coerce_int_list(_mapping_get(payload, "reference_indices"))
    if not reference_indices:
        reference_indices = _coerce_int_list(_mapping_get(task, "reference_indices"))
    freeze_mode = _coerce_string(_mapping_get(payload, "reference_freeze_mode"))
    if freeze_mode is None:
        freeze_mode = _coerce_string(_mapping_get(task, "reference_freeze_mode"))
    return {
        "structure_completion": bool(reference_indices),
        "reference_indices": reference_indices,
        "reference_freeze_mode": freeze_mode,
        "has_reference_scaffold": _mapping_get(payload, "reference_scaffold") is not None,
    }


def _extract_checkpoint_properties(payload: Any) -> list[str]:
    if payload is None:
        return []
    hparams = _mapping_get(payload, "hyperparameters", {})
    task = _mapping_get(hparams, "task", {})
    for candidate in (
        _mapping_get(hparams, "condition_names"),
        _mapping_get(task, "condition"),
        _mapping_get(payload, "property_names"),
    ):
        properties = _coerce_string_list(candidate)
        if properties:
            return properties
    return []


def _to_json_scalar(value: Any) -> str | int | float | bool | None:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return None


def _flatten_hparams(
    data: Any,
    prefix: str = "",
    depth: int = 0,
    limit: int = 50,
) -> dict[str, str | int | float | bool]:
    if depth > 3 or limit <= 0:
        return {}
    out: dict[str, str | int | float | bool] = {}
    if isinstance(data, dict):
        for key, value in data.items():
            if len(out) >= limit:
                break
            key_str = str(key)
            path = f"{prefix}.{key_str}" if prefix else key_str
            if isinstance(value, dict):
                nested = _flatten_hparams(
                    value, prefix=path, depth=depth + 1, limit=limit - len(out)
                )
                out.update(nested)
            else:
                scalar = _to_json_scalar(value)
                if isinstance(scalar, (str, int, float, bool)):
                    out[path] = scalar
    return out


def _extract_model_details_chem(
    model_dir: Path, payload: Any | None = None
) -> dict[str, Any]:
    chem = model_dir / "edm_chem.pkl"
    if not chem.exists():
        return {}

    if payload is None:
        payload = _load_generation_checkpoint(model_dir)
    if payload is None:
        return {}

    details: dict[str, Any] = {}
    if isinstance(payload, dict):
        hparams = payload.get("hyperparameters")
        if isinstance(hparams, dict):
            flat = _flatten_hparams(hparams)
            if flat:
                details["hyperparameters"] = flat
            task = hparams.get("task")
            if isinstance(task, dict):
                diffusion_model = task.get("diffusion_model")
                if isinstance(diffusion_model, dict):
                    cls_name = diffusion_model.get("class")
                    if cls_name is not None:
                        details["architecture"] = str(cls_name)
                elif diffusion_model is not None:
                    cls = getattr(diffusion_model, "__class__", None)
                    if cls is not None:
                        details["architecture"] = f"{cls.__module__}.{cls.__name__}"
        for key in ("architecture", "model_name", "model_class"):
            value = payload.get(key)
            if value is not None:
                details["architecture"] = details.get("architecture") or (
                    value
                    if isinstance(value, (str, dict))
                    else str(value)
                )
                break
        for key in ("num_parameters", "n_parameters", "parameter_count"):
            value = payload.get(key)
            if isinstance(value, (int, float)):
                details["num_parameters"] = int(value)
                break
        for key in ("hparams", "config", "model_kwargs"):
            value = payload.get(key)
            if isinstance(value, dict):
                flat = _flatten_hparams(value)
                if flat:
                    details["hyperparameters"] = details.get("hyperparameters") or flat
                    break
        if "architecture" not in details:
            target = payload.get("_target_") or payload.get("class_path")
            if target is not None:
                details["architecture"] = str(target)
        if "num_parameters" not in details:
            model_state = payload.get("model")
            if isinstance(model_state, dict):
                total = 0
                for tensor in model_state.values():
                    if hasattr(tensor, "numel"):
                        try:
                            total += int(tensor.numel())
                        except Exception:
                            continue
                if total > 0:
                    details["num_parameters"] = total

    else:
        cls = getattr(payload, "__class__", None)
        if cls is not None:
            details["architecture"] = f"{cls.__module__}.{cls.__name__}"

    return details


def _coerce_histogram(candidate: Any) -> dict[str, list[float]] | None:
    if not isinstance(candidate, dict):
        return None
    bins = candidate.get("bins")
    counts = candidate.get("counts")
    if not isinstance(bins, (list, tuple)) or not isinstance(counts, (list, tuple)):
        return None
    try:
        bins_f = [float(v) for v in bins]
        counts_f = [float(v) for v in counts]
    except Exception:
        return None
    if not bins_f or not counts_f:
        return None
    return {"bins": bins_f, "counts": counts_f}


def _collect_stats_from_dict(data: dict[str, Any]) -> list[dict[str, Any]]:
    stats: list[dict[str, Any]] = []
    for key, value in data.items():
        hist = _coerce_histogram(value)
        if hist:
            stats.append({"key": str(key), "label": str(key).replace("_", " "), "histogram": hist})
            continue
        if isinstance(value, dict):
            nested = _coerce_histogram(value.get("histogram"))
            if nested:
                stat_item: dict[str, Any] = {
                    "key": str(key),
                    "label": str(value.get("label") or str(key).replace("_", " ")),
                    "histogram": nested,
                }
                summary = _to_json_scalar(value.get("summary"))
                if isinstance(summary, (str, int, float, bool)):
                    stat_item["summary"] = summary
                stats.append(stat_item)
    return stats


def _extract_model_details_stats(model_dir: Path) -> list[dict[str, Any]]:
    stat_path = model_dir / "edm_stat.pkl"
    if not stat_path.exists():
        return []
    payload = _safe_stats_load(stat_path)
    if payload is None:
        return []

    stats: list[dict[str, Any]] = []
    if isinstance(payload, dict):
        if isinstance(payload.get("distributions"), dict):
            stats.extend(_collect_stats_from_dict(payload["distributions"]))
        stats.extend(_collect_stats_from_dict(payload))

        # DistributionNodes layout: keys (size->index), prob tensor.
        node = payload.get("node")
        node_hist: dict[int, float] = {}
        if node is not None:
            keys_map = getattr(node, "keys", None)
            probs = getattr(node, "prob", None)
            if isinstance(keys_map, dict) and probs is not None and hasattr(probs, "tolist"):
                probs_list = probs.tolist()
                for size, idx in keys_map.items():
                    try:
                        node_hist[int(size)] = float(probs_list[int(idx)])
                    except Exception:
                        continue
                if node_hist:
                    bins = sorted(node_hist.keys())
                    counts = [node_hist[b] for b in bins]
                    stats.append(
                        {
                            "key": "molecular_size",
                            "label": "Molecular size",
                            "summary": f"{len(bins)} bins",
                            "histogram": {"bins": bins, "counts": counts},
                        }
                    )

        # DistributionProperty layout: distributions[prop][size] -> {probs, params}
        prop = payload.get("prop")
        prop_dist = getattr(prop, "distributions", None)
        if isinstance(prop_dist, dict):
            for prop_name, size_map in prop_dist.items():
                if not isinstance(size_map, dict):
                    continue
                weighted_samples: list[tuple[float, float]] = []
                for size, entry in size_map.items():
                    if not isinstance(entry, dict):
                        continue
                    probs_obj = entry.get("probs")
                    probs_t = getattr(probs_obj, "probs", None)
                    if probs_t is None or not hasattr(probs_t, "tolist"):
                        continue
                    probs_arr = [float(v) for v in probs_t.tolist()]
                    if not probs_arr:
                        continue
                    params = entry.get("params")
                    if (
                        isinstance(params, list)
                        and len(params) == 2
                        and all(hasattr(p, "item") or isinstance(p, (int, float)) for p in params)
                    ):
                        try:
                            lo = float(params[0].item() if hasattr(params[0], "item") else params[0])
                            hi = float(params[1].item() if hasattr(params[1], "item") else params[1])
                            if len(probs_arr) == 1:
                                bins_arr = [lo]
                            elif abs(hi - lo) < 1e-12:
                                bins_arr = list(range(len(probs_arr)))
                            else:
                                bins_arr = [
                                    lo + (hi - lo) * i / (len(probs_arr) - 1)
                                    for i in range(len(probs_arr))
                                ]
                        except Exception:
                            bins_arr = list(range(len(probs_arr)))
                    else:
                        bins_arr = list(range(len(probs_arr)))
                    weight = node_hist.get(int(size), 1.0)
                    if weight <= 0:
                        continue
                    for idx, value in enumerate(probs_arr):
                        weighted_prob = float(value) * float(weight)
                        if weighted_prob <= 0:
                            continue
                        x_val = float(bins_arr[idx]) if idx < len(bins_arr) else float(idx)
                        weighted_samples.append((x_val, weighted_prob))
                if weighted_samples:
                    x_values = [x for x, _ in weighted_samples]
                    x_min = min(x_values)
                    x_max = max(x_values)
                    n_bins = max(20, min(60, int(len(weighted_samples) ** 0.5) * 2))
                    if abs(x_max - x_min) < 1e-12:
                        hist_bins = [x_min]
                        hist_counts = [sum(w for _, w in weighted_samples)]
                    else:
                        width = (x_max - x_min) / n_bins
                        hist_counts = [0.0] * n_bins
                        for x_val, weight in weighted_samples:
                            idx = int((x_val - x_min) / width)
                            if idx >= n_bins:
                                idx = n_bins - 1
                            if idx < 0:
                                idx = 0
                            hist_counts[idx] += weight
                        hist_bins = [x_min + width * (i + 0.5) for i in range(n_bins)]
                    total = sum(hist_counts) or 1.0
                    counts = [v / total for v in hist_counts]
                    stats.append(
                        {
                            "key": str(prop_name),
                            "label": str(prop_name).replace("_", " ").title(),
                            "summary": f"{len(counts)} bins",
                            "histogram": {"bins": hist_bins, "counts": counts},
                        }
                    )
    return stats


# Single-entry cache: (fingerprint of models dir) -> discovered models.
_GEN_MODELS_CACHE: dict[str, Any] = {"key": None, "models": []}


def _gen_models_fingerprint() -> tuple:
    if not GEN_MODELS_DIR.exists():
        return ()
    parts: list[tuple] = []
    for p in sorted(GEN_MODELS_DIR.iterdir()):
        if not p.is_dir():
            continue
        chem = p / "edm_chem.pkl"
        try:
            parts.append((p.name, p.stat().st_mtime, chem.stat().st_mtime if chem.exists() else None))
        except OSError:
            parts.append((p.name, None, None))
    return (str(GEN_MODELS_DIR), tuple(parts))


def _discover_generation_models() -> list[dict[str, Any]]:
    key = _gen_models_fingerprint()
    if _GEN_MODELS_CACHE["key"] == key:
        return _GEN_MODELS_CACHE["models"]
    models = _discover_generation_models_uncached()
    _GEN_MODELS_CACHE["key"] = key
    _GEN_MODELS_CACHE["models"] = models
    return models


def _discover_generation_models_uncached() -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    if not GEN_MODELS_DIR.exists():
        return models

    for model_dir in sorted(p for p in GEN_MODELS_DIR.iterdir() if p.is_dir()):
        chem = model_dir / "edm_chem.pkl"
        if not chem.exists():
            continue

        sidecar = _load_model_sidecar(model_dir)
        checkpoint = _load_generation_checkpoint(model_dir)
        properties = sidecar.get("properties")
        chem_inferred: dict[str, Any] = {}
        if not isinstance(properties, list):
            extracted = _extract_checkpoint_properties(checkpoint)
            if not extracted:
                chem_inferred = _infer_chem_from_pickle(model_dir)
                extracted = chem_inferred.get("condition_names") or _infer_stat_properties(model_dir)
            properties = extracted
        properties = [str(p) for p in properties]

        capabilities = _extract_structure_capabilities(checkpoint)
        if not capabilities["structure_completion"] and checkpoint is None:
            if not chem_inferred:
                chem_inferred = _infer_chem_from_pickle(model_dir)
            if chem_inferred.get("has_reference_indices"):
                capabilities = {**capabilities, "structure_completion": True}

        # Supplement capabilities from edm_stat.pkl when checkpoint is unavailable
        if not capabilities["has_reference_scaffold"] and (model_dir / "edm_stat.pkl").exists():
            stat_payload = _safe_stats_load(model_dir / "edm_stat.pkl")
            if _mapping_get(stat_payload, "reference_scaffold") is not None:
                capabilities = {**capabilities, "has_reference_scaffold": True}
                if not capabilities["reference_freeze_mode"]:
                    fm = _coerce_string(_mapping_get(stat_payload, "reference_freeze_mode"))
                    if fm:
                        capabilities = {**capabilities, "reference_freeze_mode": fm}

        defaults = sidecar.get("defaults") if isinstance(sidecar.get("defaults"), dict) else {}
        model_item: dict[str, Any] = {
            "id": model_dir.name,
            "name": sidecar.get("name") or model_dir.name,
            "description": sidecar.get("description") or "",
            "task_type": sidecar.get("task_type") or ("cfg" if properties else "unconditional"),
            "path": str(model_dir),
            "has_stat": (model_dir / "edm_stat.pkl").exists(),
            "properties": properties,
            "property_labels": sidecar.get("property_labels") or {},
            "defaults": defaults,
            "capabilities": capabilities,
        }

        details = _extract_model_details_chem(model_dir, checkpoint)
        stats = _extract_model_details_stats(model_dir)
        if stats:
            details["stats"] = stats
        if details:
            model_item["model_details"] = details

        models.append(model_item)
    return models


def _model_by_id(model_id: str) -> dict[str, Any]:
    for model in _discover_generation_models():
        if model["id"] == model_id:
            return model
    raise HTTPException(status_code=404, detail=f"Generation model not found: {model_id}")


def _checkpoint_tensor_rows(value: Any) -> list[list[float]]:
    if value is None:
        return []
    if hasattr(value, "detach"):
        try:
            value = value.detach().cpu().tolist()
        except Exception:
            return []
    elif hasattr(value, "tolist"):
        try:
            value = value.tolist()
        except Exception:
            return []

    rows = value
    if isinstance(rows, list) and rows and isinstance(rows[0], list):
        first = rows[0]
        if first and isinstance(first[0], list):
            rows = first
    if not isinstance(rows, list):
        return []

    parsed: list[list[float]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 4:
            continue
        try:
            parsed.append([float(v) for v in row])
        except Exception:
            continue
    return parsed


def _symbol_from_atomic_number_channel(value: float) -> str | None:
    candidates: list[int] = []
    if abs(value) <= 3 and abs((value * 10) - round(value * 10)) < 1e-3:
        candidates.append(int(round(value * 10)))
    if abs(value - round(value)) < 1e-3:
        candidates.append(int(round(value)))
    for atomic_number in candidates:
        symbol = ATOMIC_NUMBER_SYMBOLS.get(atomic_number)
        if symbol:
            return symbol
    return None


def _symbol_from_atom_features(row: list[float], atom_vocab: list[str]) -> str:
    features = row[3:-1] if len(row) > 4 else []
    if features:
        max_idx, max_value = max(enumerate(features), key=lambda item: item[1])
        if max_value > 0 and max_idx < len(atom_vocab):
            return atom_vocab[max_idx]
    return atom_vocab[0] if atom_vocab else "X"


def _reference_scaffold_xyz(payload: Any) -> tuple[str, int] | None:
    scaffold = _mapping_get(payload, "reference_scaffold")
    rows = _checkpoint_tensor_rows(scaffold)
    if not rows:
        return None
    atom_vocab = _atom_vocab_from_checkpoint(payload)
    atom_lines: list[str] = []
    for row in rows:
        symbol = _symbol_from_atomic_number_channel(row[-1])
        if symbol is None:
            symbol = _symbol_from_atom_features(row, atom_vocab)
        atom_lines.append(f"{symbol} {row[0]:.6f} {row[1]:.6f} {row[2]:.6f}")
    xyz = "\n".join(
        [str(len(atom_lines)), "checkpoint reference scaffold", *atom_lines]
    )
    return f"{xyz}\n", len(atom_lines)


def _discover_predict_models() -> list[dict[str, Any]]:
    models: list[dict[str, Any]] = []
    if not PREDICT_MODELS_DIR.exists():
        return models

    for path in sorted(p for p in PREDICT_MODELS_DIR.iterdir() if p.is_file()):
        ext = path.suffix.lower()
        if ext not in {".pkl", ".pt", ".ckpt"}:
            continue
        stat = path.stat()
        models.append(
            {
                "id": path.name,
                "name": path.stem,
                "path": str(path.resolve()),
                "type": ext.lstrip("."),
                "extension": ext,
                "size": stat.st_size,
                "modifiedTime": datetime.fromtimestamp(
                    stat.st_mtime, timezone.utc
                ).isoformat(),
            }
        )
    return models


def _predict_model_by_id(model_id: str) -> dict[str, Any]:
    if not PREDICT_MODELS_DIR.exists():
        raise HTTPException(
            status_code=400,
            detail=(
                "Predictive model directory does not exist: "
                f"{PREDICT_MODELS_DIR}"
            ),
        )
    models = _discover_predict_models()
    if not models:
        raise HTTPException(
            status_code=400,
            detail=(
                "No predictive checkpoint files were found in "
                f"{PREDICT_MODELS_DIR}. Expected .pkl, .pt, or .ckpt files."
            ),
        )
    for model in models:
        if model["id"] == model_id:
            return model
    raise HTTPException(
        status_code=404,
        detail=f"Predictive model not found: {model_id}",
    )


class GenerationPropertyTarget(BaseModel):
    name: str
    target: float
    negative_target: float | None = None


class GenerationJobRequest(BaseModel):
    model_id: str
    num_generate: int = Field(default=1, ge=1, le=10000)
    batch_size: int = Field(default=1, ge=1, le=1024)
    n_frames: int = Field(default=1, ge=1, le=10000)
    diffusion_steps: int = Field(default=50, ge=1, le=10000)
    seed: int = Field(default=86)
    size_mode: Literal["random", "fixed", "range"] = "random"
    fixed_size: int | None = Field(default=None, ge=1, le=1000)
    min_size: int | None = Field(default=None, ge=1, le=1000)
    max_size: int = Field(default=100, ge=1, le=1000)
    cfg_scale: float = Field(default=1.0, ge=0, le=1000)
    property_targets: list[GenerationPropertyTarget] = []
    structure_guidance: dict[str, Any] | None = None


def _parse_xyz_atom_count(xyz_text: str) -> int:
    lines = xyz_text.splitlines()
    while lines and not lines[-1].strip():
        lines.pop()
    if len(lines) < 3:
        raise HTTPException(status_code=400, detail="Invalid XYZ: expected atom count and atom rows")
    try:
        atom_count = int(lines[0].strip().lstrip("\ufeff"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid XYZ atom count: {exc}")
    atom_rows = lines[2 : atom_count + 2]
    if atom_count <= 0 or len(atom_rows) < atom_count or any(not row.strip() for row in atom_rows):
        raise HTTPException(status_code=400, detail="Invalid XYZ: missing atom rows")
    return atom_count


def _mol_size_from_payload(payload: GenerationJobRequest) -> tuple[list[int], int]:
    if payload.size_mode == "fixed":
        n = payload.fixed_size or payload.max_size
        return [int(n)], int(max(n, payload.max_size))
    if payload.size_mode == "range":
        lo = payload.min_size or 1
        hi = max(payload.max_size, lo)
        return [int(lo), int(hi)], int(hi)
    return [0, 0], int(payload.max_size)


def _generation_config(model: dict[str, Any], payload: GenerationJobRequest, output_dir: Path) -> dict[str, Any]:
    properties = [p for p in model.get("properties", []) if p]
    requested = {t.name: t for t in payload.property_targets}
    use_cfg = bool(properties and requested)
    structure_guidance = payload.structure_guidance or {}
    prop_names = [p for p in properties if p in requested]
    target_values = [requested[p].target for p in prop_names]
    negative_target_values = [
        requested[p].negative_target if requested[p].negative_target is not None else -requested[p].target
        for p in prop_names
    ]
    mol_size, max_mol_size = _mol_size_from_payload(payload)

    interference: dict[str, Any] = {
        "_target_": "MolecularDiffusion.runmodes.generate.GenerativeFactory",
        "task_type": "cfg" if use_cfg else "unconditional",
        "sampling_mode": "ddpm",
        "num_generate": payload.num_generate,
        "batch_size": payload.batch_size,
        "n_frames": payload.n_frames,
        "max_mol_size": max_mol_size,
        "mol_size": mol_size,
        "target_values": target_values,
        "negative_target_values": negative_target_values,
        "property_names": prop_names,
        "seed": payload.seed,
        "output_path": str(output_dir),
    }
    if payload.n_frames > 1:
        interference["save_xyzrender_figures"] = True
    if use_cfg:
        interference["condition_configs"] = {"cfg_scale": payload.cfg_scale}

    hydra_interference = structure_guidance.get(
        "hydra_interference",
        "gen_cfg" if use_cfg else "gen_unconditional",
    )
    config = {
        "defaults": [
            {"tasks": "diffusion"},
            {"interference": hydra_interference},
            "_self_",
        ],
        "chkpt_directory": model["path"],
        "atom_vocab": DEFAULT_ATOM_VOCAB,
        "diffusion_steps": payload.diffusion_steps,
        "interference": interference,
    }
    if structure_guidance:
        interference["task_type"] = structure_guidance["task_type"]
        condition_configs = dict(interference.get("condition_configs") or {})
        condition_configs.update(structure_guidance.get("condition_configs") or {})
        interference["condition_configs"] = condition_configs
    return config


def _validate_structure_guidance(
    payload: GenerationJobRequest, model: dict[str, Any]
) -> tuple[dict[str, Any], str] | tuple[None, None]:
    sg = payload.structure_guidance
    if not sg:
        return None, None
    xyz = str(sg.get("reference_xyz") or "")
    atom_count = _parse_xyz_atom_count(xyz)
    mode = str(sg.get("mode") or "").lower()
    sampling_mode = str(sg.get("sampling_mode") or "sample")
    if mode not in {"inpaint", "outpaint"}:
        raise HTTPException(status_code=400, detail="Structure mode must be inpaint or outpaint")
    if sampling_mode not in {"sample", "sample_hybrid"}:
        raise HTTPException(status_code=400, detail="Sampling mode must be sample or sample_hybrid")
    if sampling_mode == "sample_hybrid" and not model.get("properties"):
        raise HTTPException(
            status_code=400,
            detail=f"Model {model['id']} has no conditional properties and must use sample",
        )
    try:
        selected = [int(v) for v in (sg.get("selected_indices") or [])]
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid selected atom index: {exc}")
    if any(i < 0 or i >= atom_count for i in selected):
        raise HTTPException(status_code=400, detail="Selected atom indices out of range")
    final_size = (payload.fixed_size or payload.max_size) if payload.size_mode == "fixed" else payload.max_size
    if mode == "inpaint" and final_size < atom_count:
        raise HTTPException(status_code=400, detail="Inpaint final size must be >= reference atom count")
    if mode == "outpaint":
        if not selected:
            raise HTTPException(status_code=400, detail="Outpaint requires at least one selected atom")
        if final_size <= atom_count:
            raise HTTPException(status_code=400, detail="Outpaint final size must be > reference atom count")

    def _unit_float(name: str, fallback: float) -> float:
        raw = sg.get(name, fallback)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{name} must be a number between 0 and 1")
        if value < 0 or value > 1:
            raise HTTPException(status_code=400, detail=f"{name} must be between 0 and 1")
        return value

    denoising_strength = _unit_float("denoising_strength", 0.5)
    constraint_strength = _unit_float("constraint_strength", 0.8)
    noise_initial_mask = True
    if mode == "inpaint":
        noise_initial_mask = sg.get("noise_initial_mask", True)
        if not isinstance(noise_initial_mask, bool):
            raise HTTPException(status_code=400, detail="noise_initial_mask must be true or false")

    is_hybrid = sampling_mode == "sample_hybrid"
    task_type = f"{mode}_cfg" if is_hybrid else mode
    hydra_interference = "gen_hybrid" if is_hybrid else f"gen_{mode}"
    condition_configs: dict[str, Any] = {
        "reference_structure_path": None,
        "center_saved_scaffold": False,
        "condition_component": "xh",
        "use_noised_conditioning": False,
    }
    if sampling_mode == "sample_hybrid":
        condition_configs.update({"cfg_scale": payload.cfg_scale, "guidance_ver": "cfg"})
    if mode == "inpaint":
        inpaint_cfgs: dict[str, Any] = {"mask_node_index": selected}
        for key in (
            "scale_factor",
            "t_start",
        ):
            if key in sg:
                inpaint_cfgs[key] = sg[key]
        inpaint_cfgs["denoising_strength"] = denoising_strength
        inpaint_cfgs["constraint_strength"] = constraint_strength
        inpaint_cfgs["noise_initial_mask"] = noise_initial_mask
        condition_configs["inpaint_cfgs"] = inpaint_cfgs
    else:
        bonds = sg.get("connector_bonds") or {}
        connector_indices = [int(i) for i in selected]
        connectors = {idx: [int(bonds.get(str(idx), 1))] for idx in connector_indices}
        outpaint_cfgs: dict[str, Any] = {
            "connector_indices": connector_indices,
            "connector_dicts": connectors,
        }
        for key in (
            "t_start",
            "scale_factor",
            "seed_dist",
            "min_dist",
            "spread",
            "n_bq_atom",
        ):
            if key in sg:
                outpaint_cfgs[key] = sg[key]
        outpaint_cfgs["constraint_strength"] = constraint_strength
        condition_configs["outpaint_cfgs"] = outpaint_cfgs
    for key in (
        "n_retrys",
        "t_retry",
    ):
        if key in sg:
            condition_configs[key] = sg[key]
    raw_retries = condition_configs.get("n_retrys")
    raw_t_retry = condition_configs.get("t_retry")
    if raw_retries is not None:
        try:
            n_retrys = max(0, int(raw_retries))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="n_retrys must be a non-negative integer")
        if mode == "outpaint" and n_retrys > 0:
            # Current MolecularDiffusion outpaint retry path is unstable and can fail
            # with internal indexing/state errors; run outpaint without retries.
            n_retrys = 0
        condition_configs["n_retrys"] = n_retrys
        if n_retrys > 0:
            try:
                t_retry = max(1, int(raw_t_retry if raw_t_retry is not None else 10))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="t_retry must be a positive integer")
            # MolecularDiffusion allocates retry chain frames as:
            # int(n_frames * t_retry / diffusion_steps). Keep this >= 1 to avoid
            # zero-length retry buffers that later crash with index -1 access.
            if payload.n_frames > 0 and payload.diffusion_steps > 0:
                min_t_retry = math.ceil(payload.diffusion_steps / payload.n_frames)
                if t_retry < min_t_retry:
                    t_retry = min_t_retry
            condition_configs["t_retry"] = t_retry
    built: dict[str, Any] = {
        "mode": mode,
        "sampling_mode": sampling_mode,
        "task_type": task_type,
        "hydra_interference": hydra_interference,
        "condition_configs": condition_configs,
        "selected_indices": selected,
    }
    return built, xyz


def _run_generation_job(job_id: str, cmd: list[str], job_dir: Path, log_path: Path):
    _write_status(job_id, {"status": "running", "started_at": _utc_now(), "command": cmd})
    return_code = None
    try:
        with log_path.open("ab") as log_fh:
            proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT), stdout=log_fh, stderr=subprocess.STDOUT)
            ACTIVE_GENERATION_PROCS[job_id] = proc
            return_code = proc.wait()
    except Exception as exc:
        _write_status(
            job_id,
            {
                "status": "failed",
                "finished_at": _utc_now(),
                "return_code": return_code,
                "error": str(exc),
                "log_tail": _log_tail(job_dir),
            },
        )
        ACTIVE_GENERATION_PROCS.pop(job_id, None)
        return

    ACTIVE_GENERATION_PROCS.pop(job_id, None)
    files = [p.name for p in _generation_xyz_files(job_dir)]
    with _GEN_STATUS_LOCK:
        current = _read_status(job_id)
        if current.get("status") == "cancelled":
            return
        _write_status(
            job_id,
            {
                "status": "completed" if return_code == 0 else "failed",
                "finished_at": _utc_now(),
                "return_code": return_code,
                "molecule_count": len(files),
                "log_tail": _log_tail(job_dir),
            },
        )


def _resolve_xyz_text(mol_id: str) -> tuple[str, str]:
    key = mol_id.replace(".xyz", "")

    if key in ASE_XYZ:
        return key, ASE_XYZ[key]

    canonical = ASE_XYZ_LOWER.get(key.lower())
    if canonical is not None:
        return canonical, ASE_XYZ[canonical]

    for candidate in (XYZ_BASE / f"{key}.xyz", XYZ_BASE / f"{key.lower()}.xyz"):
        if candidate.exists():
            return key, candidate.read_text(encoding="utf-8")
    raise HTTPException(status_code=404, detail=f"XYZ not found: {key}.xyz")


class XyzBatchRequest(BaseModel):
    ids: list[str]


@app.get("/xyz/{mol_id}.xyz", response_class=PlainTextResponse)
def get_xyz(mol_id: str):
    _key, xyz = _resolve_xyz_text(mol_id)
    return xyz


_XYZ_BATCH_MAX_IDS = 2000


@app.post("/xyz/batch")
def get_xyz_batch(req: XyzBatchRequest):
    if len(req.ids) > _XYZ_BATCH_MAX_IDS:
        raise HTTPException(
            status_code=413,
            detail=f"Too many ids in one request (max {_XYZ_BATCH_MAX_IDS}); split into batches.",
        )
    xyz_by_id: dict[str, str] = {}
    missing: list[str] = []

    for raw_id in req.ids:
        mol_id = str(raw_id).strip()
        if not mol_id:
            continue
        try:
            _key, xyz = _resolve_xyz_text(mol_id)
            xyz_by_id[mol_id] = xyz
        except HTTPException as exc:
            if exc.status_code == 404:
                missing.append(mol_id)
                continue
            raise

    return {"xyzById": xyz_by_id, "missing": missing}


def _render_xyz_to_svg_response(key: str, xyz: str) -> Response | JSONResponse:
    # Sanitize once here so every caller is covered (path + header safety).
    key = re.sub(r"[^A-Za-z0-9._-]", "_", key).lstrip(".") or "molecule"
    bin_path = shutil.which("xyzrender")
    if not bin_path:
        return JSONResponse(
            status_code=503,
            content={
                "error": "xyzrender is not available",
                "code": "XYZRENDER_MISSING",
                "message": "Install xyzrender and make sure it is in PATH.",
            },
        )

    with tempfile.TemporaryDirectory(prefix="xyzrender_") as td:
        tmp_dir = Path(td)
        xyz_in = tmp_dir / f"{key}.xyz"
        svg_out = tmp_dir / f"{key}.svg"
        xyz_in.write_text(xyz, encoding="utf-8")

        try:
            proc = subprocess.run(
                [bin_path, str(xyz_in), "-o", str(svg_out)],
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )
        except Exception as exc:
            return JSONResponse(
                status_code=500,
                content={
                    "error": "xyzrender execution failed",
                    "code": "XYZRENDER_FAILED",
                    "message": str(exc),
                },
            )

        if proc.returncode != 0 or not svg_out.exists():
            stderr = (proc.stderr or "").strip()
            msg = stderr.splitlines()[0] if stderr else "xyzrender returned non-zero exit status"
            return JSONResponse(
                status_code=500,
                content={
                    "error": "xyzrender failed",
                    "code": "XYZRENDER_FAILED",
                    "message": msg[:300],
                },
            )

        svg_bytes = svg_out.read_bytes()
        svg_head = svg_bytes[:4096].decode("utf-8", errors="ignore").lower()
        if "<svg" not in svg_head:
            return JSONResponse(
                status_code=500,
                content={
                    "error": "xyzrender produced invalid svg",
                    "code": "XYZRENDER_FAILED",
                    "message": "Output did not contain an <svg> root element.",
                },
            )

    return Response(
        content=svg_bytes,
        media_type="image/svg+xml",
        headers={"Content-Disposition": f'attachment; filename="{key}.svg"'},
    )


def _render_trajectory_to_gif_response(key: str, trajectory_path: Path) -> Response | JSONResponse:
    key = re.sub(r"[^A-Za-z0-9._-]", "_", key).lstrip(".") or "molecule"
    bin_path = shutil.which("xyzrender")
    if not bin_path:
        return JSONResponse(
            status_code=503,
            content={
                "error": "xyzrender is not available",
                "code": "XYZRENDER_MISSING",
                "message": "Install xyzrender and make sure it is in PATH.",
            },
        )

    with tempfile.TemporaryDirectory(prefix="xyzrender_trj_") as td:
        gif_out = Path(td) / f"{key}-denoising.gif"
        try:
            proc = subprocess.run(
                [
                    bin_path,
                    str(trajectory_path),
                    "--gif-trj",
                    "--gif-output",
                    str(gif_out),
                ],
                capture_output=True,
                text=True,
                check=False,
                timeout=120,
            )
        except Exception as exc:
            return JSONResponse(
                status_code=500,
                content={
                    "error": "xyzrender execution failed",
                    "code": "XYZRENDER_FAILED",
                    "message": str(exc),
                },
            )

        if proc.returncode != 0 or not gif_out.exists():
            stderr = (proc.stderr or "").strip()
            msg = stderr.splitlines()[0] if stderr else "xyzrender returned non-zero exit status"
            return JSONResponse(
                status_code=500,
                content={
                    "error": "xyzrender failed",
                    "code": "XYZRENDER_FAILED",
                    "message": msg[:300],
                },
            )

        gif_bytes = gif_out.read_bytes()
        if not gif_bytes.startswith(b"GIF"):
            return JSONResponse(
                status_code=500,
                content={
                    "error": "xyzrender produced invalid gif",
                    "code": "XYZRENDER_FAILED",
                    "message": "Output did not contain a GIF header.",
                },
            )

    return Response(
        content=gif_bytes,
        media_type="image/gif",
        headers={"Content-Disposition": f'inline; filename="{key}-denoising.gif"'},
    )

@app.get("/render3d/{mol_id}.svg")
def render3d_svg(mol_id: str):
    key, xyz = _resolve_xyz_text(mol_id)
    return _render_xyz_to_svg_response(key, xyz)


class Render3DFromXYZRequest(BaseModel):
    mol_id: str
    xyz: str


@app.post("/render3d/from-xyz.svg")
def render3d_from_xyz(payload: Render3DFromXYZRequest):
    key = payload.mol_id.replace(".xyz", "").strip() or "molecule"
    xyz = payload.xyz
    if not isinstance(xyz, str) or not xyz.strip():
        return JSONResponse(
            status_code=400,
            content={
                "error": "xyz text is required",
                "code": "XYZ_MISSING",
                "message": "Provide non-empty xyz text in request body.",
            },
        )
    return _render_xyz_to_svg_response(key, xyz)


@app.post("/ase/load")
def ase_load(file: UploadFile = File(...)):
    """
    Upload an ASE SQLite DB file, extract:
      - ids
      - scalar key_value_pairs as columns
      - xyz for each entry (cached to serve via /xyz/<id>.xyz)

    Returns JSON: { ids, columns, meta }
    """
    tmp_path: Path | None = None
    try:
        # Lazy imports: backend can start even if ase not installed (until this endpoint is used)
        from ase.db import connect
        from ase.io import write

        raw = file.file.read()

        tmp_dir = Path(os.environ.get("ASE_TMP", "./_ase_tmp")).resolve()
        tmp_dir.mkdir(parents=True, exist_ok=True)
        safe_name = Path(file.filename or "uploaded.db").name or "uploaded.db"
        tmp_path = tmp_dir / safe_name
        tmp_path.write_bytes(raw)

        db = connect(str(tmp_path))

        ids: list[str] = []
        cols: dict[str, list] = {}

        def _normalize_scalar(v):
            # normalize numpy scalars if present
            if hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:
                    pass
            return v

        def _is_scalar(v):
            return isinstance(v, (str, int, float, bool)) or v is None

        def _json_safe_float(v: object) -> float | None:
            try:
                value = float(v)
            except Exception:
                return None
            return value if math.isfinite(value) else None

        for row in db.select():
            mol_id = str(getattr(row, "name", "") or row.id)
            ids.append(mol_id)

            row_values: dict[str, object] = {}

            # ASE "key_value_pairs"
            kv = getattr(row, "key_value_pairs", {}) or {}
            for k, v in kv.items():
                v = _normalize_scalar(v)
                if _is_scalar(v):
                    row_values[str(k)] = v

            # ASE "data" payload (kept under "data." namespace to avoid collisions)
            data = getattr(row, "data", {}) or {}
            if isinstance(data, dict):
                for k, v in data.items():
                    v = _normalize_scalar(v)
                    if _is_scalar(v):
                        row_values[f"data.{k}"] = v

            # Add newly discovered columns with None for prior rows.
            for k in row_values:
                if k not in cols:
                    cols[k] = [None] * (len(ids) - 1)

            # Append value for every known column to keep row alignment.
            for k in cols:
                cols[k].append(row_values.get(k, None))

            atoms = row.toatoms()
            buf = io.StringIO()
            write(buf, atoms, format="xyz")
            _ase_xyz_store(mol_id, buf.getvalue())

        n = len(ids)

        # infer numeric/categorical columns
        numeric_cols: list[str] = []
        categorical_cols: list[str] = []

        for k, arr in cols.items():
            nn = [v for v in arr if v is not None]
            if not nn:
                categorical_cols.append(k)
                cols[k] = ["" for _ in arr]
                continue

            num_count = sum(
                1 for v in nn if isinstance(v, (int, float)) and not isinstance(v, bool)
            )

            # numeric if >= 90% non-null values are numbers
            if num_count >= max(1, int(0.9 * len(nn))):
                numeric_cols.append(k)
                cols[k] = [_json_safe_float(v) for v in arr]
            else:
                categorical_cols.append(k)
                cols[k] = [("" if v is None else str(v)) for v in arr]

        return JSONResponse(
            {
                "ids": ids,
                "columns": cols,
                "meta": {
                    "numericColumns": numeric_cols,
                    "categoricalColumns": categorical_cols,
                },
            }
        )

    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": "ASE load failed", "message": str(e)},
        )
    finally:
        # The uploaded DB is only needed during ingestion — don't leave it behind.
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass


class LoadCsvFolderPathRequest(BaseModel):
    csv_path: str
    xyz_dir: str


class LoadAsePathRequest(BaseModel):
    db_path: str


class LoadXyzFilePathRequest(BaseModel):
    xyz_path: str


@app.post("/load-path/csv-folder")
def load_csv_folder_from_path(req: LoadCsvFolderPathRequest):
    """Read CSV from a local path and register XYZ files from a local
    directory into the ASE_XYZ cache.
    Returns {csv_content: str, xyz_stems: [str]}.
    """
    csv_path = Path(req.csv_path).expanduser().resolve()
    xyz_dir = Path(req.xyz_dir).expanduser().resolve()

    if not csv_path.is_file():
        raise HTTPException(
            status_code=400, detail=f"CSV file not found: {csv_path}"
        )
    if not xyz_dir.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"XYZ directory not found: {xyz_dir}",
        )

    csv_content = csv_path.read_text(encoding="utf-8")

    xyz_stems: list[str] = []
    for xyz_file in sorted(xyz_dir.glob("*.xyz")):
        stem = xyz_file.stem
        try:
            _ase_xyz_store(stem, xyz_file.read_text(encoding="utf-8"))
            xyz_stems.append(stem)
        except Exception:
            pass

    return JSONResponse(
        {"csv_content": csv_content, "xyz_stems": xyz_stems}
    )


@app.post("/load-path/ase")
def load_ase_from_path(req: LoadAsePathRequest):
    """Load an ASE SQLite DB from a local path (no upload required).
    Same response shape as /ase/load.
    """
    try:
        from ase.db import connect
        from ase.io import write

        db_path = Path(req.db_path).expanduser().resolve()
        if not db_path.is_file():
            raise HTTPException(
                status_code=400,
                detail=f"ASE database not found: {db_path}",
            )

        db = connect(str(db_path))

        ids: list[str] = []
        cols: dict[str, list] = {}

        def _normalize_scalar(v: Any) -> Any:
            if hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:
                    pass
            return v

        def _is_scalar(v: Any) -> bool:
            return (
                isinstance(v, (str, int, float, bool)) or v is None
            )

        def _json_safe_float(v: object) -> float | None:
            try:
                value = float(v)  # type: ignore[arg-type]
            except Exception:
                return None
            return value if math.isfinite(value) else None

        for row in db.select():
            mol_id = str(getattr(row, "name", "") or row.id)
            ids.append(mol_id)

            row_values: dict[str, object] = {}
            kv = getattr(row, "key_value_pairs", {}) or {}
            for k, v in kv.items():
                v = _normalize_scalar(v)
                if _is_scalar(v):
                    row_values[str(k)] = v

            data_payload = getattr(row, "data", {}) or {}
            if isinstance(data_payload, dict):
                for k, v in data_payload.items():
                    v = _normalize_scalar(v)
                    if _is_scalar(v):
                        row_values[f"data.{k}"] = v

            for k in row_values:
                if k not in cols:
                    cols[k] = [None] * (len(ids) - 1)

            for k in cols:
                cols[k].append(row_values.get(k, None))

            atoms = row.toatoms()
            buf = io.StringIO()
            write(buf, atoms, format="xyz")
            _ase_xyz_store(mol_id, buf.getvalue())

        numeric_cols: list[str] = []
        categorical_cols: list[str] = []

        for k, arr in cols.items():
            nn = [v for v in arr if v is not None]
            if not nn:
                categorical_cols.append(k)
                cols[k] = ["" for _ in arr]
                continue
            num_count = sum(
                1
                for v in nn
                if isinstance(v, (int, float))
                and not isinstance(v, bool)
            )
            if num_count >= max(1, int(0.9 * len(nn))):
                numeric_cols.append(k)
                cols[k] = [_json_safe_float(v) for v in arr]
            else:
                categorical_cols.append(k)
                cols[k] = [
                    ("" if v is None else str(v)) for v in arr
                ]

        return JSONResponse(
            {
                "ids": ids,
                "columns": cols,
                "meta": {
                    "numericColumns": numeric_cols,
                    "categoricalColumns": categorical_cols,
                },
            }
        )

    except HTTPException:
        raise
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={
                "error": "ASE path load failed",
                "message": str(e),
            },
        )


@app.post("/load-path/xyz")
def load_xyz_from_path(req: LoadXyzFilePathRequest):
    """Read a single XYZ file from a local path."""
    xyz_path = Path(req.xyz_path).expanduser().resolve()
    if not xyz_path.is_file():
        raise HTTPException(
            status_code=400,
            detail=f"XYZ file not found: {xyz_path}",
        )
    content = xyz_path.read_text(encoding="utf-8")
    return JSONResponse({"content": content, "name": xyz_path.name})


class ToolRunRequest(BaseModel):
    dataset: Dict[str, Any]
    params: Dict[str, Any] = {}


@app.get("/tools")
def list_tools():
    tools, errors = discover_tools()
    return {
        "tools": [t.to_public_dict() for t in tools],
        "errors": errors,
    }


@app.post("/tools/{tool_id}/run")
def run_external_tool(tool_id: str, payload: ToolRunRequest):
    tools, _errors = discover_tools()
    spec = next((t for t in tools if t.id == tool_id), None)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Tool not found: {tool_id}")

    try:
        return run_tool(spec, payload.dataset, payload.params)
    except ToolError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@app.get("/generation/models")
def generation_models():
    return {
        "models_dir": str(GEN_MODELS_DIR),
        "outputs_dir": str(GEN_OUTPUTS_DIR),
        "molcraft_cmd": MOLCRAFT_CMD,
        "models": _discover_generation_models(),
    }


@app.get("/generation/models/{model_id}/reference-scaffold")
def generation_model_reference_scaffold(model_id: str):
    model = _model_by_id(model_id)
    model_dir = Path(model["path"])
    payload = _load_generation_checkpoint(model_dir)
    capabilities = _extract_structure_capabilities(payload)
    scaffold = _reference_scaffold_xyz(payload)
    source = "checkpoint.reference_scaffold"
    # Fall back to edm_stat.pkl when checkpoint is unavailable or missing scaffold
    if scaffold is None:
        stat_path = model_dir / "edm_stat.pkl"
        if stat_path.exists():
            stat_payload = _safe_stats_load(stat_path)
            scaffold = _reference_scaffold_xyz(stat_payload)
            if scaffold is not None:
                source = "stat.reference_scaffold"
                if not capabilities["has_reference_scaffold"]:
                    capabilities = {**capabilities, "has_reference_scaffold": True}
                if not capabilities["reference_freeze_mode"]:
                    fm = _coerce_string(_mapping_get(stat_payload, "reference_freeze_mode"))
                    if fm:
                        capabilities = {**capabilities, "reference_freeze_mode": fm}
    if scaffold is None or not capabilities["has_reference_scaffold"]:
        raise HTTPException(
            status_code=404,
            detail=f"Reference scaffold not found for generation model: {model_id}",
        )
    xyz, atom_count = scaffold
    return {
        "model_id": model_id,
        "model_name": model.get("name") or model_id,
        "source": source,
        "reference_indices": capabilities["reference_indices"],
        "reference_freeze_mode": capabilities["reference_freeze_mode"],
        "atom_count": atom_count,
        "xyz": xyz,
    }


@app.post("/generation/jobs")
def create_generation_job(payload: GenerationJobRequest):
    model = _model_by_id(payload.model_id)
    properties = model.get("properties", [])
    if payload.property_targets:
        if not properties:
            raise HTTPException(
                status_code=400,
                detail=f"Model {model['id']} has no conditional properties",
            )
        valid_props = set(properties)
        bad = [t.name for t in payload.property_targets if t.name not in valid_props]
        if bad:
            raise HTTPException(status_code=400, detail=f"Unknown conditional properties: {', '.join(bad)}")

    structure_cfg, reference_xyz = _validate_structure_guidance(payload, model)
    job_id = uuid.uuid4().hex[:12]
    date_part, time_part = _utc_now_parts()
    run_token = f"{time_part}_{job_id}"
    job_dir = (GEN_OUTPUTS_DIR / payload.model_id / date_part / run_token).resolve()
    _register_job_dir(job_id, job_dir)
    output_dir = job_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    if structure_cfg and reference_xyz:
        input_dir = job_dir / "input"
        input_dir.mkdir(parents=True, exist_ok=True)
        ref_path = input_dir / "reference.xyz"
        ref_path.write_text(reference_xyz, encoding="utf-8")
        ref_path_str = str(ref_path.resolve())
        structure_cfg["reference_xyz_path"] = ref_path_str
        structure_cfg["condition_configs"]["reference_structure_path"] = ref_path_str
        payload.structure_guidance = structure_cfg
    config_path = job_dir / "config.yaml"
    log_path = job_dir / "job.log"

    config = _generation_config(model, payload, output_dir)
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")
    log_path.write_text("", encoding="utf-8")

    cmd = [MOLCRAFT_CMD, "generate", str(config_path.resolve())]
    status = _write_status(
        job_id,
        {
            "job_id": job_id,
            "status": "queued",
            "created_at": _utc_now(),
            "job_key": run_token,
            "model": model,
            "config_path": str(config_path.resolve()),
            "job_dir": str(job_dir.resolve()),
            "output_dir": str(output_dir.resolve()),
            "log_path": str(log_path.resolve()),
            "command": cmd,
            "request": payload.model_dump() if hasattr(payload, "model_dump") else payload.dict(),
            "molecule_count": 0,
        },
    )

    worker = Thread(target=_run_generation_job, args=(job_id, cmd, job_dir, log_path), daemon=True)
    worker.start()
    return status


@app.get("/generation/jobs/{job_id}")
def get_generation_job(job_id: str):
    status = _read_status(job_id)
    job_dir = _job_dir(job_id)
    files = [p.name for p in _generation_xyz_files(job_dir)]
    status["molecule_count"] = len(files)
    status["molecules"] = files
    status["log_tail"] = _log_tail(job_dir)
    return status


@app.get("/generation/jobs/{job_id}/molecules")
def get_generation_molecules(job_id: str):
    _read_status(job_id)
    job_dir = _job_dir(job_id)
    molecules = []
    for path in _generation_xyz_files(job_dir):
        molecules.append(
            {
                "filename": path.name,
                "size": path.stat().st_size,
                "modified_at": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat(),
            }
        )
    return {"job_id": job_id, "molecules": molecules}


@app.get("/generation/jobs/{job_id}/xyz/{filename}", response_class=PlainTextResponse)
def get_generation_xyz(job_id: str, filename: str):
    _read_status(job_id)
    path = _safe_job_file(job_id, filename, ".xyz")
    return path.read_text(encoding="utf-8", errors="replace")


@app.get("/generation/jobs/{job_id}/bundle.zip")
def get_generation_bundle(job_id: str):
    _read_status(job_id)
    job_dir = _job_dir(job_id)
    xyz_files = _generation_xyz_files(job_dir)
    if not xyz_files:
        raise HTTPException(status_code=404, detail="No generated XYZ files are available")

    zip_path = job_dir / "molecules.zip"
    newest = max(p.stat().st_mtime for p in xyz_files)
    if not (zip_path.exists() and zip_path.stat().st_mtime >= newest):
        # Build to a unique temp path then os.replace: concurrent requests
        # never see a half-written zip.
        tmp_zip = job_dir / f"molecules.{uuid.uuid4().hex}.zip.tmp"
        try:
            with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                for path in xyz_files:
                    zf.write(path, arcname=path.name)
            os.replace(tmp_zip, zip_path)
        finally:
            tmp_zip.unlink(missing_ok=True)
    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"{job_id}-xyz.zip",
    )


@app.get("/generation/jobs/{job_id}/svg/{filename}")
def get_generation_svg(job_id: str, filename: str):
    _read_status(job_id)
    path = _safe_job_file(job_id, filename, ".xyz")
    key = path.stem
    xyz = path.read_text(encoding="utf-8", errors="replace")
    return _render_xyz_to_svg_response(key, xyz)


@app.get("/generation/jobs/{job_id}/trajectory/{filename}")
def get_generation_trajectory(job_id: str, filename: str):
    _read_status(job_id)
    clean, trajectory_path = _trajectory_source_for_molecule(job_id, filename)
    return _render_trajectory_to_gif_response(Path(clean).stem, trajectory_path)


@app.delete("/generation/jobs/{job_id}")
def cancel_generation_job(job_id: str):
    status = _read_status(job_id)
    proc = ACTIVE_GENERATION_PROCS.get(job_id)
    if proc is not None and proc.poll() is None:
        proc.terminate()
        with _GEN_STATUS_LOCK:
            _write_status(
                job_id,
                {
                    "status": "cancelled",
                    "finished_at": _utc_now(),
                    "return_code": None,
                    "log_tail": _log_tail(_job_dir(job_id)),
                },
            )
        return _read_status(job_id)
    if status.get("status") in {"queued", "running"}:
        with _GEN_STATUS_LOCK:
            current = _read_status(job_id)
            if current.get("status") not in {"queued", "running"}:
                return current
            return _write_status(job_id, {"status": "cancelled", "finished_at": _utc_now()})
    return status



# -------------------------------------------------------------------
# Import generated molecules into the explorer
# -------------------------------------------------------------------

GENERATED_IMPORT_ROOT = GEN_OUTPUTS_DIR


def _resolve_generated_root(custom: str | None) -> tuple[Path, str | None]:
    """
    Return (effective_root, warning).
    Uses custom path if non-empty and valid; otherwise falls back to GEN_OUTPUTS_DIR.
    """
    if custom and custom.strip():
        p = Path(custom.strip()).resolve()
        if not p.exists():
            return GEN_OUTPUTS_DIR, f"Path does not exist: '{custom.strip()}' — using default outputs directory."
        if not p.is_dir():
            return GEN_OUTPUTS_DIR, f"Path is not a directory: '{custom.strip()}' — using default outputs directory."
        return p, None
    return GEN_OUTPUTS_DIR, None


def _safe_generated_part(value: str, label: str) -> str:
    value = str(value or "").strip()
    if not value:
        raise HTTPException(status_code=400, detail=f"Missing {label}")
    if "/" in value or "\\" in value or value in {".", ".."} or ".." in value:
        raise HTTPException(status_code=400, detail=f"Invalid {label}")
    return value


def _generated_output_dir(model: str, date: str, token: str, root: Path | None = None) -> Path:
    effective_root = root or GENERATED_IMPORT_ROOT
    model = _safe_generated_part(model, "model")
    date = _safe_generated_part(date, "date")
    token = _safe_generated_part(token, "token")

    output_dir = (effective_root / model / date / token / "output").resolve()

    try:
        output_dir.relative_to(effective_root)
    except ValueError:
        raise HTTPException(status_code=400, detail="Generated path escapes root")

    if not output_dir.exists() or not output_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Generated output directory not found: {output_dir}",
        )

    return output_dir


def _generated_xyz_files(output_dir: Path) -> list[Path]:
    return sorted(
        p for p in output_dir.iterdir()
        if p.is_file() and p.suffix.lower() == ".xyz"
    )


def _generated_config_path(output_dir: Path) -> Path | None:
    candidates = [
        output_dir / "config.yaml",
        output_dir.parent / "config.yaml",
    ]
    return next((p for p in candidates if p.exists() and p.is_file()), None)


def _read_generated_config_summary(output_dir: Path) -> dict[str, Any]:
    path = _generated_config_path(output_dir)
    if path is None:
        return {}

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}

    def dig(*keys: str):
        cur: Any = raw
        for key in keys:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(key)
        return cur

    out = {
        "num_generate": raw.get("num_generate") or dig("interference", "num_generate"),
        "batch_size": raw.get("batch_size") or dig("interference", "batch_size"),
        "n_frames": raw.get("n_frames") or dig("interference", "n_frames"),
        "diffusion_steps": raw.get("diffusion_steps") or dig("diffusion_steps"),
        "seed": raw.get("seed") or dig("interference", "seed"),
        "max_mol_size": raw.get("max_mol_size") or dig("interference", "max_mol_size"),
    }

    return {k: v for k, v in out.items() if v is not None}


@app.get("/generated/tree")
def generated_tree(root: str = Query(default="")):
    """
    Browse generated molecule folders under root/model/date/token/output/*.xyz.
    root defaults to MOLCRAFT_OUTPUTS_DIR; pass ?root=<path> to override.
    """
    effective_root, root_warning = _resolve_generated_root(root)
    models: list[dict[str, Any]] = []

    if not effective_root.exists():
        return {
            "root": str(effective_root),
            "default_root": str(GEN_OUTPUTS_DIR),
            "root_warning": root_warning,
            "exists": False,
            "models": [],
        }

    for model_dir in sorted(p for p in effective_root.iterdir() if p.is_dir()):
        model_item: dict[str, Any] = {
            "name": model_dir.name,
            "dates": [],
        }

        for date_dir in sorted(p for p in model_dir.iterdir() if p.is_dir()):
            date_item: dict[str, Any] = {
                "name": date_dir.name,
                "runs": [],
            }

            for token_dir in sorted(p for p in date_dir.iterdir() if p.is_dir()):
                output_dir = token_dir / "output"
                if not output_dir.exists() or not output_dir.is_dir():
                    continue

                xyz_files = _generated_xyz_files(output_dir)
                if not xyz_files:
                    continue

                date_item["runs"].append(
                    {
                        "name": token_dir.name,
                        "molecule_count": len(xyz_files),
                        "config": _read_generated_config_summary(output_dir),
                    }
                )

            if date_item["runs"]:
                model_item["dates"].append(date_item)

        if model_item["dates"]:
            models.append(model_item)

    return {
        "root": str(effective_root),
        "default_root": str(GEN_OUTPUTS_DIR),
        "root_warning": root_warning,
        "exists": True,
        "models": models,
    }


class GeneratedLoadRequest(BaseModel):
    model: str
    date: str
    token: str
    prefix: str = Field(default="molGen")
    root: str = ""


@app.post("/generated/load")
def generated_load(payload: GeneratedLoadRequest):
    effective_root, _ = _resolve_generated_root(payload.root)
    output_dir = _generated_output_dir(payload.model, payload.date, payload.token, effective_root)
    xyz_files = _generated_xyz_files(output_dir)

    if not xyz_files:
        raise HTTPException(
            status_code=404,
            detail="No XYZ files found in generated output directory",
        )

    prefix = str(payload.prefix or "").strip()
    if not prefix:
        prefix = "molGen"

    ids: list[str] = []
    xyz_by_id: dict[str, str] = {}

    for path in xyz_files:
        stem = path.stem
        mol_id = f"{prefix}_{stem}"
        ids.append(mol_id)
        xyz_by_id[mol_id] = path.read_text(encoding="utf-8", errors="replace")

    return {
        "ids": ids,
        "columns": {},
        "meta": {
            "numericColumns": [],
            "categoricalColumns": [],
        },
        "xyzById": xyz_by_id,
        "config": _read_generated_config_summary(output_dir),
        "files": [p.name for p in xyz_files],
    }

class ExportAseRequest(BaseModel):
    ids: list[str]
    columns: Dict[str, list[Any]]
    xyzById: Dict[str, str]
    filename: str = "export.db"


@app.post("/export/ase")
def export_ase(payload: ExportAseRequest):
    try:
        from ase.io import read
        from ase.db import connect
        from ase.db.core import convert_str_to_int_float_bool_or_str
        import math

        def clean_scalar(v):
            if v is None:
                return None
            if isinstance(v, bool):
                return v
            if isinstance(v, int):
                return v
            if isinstance(v, float):
                if not math.isfinite(v):
                    return None
                return v
            if isinstance(v, str):
                s = v.strip()
                if s == "":
                    return None
                lowered = s.lower()
                if lowered == "true":
                    return True
                if lowered == "false":
                    return False
                try:
                    if s.isdigit() or (
                        s[0] in {"+", "-"} and len(s) > 1 and s[1:].isdigit()
                    ):
                        return int(s)
                except Exception:
                    pass
                try:
                    f = float(s)
                    if math.isfinite(f):
                        return f
                except Exception:
                    pass
                return v
            return clean_scalar(str(v))

        def safe_ase_string(s: str) -> str:
            """Return a string that ASE won't reject as numeric-like text."""
            t = str(s).strip()
            if t == "":
                return "unknown"
            lowered = t.lower()
            if lowered in {"true", "false"}:
                return f"str_{t}"
            if t.isdigit() or (
                t[0] in {"+", "-"} and len(t) > 1 and t[1:].isdigit()
            ):
                return f"str_{t}"
            try:
                float(t)
                return f"str_{t}"
            except Exception:
                return t

        def force_non_numeric_string(v: str) -> str:
            t = str(v).strip()
            if t == "":
                return "str_empty"
            if t.startswith("str_"):
                return t
            return f"str_{t}"

        def final_ase_safe_scalar(v: Any):
            val = clean_scalar(v)
            if val is None:
                return None
            if isinstance(val, str):
                converted = convert_str_to_int_float_bool_or_str(val.strip())
                if isinstance(converted, str):
                    return converted
                if isinstance(converted, float) and not math.isfinite(converted):
                    return None
                return converted
            return val

        with tempfile.TemporaryDirectory(prefix="molcraft_export_") as td:
            db_path = Path(td) / "export.db"
            db = connect(str(db_path))
            written_rows = 0
            missing_xyz_ids: list[str] = []

            for i, mol_id in enumerate(payload.ids):
                xyz = payload.xyzById.get(mol_id)
                if not xyz:
                    missing_xyz_ids.append(str(mol_id))
                    continue

                atoms = read(io.StringIO(xyz), format="xyz")

                kv: dict[str, Any] = {"name": safe_ase_string(mol_id)}

                for col_name, values in payload.columns.items():
                    if i >= len(values):
                        continue
                    val = final_ase_safe_scalar(values[i])
                    if val is not None:
                        safe_key = re.sub(r"[^a-zA-Z0-9_]", "_", str(col_name))
                        if safe_key and safe_key[0].isdigit():
                            safe_key = "_" + safe_key
                        kv[safe_key] = val

                try:
                    db.write(atoms, key_value_pairs=kv)
                except ValueError as write_err:
                    msg = str(write_err)
                    if "is put in as string" not in msg:
                        raise
                    # Last-resort: keep all string fields, but make them
                    # unambiguously non-numeric for ASE validation.
                    retry_kv: dict[str, Any] = {}
                    for key, value in kv.items():
                        if isinstance(value, str):
                            retry_kv[key] = force_non_numeric_string(value)
                        else:
                            retry_kv[key] = value
                    db.write(atoms, key_value_pairs=retry_kv)
                written_rows += 1

            if written_rows == 0:
                examples = ", ".join(missing_xyz_ids[:5])
                extra = f" Examples: {examples}" if examples else ""
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "ASE export failed",
                        "message": (
                            "No molecules with XYZ coordinates were available for ASE export. "
                            f"Received {len(payload.ids)} selected IDs and {len(payload.xyzById)} XYZ records."
                            f"{extra}"
                        ),
                        "selected": len(payload.ids),
                        "xyzRecords": len(payload.xyzById),
                        "missingXyz": len(missing_xyz_ids),
                    },
                )

            if not db_path.exists():
                raise RuntimeError(
                    f"ASE database was not created after writing {written_rows} rows: {db_path}"
                )

            data = db_path.read_bytes()

        filename = Path(payload.filename or "export.db").name
        if not filename.lower().endswith(".db"):
            filename += ".db"

        return Response(
            content=data,
            media_type="application/octet-stream",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    except Exception as e:
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"error": "ASE export failed", "message": str(e)},
        )


# -------------------------------------------------------------------
# Analysis tools: MolCraftDiffusion analyze wrappers
# -------------------------------------------------------------------

ANALYSIS_WORK_DIR = Path(
    os.environ.get("MOLCRAFT_ANALYSIS_WORK_DIR", REPO_ROOT / "analysis_jobs")
).resolve()
ANALYSIS_WORK_DIR.mkdir(parents=True, exist_ok=True)
ACTIVE_ANALYSIS_PROCS: Dict[str, subprocess.Popen] = {}
ANALYSIS_QUEUE: list[str] = []
# job_id -> tool_id; the (possibly huge) payload is spilled to
# <job_dir>/payload.json instead of being held in memory while queued.
ANALYSIS_QUEUE_PAYLOADS: dict[str, str] = {}
ANALYSIS_QUEUE_CONDITION = Condition()
ANALYSIS_QUEUE_WORKER_STARTED = False
ANALYSIS_BACKEND_VERSION = "analysis_outputs_v4"


class AnalysisToolRunRequest(BaseModel):
    dataset: Dict[str, Any]
    dataset_origin: str = Field(default="")
    params: Dict[str, Any] = {}


ANALYSIS_TOOLS: dict[str, dict[str, Any]] = {
    "validity_connectivity": {
        "id": "validity_connectivity",
        "name": "Validity and connectivity metrics",
        "description": "Compute structural validity/connectivity metrics (core/posebuster/geom).",
        "mode": "columns",
        "inputs": [
            {
                "key": "metrics",
                "label": "Metric set",
                "type": "select",
                "default": "posebuster",
                "required": True,
                "options": ["core", "posebuster", "geom_revised"],
            },
            {
                "key": "recheck_topo",
                "label": "Recheck topology with RDKit",
                "type": "boolean",
                "default": False,
            },
            {
                "key": "check_strain",
                "label": "Check strain via XTB optimization",
                "type": "boolean",
                "default": False,
            },
            {
                "key": "mol_converter",
                "label": "Molecule converter",
                "type": "select",
                "default": "xyz2mol",
                "options": ["xyz2mol", "rdkit"],
            },
        ],
        "output": {"kind": "add_columns"},
    },
    "xyz_to_smiles": {
        "id": "xyz_to_smiles",
        "name": "XYZ to SMILES conversion",
        "description": "Convert XYZ to SMILES and fingerprints/scaffold-derived columns.",
        "mode": "columns",
        "inputs": [
            {
                "key": "bits",
                "label": "Morgan fingerprint bits",
                "type": "integer",
                "default": 2048,
                "required": True,
            }
        ],
        "output": {"kind": "add_columns"},
    },
    "xtb_electronic_properties": {
        "id": "xtb_electronic_properties",
        "name": "XTB electronic properties",
        "description": "Compute XTB electronic descriptors (energy/dipole/reactivity/etc.).",
        "mode": "columns",
        "inputs": [
            {
                "key": "method",
                "label": "XTB method",
                "type": "select",
                "default": "2",
                "required": True,
                "options": [
                    {"value": "1", "label": "GFN1-xTB"},
                    {"value": "2", "label": "GFN2-xTB"},
                    {"value": "ptb", "label": "PTB"},
                ],
            },
            {"key": "charge", "label": "Charge", "type": "integer", "default": 0},
            {"key": "n_unpaired", "label": "Unpaired electrons", "type": "integer", "default": 0},
            {"key": "solvent", "label": "Solvent", "type": "string", "default": ""},
            {
                "key": "properties",
                "label": "Property group",
                "type": "select",
                "default": "energy",
                "required": True,
                "options": ["energy", "dipole", "reactivity", "global", "charges", "fukui", "bond_orders", "all"],
            },
            {"key": "timeout", "label": "Timeout per molecule, seconds", "type": "integer", "default": 120},
            {"key": "n_jobs", "label": "Parallel jobs", "type": "integer", "default": 1},
            {"key": "corrected", "label": "Apply empirical IP/EA correction", "type": "boolean", "default": True},
        ],
        "output": {"kind": "add_columns"},
    },
    "featurize": {
        "id": "featurize",
        "name": "Featurize",
        "description": "Generate fixed-size molecular vectors (SOAP/UMA/fingerprints) for downstream ML.",
        "mode": "columns",
        "inputs": [
            {"key": "backend", "label": "Backend", "type": "select", "default": "soap", "options": ["soap", "uma", "fingerprint"]},
            {"key": "autodetect", "label": "Auto-detect species", "type": "boolean", "default": True},
            {"key": "r_cut", "label": "SOAP r_cut", "type": "float", "default": 6.0},
            {"key": "n_max", "label": "SOAP n_max", "type": "integer", "default": 8},
            {"key": "l_max", "label": "SOAP l_max", "type": "integer", "default": 6},
            {"key": "sigma", "label": "SOAP sigma", "type": "float", "default": 0.1},
            {"key": "pooling", "label": "Pooling", "type": "select", "default": "mean", "options": ["mean", "sum"]},
            {
                "key": "model_path",
                "label": "UMA model path",
                "type": "string",
                "default": "",
                "help": "Optional path to a local UMA checkpoint/model. Relative paths are resolved from the repository root.",
            },
            {"key": "device", "label": "UMA device", "type": "select", "default": "cpu", "options": ["auto", "cpu", "cuda"]},
            {"key": "batch_size", "label": "UMA batch size", "type": "integer", "default": 8},
            {
                "key": "smiles_column",
                "label": "SMILES column",
                "type": "select",
                "default": "",
                "required": True,
                "options": [],
                "optionsSource": "smiles_columns",
            },
            {"key": "fp_radius", "label": "Morgan radius", "type": "integer", "default": 2},
            {"key": "fp_bits", "label": "Morgan bits", "type": "integer", "default": 2048},
            {"key": "fp_use_chirality", "label": "Use chirality", "type": "boolean", "default": False},
            {"key": "fp_use_features", "label": "Use feature invariants", "type": "boolean", "default": False},
        ],
        "output": {"kind": "add_columns"},
    },
    "dimensionality_reduction": {
        "id": "dimensionality_reduction",
        "name": "Dimensionality reduction",
        "description": "Project molecular vectors to two numeric coordinates with t-SNE or UMAP.",
        "mode": "columns",
        "requires_xyz": False,
        "inputs": [
            {
                "key": "vector_column",
                "label": "Vector column",
                "type": "select",
                "default": "",
                "required": True,
                "options": [],
                "optionsSource": "vector_columns",
            },
            {
                "key": "algorithm",
                "label": "Algorithm",
                "type": "select",
                "default": "umap",
                "required": True,
                "options": [
                    {"value": "umap", "label": "UMAP"},
                    {"value": "tsne", "label": "t-SNE"},
                ],
            },
            {
                "key": "device",
                "label": "t-SNE device",
                "type": "select",
                "default": "cpu",
                "options": [
                    {"value": "cpu", "label": "CPU (openTSNE)"},
                    {"value": "cuda", "label": "CUDA (tsne-cuda)"},
                ],
            },
            {"key": "cuda_device", "label": "CUDA device", "type": "integer", "default": 0},
            {"key": "metric", "label": "Metric", "type": "select", "default": "euclidean", "options": ["euclidean", "cosine", "manhattan"]},
            {"key": "random_state", "label": "Random seed", "type": "integer", "default": 42},
            {"key": "perplexity", "label": "t-SNE perplexity", "type": "float", "default": 30.0},
            {"key": "tsne_learning_rate", "label": "t-SNE learning rate", "type": "float", "default": 200.0},
            {"key": "n_iter", "label": "t-SNE iterations", "type": "integer", "default": 1000},
            {"key": "early_exaggeration", "label": "t-SNE early exaggeration", "type": "float", "default": 12.0},
            {"key": "theta", "label": "t-SNE theta", "type": "float", "default": 0.5},
            {
                "key": "initialization",
                "label": "Initialization",
                "type": "select",
                "default": "pca",
                "options": [
                    {"value": "pca", "label": "PCA"},
                    {"value": "random", "label": "Random"},
                    {"value": "spectral", "label": "Spectral"},
                ],
            },
            {"key": "n_jobs", "label": "Parallel jobs", "type": "integer", "default": 1},
            {"key": "n_neighbors", "label": "UMAP neighbors", "type": "integer", "default": 15},
            {"key": "min_dist", "label": "UMAP min distance", "type": "float", "default": 0.1},
            {"key": "n_epochs", "label": "UMAP epochs", "type": "integer", "default": 0},
            {"key": "umap_learning_rate", "label": "UMAP learning rate", "type": "float", "default": 1.0},
            {"key": "spread", "label": "UMAP spread", "type": "float", "default": 1.0},
            {"key": "low_memory", "label": "UMAP low memory", "type": "boolean", "default": True},
        ],
        "output": {"kind": "add_columns"},
    },
    "predict_properties": {
        "id": "predict_properties",
        "name": "Predict properties",
        "description": (
            "Run MolCraftDiff property prediction from a selected checkpoint."
        ),
        "mode": "columns",
        "inputs": [
            {
                "key": "model_id",
                "label": "Predictive model",
                "type": "select",
                "default": "",
                "required": True,
                "options": [],
            },
        ],
        "output": {"kind": "add_columns"},
    },
    "xtb_geometry_optimization": {
        "id": "xtb_geometry_optimization",
        "name": "XTB Geometry Optimization",
        "description": "Optimize XYZ geometry (GFN/MMFF) and replace XYZ by molecule ID.",
        "mode": "replace_xyz",
        "inputs": [
            {
                "key": "level",
                "label": "Optimization level",
                "type": "select",
                "default": "gfn2",
                "required": True,
                "options": ["gfn1", "gfn2", "gfn-ff", "mmff94"],
            },
            {"key": "charge", "label": "Charge", "type": "integer", "default": 0},
            {"key": "timeout", "label": "Timeout per molecule, seconds", "type": "integer", "default": 240},
            {"key": "scale_factor", "label": "Covalent radii scale factor", "type": "float", "default": 1.3},
        ],
        "output": {"kind": "replace_xyz"},
    },
}


def _analysis_public_tool(tool: dict[str, Any]) -> dict[str, Any]:
    public_inputs = [dict(input_spec) for input_spec in tool.get("inputs", [])]
    metadata: dict[str, Any] = {}
    if tool.get("id") == "predict_properties":
        models = _discover_predict_models()
        metadata["models"] = models
        model_options = [
            {
                "value": model["id"],
                "label": f"{model['name']} ({model['type']})",
            }
            for model in models
        ]
        for input_spec in public_inputs:
            if input_spec.get("key") == "model_id":
                input_spec["options"] = model_options
                if model_options:
                    input_spec["default"] = model_options[0]["value"]
    return {
        "id": tool["id"],
        "name": tool["name"],
        "description": tool.get("description", ""),
        "inputs": public_inputs,
        "output": tool.get("output", {}),
        "mode": tool.get("mode"),
        "requires_xyz": tool.get("requires_xyz", True),
        "metadata": metadata,
    }


@app.get("/analysis-tools")
def list_analysis_tools():
    return {
        "tools": [_analysis_public_tool(t) for t in ANALYSIS_TOOLS.values()],
        "work_dir": str(ANALYSIS_WORK_DIR),
        "molcraft_cmd": MOLCRAFT_CMD,
        "backend_version": ANALYSIS_BACKEND_VERSION,
        "predict_models_dir": str(PREDICT_MODELS_DIR),
        "predict_config": str(PREDICT_CONFIG_PATH),
    }


def _analysis_plain_columns(dataset: dict[str, Any]) -> dict[str, list[Any]]:
    cols = dataset.get("columns", {}) or {}
    out: dict[str, list[Any]] = {}
    for name, values in cols.items():
        if isinstance(values, list):
            out[str(name)] = values
        else:
            try:
                out[str(name)] = list(values)
            except Exception:
                out[str(name)] = []
    return out


def _analysis_dataset_rows_for_origin(dataset: dict[str, Any], dataset_origin: str) -> list[tuple[int, str]]:
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    columns = _analysis_plain_columns(dataset)
    data_source = columns.get("data_source")
    if not ids:
        raise HTTPException(status_code=400, detail="Dataset has no ids")
    if not data_source:
        raise HTTPException(status_code=400, detail="Dataset is missing required data_source column")

    origin = str(dataset_origin or "").strip()
    if not origin:
        # Empty origin means "all molecules" — skip data_source filtering.
        return list(enumerate(ids))

    rows = [(i, mol_id) for i, mol_id in enumerate(ids) if i < len(data_source) and str(data_source[i]) == origin]
    if not rows:
        raise HTTPException(status_code=400, detail=f"No molecules found for data_source={origin!r}")
    return rows


def _analysis_value_is_true(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value) and str(value).lower() != "nan"
    text = str(value).strip().lower()
    return text in {"true", "1", "yes", "y", "pass", "passed", "valid", "connected", "ok"}


def _analysis_validity_columns(dataset: dict[str, Any]) -> list[str]:
    columns = _analysis_plain_columns(dataset)
    out: list[str] = []
    for name in columns:
        low = name.lower()
        if any(token in low for token in ["valid", "connect", "stable", "posebuster", "geom"]):
            values = columns[name]
            non_empty = [v for v in values if v is not None and str(v).strip() != ""]
            if non_empty and all(str(v).strip().lower() in {"true", "false", "1", "0", "yes", "no", "pass", "fail", "passed", "valid", "invalid", "connected", "ok"} for v in non_empty[:100]):
                out.append(name)
    return out


def _analysis_filter_optimization_rows(dataset: dict[str, Any], rows: list[tuple[int, str]]) -> tuple[list[tuple[int, str]], list[str], list[str]]:
    columns = _analysis_plain_columns(dataset)
    check_cols = _analysis_validity_columns(dataset)
    if not check_cols:
        return [], [], ["No validity/connectivity boolean columns were found. Run Validity and connectivity metrics first."]

    eligible: list[tuple[int, str]] = []
    skipped: list[str] = []
    for row_idx, mol_id in rows:
        ok = True
        for col in check_cols:
            values = columns.get(col, [])
            value = values[row_idx] if row_idx < len(values) else None
            if not _analysis_value_is_true(value):
                ok = False
                break
        if ok:
            eligible.append((row_idx, mol_id))
        else:
            skipped.append(mol_id)
    return eligible, skipped, check_cols


def _analysis_safe_stem(mol_id: str, idx: int) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(mol_id)).strip("._")
    if not cleaned:
        cleaned = "molecule"
    return f"mol_{idx:06d}__{cleaned}"


def _analysis_stage_xyz(dataset: dict[str, Any], rows: list[tuple[int, str]], xyz_dir: Path) -> dict[str, str]:
    xyz_by_id = dataset.get("xyzById", {}) or {}
    if not isinstance(xyz_by_id, dict):
        raise HTTPException(status_code=400, detail="dataset.xyzById must be an object")

    xyz_dir.mkdir(parents=True, exist_ok=True)
    stem_to_id: dict[str, str] = {}
    missing: list[str] = []
    for out_idx, (_row_idx, mol_id) in enumerate(rows):
        xyz = xyz_by_id.get(mol_id)
        if not isinstance(xyz, str) or not xyz.strip():
            missing.append(mol_id)
            continue
        stem = _analysis_safe_stem(mol_id, out_idx)
        (xyz_dir / f"{stem}.xyz").write_text(xyz, encoding="utf-8")
        stem_to_id[stem] = mol_id

    if not stem_to_id:
        raise HTTPException(status_code=400, detail="No XYZ content was available for selected molecules")
    return stem_to_id


def _analysis_run_command(
    cmd: list[str],
    job_dir: Path,
    timeout: int | None = None,
    job_id: str | None = None,
) -> tuple[int, str]:
    log_path = job_dir / "job.log"
    command_text = " ".join(str(x) for x in cmd)
    proc: subprocess.Popen | None = None
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log_fh:
            log_fh.write(f"$ {command_text}\n\n")
            log_fh.flush()
            # Write straight to the log file: live tailing keeps working and
            # proc.wait(timeout=...) is not defeated by an EOF drain loop.
            proc = subprocess.Popen(
                cmd,
                cwd=str(REPO_ROOT),
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
            )
            if job_id:
                ACTIVE_ANALYSIS_PROCS[job_id] = proc

            return_code = proc.wait(timeout=timeout)
            log_fh.write(f"\nRETURN CODE: {return_code}\n")
            log_fh.flush()
    except subprocess.TimeoutExpired as exc:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=8)
            except Exception:
                proc.kill()
                proc.wait()
        with log_path.open("a", encoding="utf-8", errors="replace") as log_fh:
            log_fh.write("\nTIMEOUT\n")
            log_fh.flush()
        raise HTTPException(status_code=500, detail="Analysis command timed out")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to run analysis command: {exc}")
    finally:
        if job_id:
            ACTIVE_ANALYSIS_PROCS.pop(job_id, None)

    log_text = log_path.read_text(encoding="utf-8", errors="replace")
    return return_code, log_text

def _analysis_first_existing_csv(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists() and path.is_file() and path.suffix.lower() == ".csv":
            return path
    return None


def _analysis_find_csv(job_dir: Path, tool_id: str, xyz_dir: Path) -> Path | None:
    candidates = [
        job_dir / f"{tool_id}.csv",
        job_dir / "results.csv",
        xyz_dir / "metrics.csv",
        xyz_dir / "features.csv",
        xyz_dir / "2d_reprs" / "smiles_processed.csv",
    ]
    found = _analysis_first_existing_csv(candidates)
    if found:
        return found
    csvs = sorted(job_dir.rglob("*.csv")) + sorted(xyz_dir.rglob("*.csv"))
    return csvs[0] if csvs else None


def _analysis_csv_fieldnames(path: Path) -> list[str]:
    import csv

    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        return [str(name) for name in (reader.fieldnames or [])]


def _analysis_resolve_validity_filter_csv(
    params: dict[str, Any],
) -> tuple[Path | None, str | None]:
    filter_job_id = str(params.get("filter_csv_job_id") or "").strip()
    filter_column = str(params.get("filter_column") or "").strip()
    if not filter_job_id and not filter_column:
        return None, None
    if not filter_job_id or not filter_column:
        raise HTTPException(
            status_code=400,
            detail=(
                "Both filter_csv_job_id and filter_column are required for "
                "CSV-backed optimization filtering."
            ),
        )

    status = _analysis_read_job_status(filter_job_id)
    if status.get("status") != "completed":
        raise HTTPException(
            status_code=400,
            detail=f"Filter CSV job {filter_job_id} is not completed.",
        )
    if status.get("tool_id") != "validity_connectivity":
        raise HTTPException(
            status_code=400,
            detail=f"Filter CSV job {filter_job_id} is not a Validity and connectivity metrics job.",
        )

    filter_job_dir = _analysis_job_dir(filter_job_id)
    filter_xyz_dir = filter_job_dir / "input_xyz"
    csv_path = _analysis_find_csv(
        filter_job_dir,
        "validity_connectivity",
        filter_xyz_dir,
    )
    if csv_path is None:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Filter CSV job {filter_job_id} has no discoverable "
                "validity/connectivity CSV output."
            ),
        )

    fieldnames = _analysis_csv_fieldnames(csv_path)
    if filter_column not in fieldnames:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Filter column {filter_column!r} was not found in validity CSV "
                f"for job {filter_job_id}. Available columns: {', '.join(fieldnames) or '(none)'}"
            ),
        )
    return csv_path, filter_column


def _analysis_read_csv_rows(path: Path) -> list[dict[str, str]]:
    import csv

    with path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
        return list(csv.DictReader(fh))


def _analysis_norm_csv_stem(value: Any) -> str:
    text = Path(str(value or "").strip()).name
    if text.lower().endswith(".xyz"):
        text = text[:-4]
    return text


def _analysis_csv_row_id(
    row: dict[str, Any],
    stem_to_id: dict[str, str],
    fallback_index: int,
    allow_order_fallback: bool = False,
) -> tuple[str | None, str]:
    """Map one output CSV row back to the original dataset molecule id.

    Prefer explicit file/id columns from the CSV. Row-order fallback is risky
    because some MolCraftDiffusion outputs omit failed molecules or reorder rows;
    therefore it is only allowed by callers when the CSV row count exactly
    matches the staged XYZ count.
    """
    candidate_keys = [
        "id",
        "mol_id",
        "molecule_id",
        "name",
        "filename",
        "file",
        "xyz_file",
        "xyz_path",
        "xyz",
        "path",
        "source_file",
        "source",
    ]
    staged_ids = set(stem_to_id.values())
    for key in candidate_keys:
        if key in row and str(row.get(key, "")).strip():
            stem = _analysis_norm_csv_stem(row[key])
            if stem in stem_to_id:
                return stem_to_id[stem], f"explicit:{key}"
            raw = str(row[key]).strip()
            if raw in staged_ids:
                return raw, f"explicit_dataset_id:{key}"
    if allow_order_fallback and fallback_index < len(stem_to_id):
        return list(stem_to_id.values())[fallback_index], "row_order_fallback"
    return None, "unmapped"


def _analysis_parse_scalar(value: Any) -> tuple[str, Any]:
    if value is None:
        return "categorical", None
    text = str(value).strip()
    if text == "" or text.lower() in {"nan", "none", "null"}:
        return "categorical", None
    low = text.lower()
    if low in {"true", "false"}:
        return "categorical", low
    try:
        num = float(text)
        return "numeric", num
    except Exception:
        return "categorical", text


def _analysis_parse_vector(value: Any) -> list[float] | None:
    """
    Parse vector-like CSV cells from MolCraftDiffusion outputs.

    Examples accepted:
      tensor([0.1, 0.2])
      tensor([[0.1, 0.2]])
      array([0.1, 0.2])
      [0.1, 0.2]
      [0.1 0.2]

    Scalars deliberately return None so they remain normal visible columns.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None

    low = text.lower()
    looks_vector = (
        low.startswith("tensor(")
        or low.startswith("array(")
        or low.startswith("np.array(")
        or (text.startswith("[") and text.endswith("]"))
    )
    if not looks_vector:
        return None

    # Strip common wrappers while preserving the bracketed payload.
    inner = text
    for prefix_text in ("tensor", "array", "np.array"):
        if inner.lower().startswith(prefix_text + "(") and inner.endswith(")"):
            inner = inner[len(prefix_text) + 1 : -1].strip()
            break

    # Remove torch/numpy dtype/device suffixes when present.
    inner = re.sub(r",\s*dtype\s*=\s*[^,)]+", "", inner)
    inner = re.sub(r",\s*device\s*=\s*[^,)]+", "", inner)

    # Extract all numeric tokens. This handles nested vectors and space-separated lists.
    nums = re.findall(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?", inner)
    if len(nums) < 2:
        return None

    try:
        vec = [float(x) for x in nums]
    except Exception:
        return None

    if not vec or not all(v == v and abs(v) != float("inf") for v in vec):
        return None
    return vec


def _analysis_unique_output_name(base_name: str, used_names: set[str], prefix: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(base_name).strip()).strip("._")
    if not clean:
        clean = "analysis_output"
    name = clean if clean not in used_names else f"{prefix}_{clean}"
    if name not in used_names:
        used_names.add(name)
        return name
    k = 2
    candidate = f"{name}_{k}"
    while candidate in used_names:
        k += 1
        candidate = f"{name}_{k}"
    used_names.add(candidate)
    return candidate


def _analysis_atom_count_from_xyz_text(xyz_text: Any) -> int | None:
    if not isinstance(xyz_text, str):
        return None
    first = xyz_text.strip().splitlines()[0:1]
    if not first:
        return None
    try:
        n = int(first[0].strip())
    except Exception:
        return None
    return n if n > 0 else None


def _analysis_xyz_line_count(xyz_text: Any) -> int | None:
    if not isinstance(xyz_text, str) or not xyz_text.strip():
        return None
    return len(xyz_text.strip().splitlines())


def _analysis_xyz_declared_atom_count(xyz_text: Any) -> int | None:
    if not isinstance(xyz_text, str):
        return None
    lines = xyz_text.strip().splitlines()
    if not lines:
        return None
    try:
        return int(lines[0].strip())
    except Exception:
        return None


def _analysis_xyz_basic_validity(xyz_text: Any) -> str:
    """Very small XYZ sanity check for diagnostics only.

    This does not validate chemistry. It only checks whether the text looks like
    an XYZ file with a positive first-line atom count and enough atom rows.
    """
    if not isinstance(xyz_text, str) or not xyz_text.strip():
        return "false"
    lines = xyz_text.strip().splitlines()
    n_atoms = _analysis_xyz_declared_atom_count(xyz_text)
    if n_atoms is None or n_atoms <= 0:
        return "false"
    if len(lines) < n_atoms + 2:
        return "false"
    for line in lines[2 : 2 + n_atoms]:
        parts = line.split()
        if len(parts) < 4:
            return "false"
        try:
            float(parts[1]); float(parts[2]); float(parts[3])
        except Exception:
            return "false"
    return "true"


def _analysis_staged_xyz_diagnostic_columns(
    dataset: dict[str, Any],
    stem_to_id: dict[str, str],
    prefix: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Add debug columns showing exactly what the backend staged for analysis.

    These columns help distinguish app-side staging/mapping issues from
    MolCraftDiffusion chemistry/conversion failures. They are added only for
    molecules processed by the current analysis run; other rows remain null.
    """
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    id_to_index = {mol_id: i for i, mol_id in enumerate(ids)}
    xyz_by_id = dataset.get("xyzById", {}) or {}

    used_names = set((_analysis_plain_columns(dataset)).keys())
    used_names |= set((dataset.get("descriptors", {}) or {}).keys())
    used_names |= set((dataset.get("molecularVectors", {}) or {}).keys())
    used_names |= set((dataset.get("atomProperties", {}) or {}).keys())

    atom_count_name = _analysis_unique_output_name("analysis_staged_atom_count", used_names, prefix)
    line_count_name = _analysis_unique_output_name("analysis_staged_xyz_lines", used_names, prefix)
    valid_name = _analysis_unique_output_name("analysis_staged_xyz_valid", used_names, prefix)
    filename_name = _analysis_unique_output_name("analysis_staged_filename", used_names, prefix)

    atom_counts: list[Any] = [None] * len(ids)
    line_counts: list[Any] = [None] * len(ids)
    valid_values: list[Any] = [None] * len(ids)
    filenames: list[Any] = [None] * len(ids)

    invalid_ids: list[str] = []
    zero_or_missing_count_ids: list[str] = []

    for stem, mol_id in stem_to_id.items():
        idx = id_to_index.get(mol_id)
        if idx is None:
            continue
        xyz = xyz_by_id.get(mol_id)
        declared = _analysis_xyz_declared_atom_count(xyz)
        atom_counts[idx] = declared
        line_counts[idx] = _analysis_xyz_line_count(xyz)
        valid = _analysis_xyz_basic_validity(xyz)
        valid_values[idx] = valid
        filenames[idx] = f"{stem}.xyz"
        if declared is None or declared <= 0:
            zero_or_missing_count_ids.append(mol_id)
        if valid != "true":
            invalid_ids.append(mol_id)

    columns = [
        {"name": atom_count_name, "kind": "numeric", "values": atom_counts},
        {"name": line_count_name, "kind": "numeric", "values": line_counts},
        {"name": valid_name, "kind": "categorical", "values": valid_values},
        {"name": filename_name, "kind": "categorical", "values": filenames},
    ]
    stats = {
        "stagedDebugColumnsAdded": len(columns),
        "stagedInvalidXyzCount": len(invalid_ids),
        "stagedZeroOrMissingAtomCount": len(zero_or_missing_count_ids),
    }
    if invalid_ids:
        stats["stagedInvalidXyzExamples"] = ", ".join(invalid_ids[:5])
    if zero_or_missing_count_ids:
        stats["stagedZeroOrMissingAtomCountExamples"] = ", ".join(zero_or_missing_count_ids[:5])
    return columns, stats


def _analysis_outputs_from_csv(
    dataset: dict[str, Any],
    csv_path: Path,
    stem_to_id: dict[str, str],
    prefix: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """
    Convert MolCraftDiffusion CSV output into app-native outputs.

    Classification rules:
      - scalar numeric/string/bool cells -> addColumns
      - fixed-length numeric vectors -> addDescriptors
      - variable-length numeric vectors where len(vector) == n_atoms for every molecule -> addAtomProperties
      - other variable-length numeric vectors -> addMolecularVectors
    """
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    id_to_index = {mol_id: i for i, mol_id in enumerate(ids)}
    existing_columns = set((_analysis_plain_columns(dataset)).keys())
    existing_descriptors = set((dataset.get("descriptors", {}) or {}).keys())
    existing_molecular_vectors = set((dataset.get("molecularVectors", {}) or {}).keys())
    existing_atom_properties = set((dataset.get("atomProperties", {}) or {}).keys())
    used_names = set(existing_columns) | set(existing_descriptors) | set(existing_molecular_vectors) | set(existing_atom_properties)
    rows = _analysis_read_csv_rows(csv_path)
    if not rows:
        return [], [], [], [], {"csvRows": 0, "scalarColumns": 0, "descriptors": 0, "molecularVectors": 0, "atomProperties": 0}

    xyz_by_id = dataset.get("xyzById", {}) or {}
    atom_count_by_id = {
        str(mol_id): _analysis_atom_count_from_xyz_text(xyz)
        for mol_id, xyz in xyz_by_id.items()
    }

    skip_keys = {
        "id",
        "mol_id",
        "molecule_id",
        "name",
        "filename",
        "file",
        "xyz_file",
        "xyz_path",
        "xyz",
        "path",
        "source_file",
        "source",
        "frame",
    }
    raw_by_col: dict[str, list[Any]] = {}
    kind_by_col: dict[str, str] = {}
    vectors_by_col: dict[str, dict[str, list[float]]] = {}
    name_map: dict[str, str] = {}
    vector_name_map: dict[str, str] = {}

    allow_order_fallback = False
    row_mapping_methods: dict[str, int] = {}
    mapped_rows = 0
    unmapped_rows = 0

    for row_i, row in enumerate(rows):
        mol_id, mapping_method = _analysis_csv_row_id(row, stem_to_id, row_i, allow_order_fallback=allow_order_fallback)
        row_mapping_methods[mapping_method] = row_mapping_methods.get(mapping_method, 0) + 1
        if mol_id is None or mol_id not in id_to_index:
            unmapped_rows += 1
            continue
        mapped_rows += 1
        target_i = id_to_index[mol_id]
        for key, raw_value in row.items():
            if key is None or key in skip_keys:
                continue
            clean_key = str(key).strip()
            if not clean_key:
                continue

            vec = _analysis_parse_vector(raw_value)
            if vec is not None:
                if clean_key not in vector_name_map:
                    vector_name_map[clean_key] = _analysis_unique_output_name(clean_key, used_names, prefix)
                vectors_by_col.setdefault(vector_name_map[clean_key], {})[mol_id] = vec
                continue

            if clean_key not in name_map:
                name_map[clean_key] = _analysis_unique_output_name(clean_key, used_names, prefix)
            out_name = name_map[clean_key]
            if out_name not in raw_by_col:
                raw_by_col[out_name] = [None] * len(ids)
                kind_by_col[out_name] = "numeric"
            kind, value = _analysis_parse_scalar(raw_value)
            if kind != "numeric":
                kind_by_col[out_name] = "categorical"
            raw_by_col[out_name][target_i] = value

    add_columns: list[dict[str, Any]] = []
    for name, values in raw_by_col.items():
        kind = kind_by_col.get(name, "categorical")
        if all(v is None for v in values):
            continue
        if kind == "numeric":
            add_columns.append({"name": name, "kind": "numeric", "values": values})
        else:
            add_columns.append({"name": name, "kind": "categorical", "values": [None if v is None else str(v) for v in values]})

    add_descriptors: list[dict[str, Any]] = []
    add_molecular_vectors: list[dict[str, Any]] = []
    add_atom_properties: list[dict[str, Any]] = []
    warnings: list[str] = []

    for name, values_by_id in vectors_by_col.items():
        if not values_by_id:
            continue
        dims = {len(v) for v in values_by_id.values()}
        common_source = {"kind": "tool", "label": f"Analysis tool: {prefix}"}

        if len(dims) == 1:
            add_descriptors.append(
                {
                    "name": name,
                    "valuesById": values_by_id,
                    "dtype": "float32",
                    "source": common_source,
                }
            )
            continue

        atom_like = True
        missing_atom_counts: list[str] = []
        mismatch_examples: list[str] = []
        for mol_id, vec in values_by_id.items():
            n_atoms = atom_count_by_id.get(mol_id)
            if n_atoms is None:
                atom_like = False
                missing_atom_counts.append(mol_id)
                break
            if len(vec) != n_atoms:
                atom_like = False
                mismatch_examples.append(f"{mol_id}: vector={len(vec)}, atoms={n_atoms}")
                break

        if atom_like:
            add_atom_properties.append(
                {
                    "name": name,
                    "valuesById": values_by_id,
                    "dtype": "float32",
                    "source": common_source,
                }
            )
        else:
            add_molecular_vectors.append(
                {
                    "name": name,
                    "valuesById": values_by_id,
                    "dtype": "float32",
                    "source": common_source,
                }
            )
            if missing_atom_counts:
                warnings.append(
                    f"Stored '{name}' as molecularVectors because atom counts were unavailable for some molecules."
                )
            elif mismatch_examples:
                warnings.append(
                    f"Stored '{name}' as molecularVectors because vector lengths did not match atom counts ({mismatch_examples[0]})."
                )
            else:
                warnings.append(
                    f"Stored '{name}' as molecularVectors because vector dimensions were inconsistent: {sorted(dims)}."
                )

    stats = {
        "csvRows": len(rows),
        "csvRowsMapped": mapped_rows,
        "csvRowsUnmapped": unmapped_rows,
        "csvRowOrderFallbackEnabled": allow_order_fallback,
        "csvRowMappingMethods": json.dumps(row_mapping_methods, sort_keys=True),
        "scalarColumns": len(add_columns),
        "descriptors": len(add_descriptors),
        "molecularVectors": len(add_molecular_vectors),
        "atomProperties": len(add_atom_properties),
        "vectorWarnings": len(warnings),
    }
    if warnings:
        stats["warnings"] = "; ".join(warnings)
    return add_columns, add_descriptors, add_molecular_vectors, add_atom_properties, stats


def _analysis_read_optional_lines(path: Path) -> list[str]:
    if not path.exists() or not path.is_file():
        return []
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def _analysis_outputs_from_xyz_to_smiles(
    dataset: dict[str, Any],
    csv_path: Path,
    stem_to_id: dict[str, str],
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    list[str],
    dict[str, Any],
]:
    """Convert MolCraftDiffusion xyz2mol sidecar outputs to app-native outputs.

    The xyz2mol run writes one CSV row for each successful SMILES conversion.
    The scaffold and Morgan fingerprint sidecars are aligned to those successful
    rows, not to the full staged XYZ set, so failed molecules stay null/missing.
    """
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    id_to_index = {mol_id: i for i, mol_id in enumerate(ids)}
    used_names = set((_analysis_plain_columns(dataset)).keys())
    used_names |= set((dataset.get("descriptors", {}) or {}).keys())
    used_names |= set((dataset.get("molecularVectors", {}) or {}).keys())
    used_names |= set((dataset.get("atomProperties", {}) or {}).keys())

    rows = _analysis_read_csv_rows(csv_path)
    repr_dir = csv_path.parent
    cleaned_smiles = _analysis_read_optional_lines(repr_dir / "smiles_cleaned.txt")
    scaffolds = _analysis_read_optional_lines(repr_dir / "scaffolds.txt")

    fingerprints: Any = None
    fingerprint_path = repr_dir / "fingerprints.npy"
    if fingerprint_path.exists() and fingerprint_path.is_file():
        try:
            import numpy as np

            fingerprints = np.load(fingerprint_path, allow_pickle=False)
        except Exception:
            fingerprints = None

    smiles_name = _analysis_unique_output_name("smiles", used_names, "xyz_to_smiles")
    scaffold_name = _analysis_unique_output_name("scaffold", used_names, "xyz_to_smiles")
    fingerprint_name = _analysis_unique_output_name(
        "morgan_fingerprint",
        used_names,
        "xyz_to_smiles",
    )

    smiles_values: list[Any] = [None] * len(ids)
    scaffold_values: list[Any] = [None] * len(ids)
    fingerprint_values_by_id: dict[str, list[float]] = {}
    row_mapping_methods: dict[str, int] = {}
    mapped_success_rows = 0
    unmapped_success_rows = 0
    mapped_smiles_count = 0
    mapped_scaffold_count = 0
    mapped_fingerprint_count = 0
    fingerprint_dim: int | None = None

    for row_i, row in enumerate(rows):
        mol_id, mapping_method = _analysis_csv_row_id(
            row,
            stem_to_id,
            row_i,
            allow_order_fallback=False,
        )
        row_mapping_methods[mapping_method] = (
            row_mapping_methods.get(mapping_method, 0) + 1
        )
        if mol_id is None or mol_id not in id_to_index:
            unmapped_success_rows += 1
            continue

        mapped_success_rows += 1
        target_i = id_to_index[mol_id]
        raw_smiles = row.get("smiles")
        smiles = str(raw_smiles).strip() if raw_smiles is not None else ""
        if not smiles and row_i < len(cleaned_smiles):
            smiles = cleaned_smiles[row_i].strip()
        if smiles:
            smiles_values[target_i] = smiles
            mapped_smiles_count += 1

        if row_i < len(scaffolds):
            scaffold = scaffolds[row_i].strip()
            if scaffold:
                scaffold_values[target_i] = scaffold
                mapped_scaffold_count += 1

        if fingerprints is not None:
            try:
                fp = fingerprints[row_i]
                fp_list = [float(x) for x in fp.tolist()]
            except Exception:
                fp_list = []
            if fp_list:
                fingerprint_values_by_id[mol_id] = fp_list
                mapped_fingerprint_count += 1
                fingerprint_dim = len(fp_list)

    add_columns: list[dict[str, Any]] = []
    if any(v is not None for v in smiles_values):
        add_columns.append(
            {"name": smiles_name, "kind": "categorical", "values": smiles_values}
        )
    if any(v is not None for v in scaffold_values):
        add_columns.append(
            {"name": scaffold_name, "kind": "categorical", "values": scaffold_values}
        )

    add_descriptors: list[dict[str, Any]] = []
    if fingerprint_values_by_id:
        add_descriptors.append(
            {
                "name": fingerprint_name,
                "valuesById": fingerprint_values_by_id,
                "dtype": "float32",
                "source": {"kind": "tool", "label": "Analysis tool: xyz_to_smiles"},
            }
        )

    selected_count = len(stem_to_id)
    missing_count = max(0, selected_count - mapped_success_rows)
    warnings: list[str] = []
    if missing_count or unmapped_success_rows:
        detail_parts = []
        if missing_count:
            detail_parts.append(
                f"{missing_count} selected molecules did not produce SMILES"
            )
        if unmapped_success_rows:
            detail_parts.append(
                f"{unmapped_success_rows} SMILES rows could not be mapped to molecule IDs"
            )
        warnings.append("; ".join(detail_parts) + ". These entries were left missing.")
    if mapped_smiles_count and not fingerprint_values_by_id:
        warnings.append("SMILES were mapped, but no Morgan fingerprints could be loaded.")
    if mapped_smiles_count and mapped_scaffold_count < mapped_smiles_count:
        warnings.append(
            f"Only {mapped_scaffold_count} of {mapped_smiles_count} mapped SMILES "
            "rows had scaffold values."
        )

    stats = {
        "selected": selected_count,
        "xyzToSmilesCsvRows": len(rows),
        "xyzToSmilesRowsMapped": mapped_success_rows,
        "xyzToSmilesRowsUnmapped": unmapped_success_rows,
        "xyzToSmilesMissingOrFailed": missing_count,
        "mappedSmiles": mapped_smiles_count,
        "mappedScaffolds": mapped_scaffold_count,
        "mappedFingerprints": mapped_fingerprint_count,
        "fingerprintDimension": fingerprint_dim or 0,
        "scaffoldSidecarRows": len(scaffolds),
        "cleanedSmilesSidecarRows": len(cleaned_smiles),
        "xyzToSmilesRowMappingMethods": json.dumps(
            row_mapping_methods,
            sort_keys=True,
        ),
    }
    return add_columns, add_descriptors, warnings, stats


def _analysis_is_xyz_to_smiles_output(tool_id: str, csv_path: Path) -> bool:
    if str(tool_id).strip() == "xyz_to_smiles":
        return True
    return csv_path.name == "smiles_processed.csv" and csv_path.parent.name == "2d_reprs"


def _analysis_read_json(path: Path) -> Any:
    if not path.exists() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return None


def _analysis_vector_from_any(value: Any) -> list[float] | None:
    if isinstance(value, list):
        try:
            vec = [float(x) for x in value]
        except Exception:
            return None
        return vec if vec and all(v == v and abs(v) != float("inf") for v in vec) else None

    if isinstance(value, dict):
        indexed: list[tuple[int, float]] = []
        for key, raw in value.items():
            try:
                idx = int(str(key))
                val = float(raw)
            except Exception:
                return None
            indexed.append((idx, val))
        if not indexed:
            return None
        offset = 1 if min(idx for idx, _val in indexed) == 1 else 0
        size = max(idx for idx, _val in indexed) - offset + 1
        vec = [0.0] * size
        for idx, val in indexed:
            pos = idx - offset
            if pos < 0 or pos >= size:
                return None
            vec[pos] = val
        return vec

    return None


def _analysis_outputs_from_featurize(
    dataset: dict[str, Any],
    csv_path: Path,
    stem_to_id: dict[str, str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], dict[str, Any]]:
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    used_names = set((_analysis_plain_columns(dataset)).keys())
    used_names |= set((dataset.get("descriptors", {}) or {}).keys())
    used_names |= set((dataset.get("molecularVectors", {}) or {}).keys())
    used_names |= set((dataset.get("atomProperties", {}) or {}).keys())

    stem = csv_path.with_suffix("")
    npy_path = stem.with_suffix(".npy")
    meta_path = Path(str(stem) + "_meta.json")
    rows = _analysis_read_csv_rows(csv_path)
    meta = _analysis_read_json(meta_path) or {}

    try:
        import numpy as np

        features = np.load(npy_path, allow_pickle=False)
    except Exception as exc:
        return [], [], [f"Could not load feature matrix {npy_path}: {exc}"], {
            "featureCsvRows": len(rows),
            "featureRowsMapped": 0,
            "featureRowsUnmapped": len(rows),
            "featureDimension": 0,
        }

    if getattr(features, "ndim", 0) != 2:
        return [], [], [f"Feature matrix {npy_path} is not two-dimensional."], {
            "featureCsvRows": len(rows),
            "featureRowsMapped": 0,
            "featureRowsUnmapped": len(rows),
            "featureDimension": 0,
        }

    backend = str(meta.get("backend") or "features").strip() or "features"
    descriptor_name = _analysis_unique_output_name(
        f"{backend}_features",
        used_names,
        "featurize",
    )
    used_names.add(descriptor_name)

    values_by_id: dict[str, list[float]] = {}
    row_mapping_methods: dict[str, int] = {}
    unmapped_rows = 0
    for row_i, row in enumerate(rows):
        mol_id, mapping_method = _analysis_csv_row_id(
            row,
            stem_to_id,
            row_i,
            allow_order_fallback=False,
        )
        row_mapping_methods[mapping_method] = (
            row_mapping_methods.get(mapping_method, 0) + 1
        )
        if mol_id is None or mol_id not in ids or row_i >= features.shape[0]:
            unmapped_rows += 1
            continue
        try:
            values_by_id[mol_id] = [float(x) for x in features[row_i].tolist()]
        except Exception:
            unmapped_rows += 1

    descriptors: list[dict[str, Any]] = []
    add_columns: list[dict[str, Any]] = []
    if values_by_id:
        descriptors.append(
            {
                "name": descriptor_name,
                "valuesById": values_by_id,
                "dtype": "float32",
                "source": {"kind": "tool", "label": f"Analysis tool: featurize ({backend})"},
            }
        )
        add_columns.append(
            {
                "name": descriptor_name,
                "kind": "vector",
                "values": [
                    f"vec[{int(features.shape[1])}]"
                    if mol_id in values_by_id
                    else ""
                    for mol_id in ids
                ],
            }
        )

    missing_count = max(0, len(stem_to_id) - len(values_by_id))
    warnings: list[str] = []
    if missing_count or unmapped_rows:
        warnings.append(
            f"{missing_count} selected molecules are missing featurize vectors; "
            f"{unmapped_rows} feature rows were unmapped."
        )

    stats = {
        "featureCsvRows": len(rows),
        "featureMatrixRows": int(features.shape[0]),
        "featureRowsMapped": len(values_by_id),
        "featureRowsUnmapped": unmapped_rows,
        "featureMissingOrFailed": missing_count,
        "featureDimension": int(features.shape[1]),
        "featureBackend": backend,
        "featureNpy": str(npy_path),
        "featureMeta": str(meta_path),
        "featureRowMappingMethods": json.dumps(row_mapping_methods, sort_keys=True),
    }
    return add_columns, descriptors, warnings, stats


def _analysis_outputs_from_smiles_fingerprints(
    dataset: dict[str, Any],
    rows: list[tuple[int, str]],
    params: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], dict[str, Any]]:
    try:
        import numpy as np
        from rdkit import Chem, DataStructs, RDLogger
        from rdkit.Chem import rdFingerprintGenerator
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"RDKit is required for Morgan fingerprint featurization: {exc}",
        )

    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    columns = _analysis_plain_columns(dataset)
    smiles_column = str(params.get("smiles_column") or "").strip()
    if not smiles_column:
        raise HTTPException(status_code=400, detail="Select a SMILES column for fingerprint featurization.")
    smiles_values = columns.get(smiles_column)
    if smiles_values is None:
        raise HTTPException(status_code=400, detail=f"SMILES column not found: {smiles_column}")

    try:
        radius = max(0, int(params.get("fp_radius") if params.get("fp_radius") not in (None, "") else 2))
        bits = max(1, int(params.get("fp_bits") if params.get("fp_bits") not in (None, "") else 2048))
    except Exception:
        raise HTTPException(status_code=400, detail="Morgan radius and bits must be valid integers.")
    use_chirality = _analysis_value_is_true(params.get("fp_use_chirality"))
    use_features = _analysis_value_is_true(params.get("fp_use_features"))
    atom_invariants = (
        rdFingerprintGenerator.GetMorganFeatureAtomInvGen()
        if use_features
        else None
    )
    fp_generator = rdFingerprintGenerator.GetMorganGenerator(
        radius=radius,
        fpSize=bits,
        includeChirality=use_chirality,
        atomInvariantsGenerator=atom_invariants,
    )

    used_names = set(columns.keys())
    used_names |= set((dataset.get("descriptors", {}) or {}).keys())
    used_names |= set((dataset.get("molecularVectors", {}) or {}).keys())
    used_names |= set((dataset.get("atomProperties", {}) or {}).keys())
    descriptor_name = _analysis_unique_output_name(
        "morgan_fingerprint",
        used_names,
        "featurize",
    )

    values_by_id: dict[str, list[float]] = {}
    invalid_examples: list[str] = []
    empty_count = 0
    invalid_count = 0
    out_of_range_count = 0
    RDLogger.DisableLog("rdApp.error")
    try:
        for row_i, mol_id in rows:
            if row_i >= len(smiles_values):
                out_of_range_count += 1
                continue
            raw_smiles = smiles_values[row_i]
            smiles = str(raw_smiles).strip() if raw_smiles is not None else ""
            if not smiles:
                empty_count += 1
                continue
            mol = Chem.MolFromSmiles(smiles)
            if mol is None:
                invalid_count += 1
                if len(invalid_examples) < 5:
                    invalid_examples.append(f"{mol_id}: {smiles[:80]}")
                continue
            try:
                fp = fp_generator.GetFingerprint(mol)
                arr = np.zeros((bits,), dtype=np.float32)
                DataStructs.ConvertToNumpyArray(fp, arr)
                values_by_id[mol_id] = [float(x) for x in arr.tolist()]
            except Exception:
                invalid_count += 1
                if len(invalid_examples) < 5:
                    invalid_examples.append(f"{mol_id}: {smiles[:80]}")
    finally:
        RDLogger.EnableLog("rdApp.error")

    descriptors: list[dict[str, Any]] = []
    add_columns: list[dict[str, Any]] = []
    if values_by_id:
        descriptors.append(
            {
                "name": descriptor_name,
                "valuesById": values_by_id,
                "dtype": "float32",
                "source": {"kind": "tool", "label": "Analysis tool: featurize (fingerprint)"},
            }
        )
        add_columns.append(
            {
                "name": descriptor_name,
                "kind": "vector",
                "values": [
                    f"vec[{bits}]" if mol_id in values_by_id else ""
                    for mol_id in ids
                ],
            }
        )

    warnings: list[str] = []
    skipped_count = empty_count + invalid_count + out_of_range_count
    if skipped_count:
        warnings.append(
            f"Skipped {skipped_count} selected molecules during fingerprint featurization "
            f"({empty_count} empty SMILES, {invalid_count} invalid SMILES, "
            f"{out_of_range_count} missing column values)."
        )
    if invalid_examples:
        warnings.append("Invalid SMILES examples: " + "; ".join(invalid_examples))

    stats = {
        "featureBackend": "fingerprint",
        "featureRowsMapped": len(values_by_id),
        "featureRowsUnmapped": skipped_count,
        "featureMissingOrFailed": max(0, len(rows) - len(values_by_id)),
        "featureDimension": bits,
        "fingerprintType": "morgan",
        "fingerprintMode": "binary",
        "fingerprintRadius": radius,
        "fingerprintBits": bits,
        "fingerprintUseChirality": use_chirality,
        "fingerprintUseFeatures": use_features,
        "smilesColumn": smiles_column,
        "invalidSmiles": invalid_count,
        "emptySmiles": empty_count,
        "missingSmilesValues": out_of_range_count,
    }
    return add_columns, descriptors, warnings, stats


def _analysis_outputs_from_xtb_json(
    dataset: dict[str, Any],
    json_path: Path,
    stem_to_id: dict[str, str],
    prefix: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str], dict[str, Any]]:
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    id_to_index = {mol_id: i for i, mol_id in enumerate(ids)}
    used_names = set((_analysis_plain_columns(dataset)).keys())
    used_names |= set((dataset.get("descriptors", {}) or {}).keys())
    used_names |= set((dataset.get("molecularVectors", {}) or {}).keys())
    used_names |= set((dataset.get("atomProperties", {}) or {}).keys())
    xyz_by_id = dataset.get("xyzById", {}) or {}
    atom_count_by_id = {
        str(mol_id): _analysis_atom_count_from_xyz_text(xyz)
        for mol_id, xyz in xyz_by_id.items()
    }

    loaded = _analysis_read_json(json_path)
    records = loaded if isinstance(loaded, list) else []
    if not records:
        return [], [], [], {"xtbJsonRows": 0, "xtbAtomProperties": 0, "xtbBondOrderColumns": 0}

    atomic_keys = {
        "charges",
        "fukui_plus",
        "fukui_minus",
        "fukui_radical",
        "fukui_dual",
    }
    atom_values: dict[str, dict[str, list[float]]] = {}
    bond_order_values: dict[str, list[Any]] = {}
    name_by_key: dict[str, str] = {}
    bond_name = _analysis_unique_output_name("bond_orders", used_names, prefix)
    row_mapping_methods: dict[str, int] = {}
    mapped_rows = 0
    unmapped_rows = 0

    for row_i, record in enumerate(records):
        if not isinstance(record, dict):
            unmapped_rows += 1
            continue
        mol_id, mapping_method = _analysis_csv_row_id(
            record,
            stem_to_id,
            row_i,
            allow_order_fallback=False,
        )
        row_mapping_methods[mapping_method] = (
            row_mapping_methods.get(mapping_method, 0) + 1
        )
        if mol_id is None or mol_id not in id_to_index:
            unmapped_rows += 1
            continue
        mapped_rows += 1

        for key in atomic_keys:
            vec = _analysis_vector_from_any(record.get(key))
            if vec is None:
                continue
            n_atoms = atom_count_by_id.get(mol_id)
            if n_atoms is not None and len(vec) != n_atoms:
                continue
            if key not in name_by_key:
                name_by_key[key] = _analysis_unique_output_name(key, used_names, prefix)
            atom_values.setdefault(name_by_key[key], {})[mol_id] = vec

        bond_orders = record.get("bond_orders")
        if isinstance(bond_orders, dict) and bond_orders:
            if bond_name not in bond_order_values:
                bond_order_values[bond_name] = [None] * len(ids)
            bond_order_values[bond_name][id_to_index[mol_id]] = json.dumps(
                bond_orders,
                sort_keys=True,
            )

    atom_properties = [
        {
            "name": name,
            "valuesById": values_by_id,
            "dtype": "float32",
            "source": {"kind": "tool", "label": "Analysis tool: xtb_electronic_properties"},
        }
        for name, values_by_id in atom_values.items()
        if values_by_id
    ]

    bond_order_columns = [
        {"name": name, "kind": "categorical", "values": values}
        for name, values in bond_order_values.items()
        if any(v is not None for v in values)
    ]

    warnings: list[str] = []
    if unmapped_rows:
        warnings.append(f"{unmapped_rows} XTB JSON rows could not be mapped to molecule IDs.")

    stats = {
        "xtbJson": str(json_path),
        "xtbJsonRows": len(records),
        "xtbJsonRowsMapped": mapped_rows,
        "xtbJsonRowsUnmapped": unmapped_rows,
        "xtbAtomProperties": len(atom_properties),
        "xtbBondOrderColumns": len(bond_order_columns),
        "xtbJsonRowMappingMethods": json.dumps(row_mapping_methods, sort_keys=True),
    }
    return bond_order_columns, atom_properties, warnings, stats


def _analysis_columns_from_csv(
    dataset: dict[str, Any],
    csv_path: Path,
    stem_to_id: dict[str, str],
    prefix: str,
) -> list[dict[str, Any]]:
    # Backwards-compatible wrapper for older call sites.
    add_columns, _add_descriptors, _add_molecular_vectors, _add_atom_properties, _stats = _analysis_outputs_from_csv(dataset, csv_path, stem_to_id, prefix)
    return add_columns


def _analysis_prediction_columns_from_csv(
    dataset: dict[str, Any],
    csv_path: Path,
    stem_to_id: dict[str, str],
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    id_to_index = {mol_id: i for i, mol_id in enumerate(ids)}
    existing_columns = set((_analysis_plain_columns(dataset)).keys())
    used_names = set(existing_columns)
    rows = _analysis_read_csv_rows(csv_path)
    if not rows:
        return [], [], {"csvRows": 0, "predictionColumns": 0, "mappedRows": 0}

    skip_keys = {
        "id",
        "mol_id",
        "molecule_id",
        "name",
        "filename",
        "file",
        "xyz_file",
        "xyz_path",
        "xyz",
        "path",
        "source_file",
        "source",
        "frame",
    }
    values_by_name: dict[str, list[Any]] = {}
    name_map: dict[str, str] = {}
    non_numeric_keys: set[str] = set()
    row_mapping_methods: dict[str, int] = {}
    mapped_rows = 0
    unmapped_rows = 0

    for row_i, row in enumerate(rows):
        mol_id, mapping_method = _analysis_csv_row_id(
            row, stem_to_id, row_i, allow_order_fallback=False
        )
        row_mapping_methods[mapping_method] = (
            row_mapping_methods.get(mapping_method, 0) + 1
        )
        if mol_id is None or mol_id not in id_to_index:
            unmapped_rows += 1
            continue
        mapped_rows += 1
        target_i = id_to_index[mol_id]
        for key, raw_value in row.items():
            if key is None or key in skip_keys:
                continue
            clean_key = str(key).strip()
            if not clean_key:
                continue
            kind, value = _analysis_parse_scalar(raw_value)
            if kind != "numeric":
                non_numeric_keys.add(clean_key)
                continue
            if clean_key not in name_map:
                name_map[clean_key] = _analysis_unique_output_name(
                    clean_key, used_names, "predict"
                )
            out_name = name_map[clean_key]
            if out_name not in values_by_name:
                values_by_name[out_name] = [None] * len(ids)
            values_by_name[out_name][target_i] = value

    add_columns = [
        {"name": name, "kind": "numeric", "values": values}
        for name, values in values_by_name.items()
        if not all(v is None for v in values)
    ]
    warnings = []
    if non_numeric_keys:
        warnings.append(
            "Skipped non-numeric prediction columns: "
            + ", ".join(sorted(non_numeric_keys))
        )
    return add_columns, warnings, {
        "csvRows": len(rows),
        "mappedRows": mapped_rows,
        "unmappedRows": unmapped_rows,
        "predictionColumns": len(add_columns),
        "predictionRowMappingMethods": json.dumps(
            row_mapping_methods,
            sort_keys=True,
        ),
    }


def _default_predict_config() -> dict[str, Any]:
    """Ad-hoc base config for `MolCraftDiff predict`.

    Mirrors the static fields of the old predict.yaml; the paths
    (chkpt/xyz/output) are filled in by the caller per job.
    """
    return {
        "defaults": [
            {"tasks": "regression"},
            {"interference": "prediction"},
            "_self_",
        ],
        "name": "akatsuki",
        "atom_vocab": [
            "H", "B", "C", "N", "O", "F", "Al", "Si", "P", "S",
            "Cl", "As", "Se", "Br", "I", "Hg", "Bi",
        ],
        "node_feature": None,
    }


def _analysis_predict_config(
    params: dict[str, Any],
    xyz_dir: Path,
    job_dir: Path,
) -> tuple[dict[str, Any], Path]:
    model_id = str(params.get("model_id") or "").strip()
    if not model_id:
        raise HTTPException(
            status_code=400,
            detail="Predictive model is required.",
        )
    model = _predict_model_by_id(model_id)
    config = _default_predict_config()
    # Optional override: point MOLCRAFT_PREDICT_CONFIG at a custom base config.
    if PREDICT_CONFIG_PATH.exists():
        try:
            loaded = (
                yaml.safe_load(PREDICT_CONFIG_PATH.read_text(encoding="utf-8"))
                or {}
            )
        except Exception as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Could not read predict config "
                f"{PREDICT_CONFIG_PATH}: {exc}",
            )
        if not isinstance(loaded, dict):
            raise HTTPException(
                status_code=400,
                detail=(
                    "Predict config must contain a YAML mapping: "
                    f"{PREDICT_CONFIG_PATH}"
                ),
            )
        config.update(loaded)

    output_dir = job_dir / "pred"
    output_dir.mkdir(parents=True, exist_ok=True)
    config["chkpt_directory"] = model["path"]
    config["xyz_directory"] = str(xyz_dir)
    config["output_directory"] = str(output_dir)
    config.pop("seed", None)
    config.pop("max_atoms", None)
    return config, output_dir / "predictions.csv"


def _analysis_cmd_for_tool(tool_id: str, params: dict[str, Any], xyz_dir: Path, job_dir: Path) -> tuple[list[str], Path | None]:
    cmd = [MOLCRAFT_CMD, "analyze"]
    output_csv: Path | None = None

    if tool_id == "validity_connectivity":
        output_csv = job_dir / "validity_connectivity.csv"
        cmd += ["metrics", str(xyz_dir), "--metrics", str(params.get("metrics") or "posebuster"), "-o", str(output_csv)]
        if params.get("recheck_topo"):
            cmd.append("--recheck-topo")
        if params.get("check_strain"):
            cmd.append("--check-strain")
        if params.get("mol_converter"):
            cmd += ["--mol-converter", str(params.get("mol_converter"))]

    elif tool_id == "xyz_to_smiles":
        cmd += ["xyz2mol", str(xyz_dir), "--bits", str(int(params.get("bits") or 2048))]
        output_csv = xyz_dir / "2d_reprs" / "smiles_processed.csv"

    elif tool_id == "xtb_electronic_properties":
        output_csv = job_dir / "xtb_electronic_properties.csv"
        property_group = str(params.get("properties") or "energy")
        output_format = (
            "all"
            if property_group in {"charges", "fukui", "bond_orders", "all"}
            else "csv"
        )
        cmd += [
            "xtb-electronic",
            str(xyz_dir),
            "-m",
            str(params.get("method") or "2"),
            "-c",
            str(int(params.get("charge") or 0)),
            "--n-unpaired",
            str(int(params.get("n_unpaired") or 0)),
            "-p",
            property_group,
            "-f",
            output_format,
            "-o",
            str(output_csv),
            "-j",
            str(int(params.get("n_jobs") or 1)),
            "-t",
            str(int(params.get("timeout") or 120)),
        ]
        solvent = str(params.get("solvent") or "").strip()
        if solvent:
            cmd += ["-s", solvent]
        if params.get("corrected") is False:
            cmd.append("--no-corrected")

    elif tool_id == "featurize":
        output_stem = job_dir / "features"
        cmd += ["featurize", str(xyz_dir), "-o", str(output_stem)]
        backend = str(params.get("backend") or "soap")
        cmd += ["--backend", backend]
        if backend == "soap":
            if params.get("autodetect", True):
                cmd.append("--autodetect")
            cmd += [
                "--r-cut", str(float(params.get("r_cut") or 6.0)),
                "--n-max", str(int(params.get("n_max") or 8)),
                "--l-max", str(int(params.get("l_max") or 6)),
                "--sigma", str(float(params.get("sigma") or 0.1)),
                "--pooling", str(params.get("pooling") or "mean"),
            ]
        else:
            model_path_raw = str(params.get("model_path") or "").strip()
            if model_path_raw:
                model_path = Path(model_path_raw).expanduser()
                if not model_path.is_absolute():
                    model_path = (REPO_ROOT / model_path).resolve()
                else:
                    model_path = model_path.resolve()
                if not model_path.exists():
                    raise HTTPException(
                        status_code=400,
                        detail=f"UMA model path does not exist: {model_path}",
                    )
                cmd += ["--model-path", str(model_path)]
            cmd += [
                "--device", str(params.get("device") or "cpu"),
                "--batch-size", str(int(params.get("batch_size") or 8)),
                "--pooling", str(params.get("pooling") or "mean"),
            ]
        output_csv = Path(str(output_stem) + ".csv")

    elif tool_id == "predict_properties":
        config, output_csv = _analysis_predict_config(params, xyz_dir, job_dir)
        config_path = job_dir / "config.yaml"
        config_path.write_text(
            yaml.safe_dump(config, sort_keys=False),
            encoding="utf-8",
        )
        cmd = [MOLCRAFT_CMD, "predict", str(config_path)]

    elif tool_id == "xtb_geometry_optimization":
        output_dir = job_dir / "optimized_xyz"
        output_dir.mkdir(parents=True, exist_ok=True)
        filter_csv, filter_column = _analysis_resolve_validity_filter_csv(params)
        cmd += [
            "optimize",
            str(xyz_dir),
            "--level",
            str(params.get("level") or "gfn2"),
            "--charge",
            str(int(params.get("charge") or 0)),
            "--timeout",
            str(int(params.get("timeout") or 240)),
            "--scale-factor",
            str(float(params.get("scale_factor") or 1.3)),
            "-o",
            str(output_dir),
        ]
        if filter_csv and filter_column:
            cmd += ["--csv", str(filter_csv), "--filter-column", filter_column]
        output_csv = None
    else:
        raise HTTPException(status_code=404, detail=f"Analysis tool not found: {tool_id}")

    return cmd, output_csv


def _analysis_is_optimized_xyz_candidate(path: Path, stem: str) -> bool:
    """Return True when an XYZ output file looks like the optimized geometry for stem.

    MolCraftDiffusion versions have used slightly different optimized filenames,
    including <stem>.xyz inside the output directory and <stem>_opt.xyz. This
    helper keeps the original molecule-id mapping stable by matching against the
    safe staged stem that we generated before running the command.
    """
    if not path.exists() or not path.is_file() or path.suffix.lower() != ".xyz":
        return False
    name = path.stem
    return name in {
        stem,
        f"{stem}_opt",
        f"{stem}_optimized",
        f"{stem}.opt",
        f"{stem}.optimized",
    } or name.startswith(f"{stem}_opt") or name.startswith(f"{stem}_optimized")


def _analysis_find_optimized_xyz_for_stem(job_dir: Path, xyz_dir: Path, optimized_dir: Path, stem: str) -> Path | None:
    """Find the optimized XYZ generated for one staged input stem.

    The optimizer should receive -o optimized_dir, but in practice different
    MolCraftDiffusion/analysis implementations may write to the output dir, a
    nested subdirectory, or occasionally next to the input files. We search those
    locations in a deterministic order and prefer files that explicitly look
    optimized over untouched staged inputs.
    """
    direct_candidates = [
        optimized_dir / f"{stem}.xyz",
        optimized_dir / f"{stem}_opt.xyz",
        optimized_dir / f"{stem}_optimized.xyz",
        optimized_dir / stem / f"{stem}.xyz",
        optimized_dir / stem / f"{stem}_opt.xyz",
        optimized_dir / stem / f"{stem}_optimized.xyz",
        xyz_dir / f"{stem}_opt.xyz",
        xyz_dir / f"{stem}_optimized.xyz",
    ]
    for candidate in direct_candidates:
        if candidate.exists() and candidate.is_file():
            return candidate

    search_roots = [optimized_dir, job_dir]
    seen: set[Path] = set()
    matches: list[Path] = []
    for root in search_roots:
        if not root.exists():
            continue
        for path in root.rglob("*.xyz"):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            if _analysis_is_optimized_xyz_candidate(path, stem):
                # Do not accept the original staged input file unless it is the only
                # possible thing and was actually written in the optimized directory.
                if path.parent == xyz_dir and path.name == f"{stem}.xyz":
                    continue
                matches.append(path)

    if not matches:
        return None

    # Prefer explicit optimized names, then files outside the input directory,
    # then the newest file.
    def score(path: Path) -> tuple[int, int, float]:
        low = path.stem.lower()
        explicit = 1 if ("opt" in low or "optimized" in low) else 0
        outside_input = 1 if xyz_dir.resolve() not in path.resolve().parents else 0
        try:
            mtime = path.stat().st_mtime
        except Exception:
            mtime = 0.0
        return explicit, outside_input, mtime

    return sorted(matches, key=score, reverse=True)[0]


def _analysis_list_xyz_outputs(job_dir: Path) -> list[str]:
    try:
        return [str(p.relative_to(job_dir)) for p in sorted(job_dir.rglob("*.xyz"))]
    except Exception:
        return []


def _analysis_vector_records(dataset: dict[str, Any]) -> dict[str, dict[str, Any]]:
    records: dict[str, dict[str, Any]] = {}
    for group_name in ("descriptors", "molecularVectors"):
        group = dataset.get(group_name, {}) or {}
        if not isinstance(group, dict):
            continue
        for key, record in group.items():
            if not isinstance(record, dict):
                continue
            name = str(record.get("name") or key).strip()
            values_by_id = record.get("valuesById")
            if not name or not isinstance(values_by_id, dict):
                continue
            records[name] = {
                "name": name,
                "kind": group_name,
                "valuesById": values_by_id,
            }
    return records


def _analysis_valid_matrix_for_vector(
    dataset: dict[str, Any],
    rows: list[tuple[int, str]],
    vector_name: str,
) -> tuple[Any, list[str], int, list[str]]:
    records = _analysis_vector_records(dataset)
    record = records.get(vector_name)
    if record is None:
        available = ", ".join(sorted(records)) or "(none)"
        raise HTTPException(
            status_code=400,
            detail=f"Vector column {vector_name!r} was not found. Available vector columns: {available}",
        )

    values_by_id = record["valuesById"]
    matrix: list[list[float]] = []
    matrix_ids: list[str] = []
    skipped: list[str] = []
    dim: int | None = None
    for _row_idx, mol_id in rows:
        raw = values_by_id.get(mol_id)
        if not isinstance(raw, list):
            skipped.append(mol_id)
            continue
        try:
            vec = [float(x) for x in raw]
        except Exception:
            skipped.append(mol_id)
            continue
        if not vec or not all(math.isfinite(x) for x in vec):
            skipped.append(mol_id)
            continue
        if dim is None:
            dim = len(vec)
        elif len(vec) != dim:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Vector column {vector_name!r} has inconsistent dimensions "
                    f"for selected molecules."
                ),
            )
        matrix.append(vec)
        matrix_ids.append(mol_id)

    if len(matrix) < 2:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Vector column {vector_name!r} has fewer than two valid vectors "
                "for the selected source."
            ),
        )

    import numpy as np

    return np.asarray(matrix, dtype="float32"), matrix_ids, int(dim or 0), skipped


def _analysis_first_eligible_vector(
    dataset: dict[str, Any],
    rows: list[tuple[int, str]],
) -> str:
    for name in sorted(_analysis_vector_records(dataset)):
        try:
            _matrix, _ids, _dim, _skipped = _analysis_valid_matrix_for_vector(
                dataset,
                rows,
                name,
            )
            return name
        except HTTPException:
            continue
    raise HTTPException(
        status_code=400,
        detail="No fixed-length molecular vector columns were found for the selected source.",
    )


def _analysis_run_umap(matrix: Any, params: dict[str, Any], job_dir: Path) -> Any:
    numba_cache_dir = job_dir / "numba_cache"
    numba_cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["NUMBA_CACHE_DIR"] = str(numba_cache_dir)
    try:
        import umap
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"UMAP requires umap-learn, but it could not be imported: {exc}",
        )

    n_epochs_raw = int(params.get("n_epochs") or 0)
    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=max(2, min(int(params.get("n_neighbors") or 15), matrix.shape[0] - 1)),
        min_dist=max(0.0, float(params.get("min_dist") or 0.1)),
        spread=max(0.01, float(params.get("spread") or 1.0)),
        metric=str(params.get("metric") or "euclidean"),
        n_epochs=None if n_epochs_raw <= 0 else n_epochs_raw,
        learning_rate=max(0.0001, float(params.get("umap_learning_rate") or 1.0)),
        init=str(params.get("initialization") or "spectral"),
        low_memory=bool(params.get("low_memory", True)),
        n_jobs=int(params.get("n_jobs") or 1),
        random_state=int(params.get("random_state") or 42),
    )
    return reducer.fit_transform(matrix)


def _analysis_run_tsne(matrix: Any, params: dict[str, Any]) -> Any:
    import numpy as np

    numba_cache_dir = Path(tempfile.gettempdir()) / "molcraft_numba_cache"
    numba_cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["NUMBA_CACHE_DIR"] = str(numba_cache_dir)

    perplexity = float(params.get("perplexity") or 30.0)
    if perplexity <= 0 or perplexity >= matrix.shape[0]:
        raise HTTPException(
            status_code=400,
            detail=(
                "t-SNE perplexity must be greater than 0 and strictly lower "
                f"than the number of valid vectors ({matrix.shape[0]})."
            ),
        )

    device = str(params.get("device") or "cpu").strip().lower()
    if device == "cuda":
        try:
            from tsnecuda import TSNE
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"CUDA t-SNE requires tsne-cuda, but it could not be imported: {exc}",
            )
        reducer = TSNE(
            n_components=2,
            perplexity=perplexity,
            learning_rate=float(params.get("tsne_learning_rate") or 200.0),
            early_exaggeration=float(params.get("early_exaggeration") or 12.0),
            theta=float(params.get("theta") or 0.5),
            n_iter=int(params.get("n_iter") or 1000),
            metric=str(params.get("metric") or "euclidean"),
            init=str(params.get("initialization") or "random"),
            random_seed=int(params.get("random_state") or 42),
            device=int(params.get("cuda_device") or 0),
        )
        return reducer.fit_transform(matrix)

    try:
        from openTSNE import TSNE
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"CPU t-SNE requires openTSNE, but it could not be imported: {exc}",
        )
    reducer = TSNE(
        n_components=2,
        perplexity=perplexity,
        learning_rate=float(params.get("tsne_learning_rate") or 200.0),
        early_exaggeration=float(params.get("early_exaggeration") or 12.0),
        theta=float(params.get("theta") or 0.5),
        n_iter=int(params.get("n_iter") or 1000),
        initialization=str(params.get("initialization") or "pca"),
        metric=str(params.get("metric") or "euclidean"),
        n_jobs=int(params.get("n_jobs") or 1),
        random_state=int(params.get("random_state") or 42),
        verbose=False,
    )
    return np.asarray(reducer.fit(matrix))


def _analysis_dimensionality_reduction_result(
    dataset: dict[str, Any],
    rows: list[tuple[int, str]],
    params: dict[str, Any],
    job_dir: Path,
) -> dict[str, Any]:
    ids = [str(x) for x in (dataset.get("ids", []) or [])]
    id_to_index = {mol_id: i for i, mol_id in enumerate(ids)}
    vector_name = str(params.get("vector_column") or "").strip()
    if not vector_name:
        vector_name = _analysis_first_eligible_vector(dataset, rows)

    matrix, matrix_ids, dim, skipped = _analysis_valid_matrix_for_vector(
        dataset,
        rows,
        vector_name,
    )
    algorithm = str(params.get("algorithm") or "umap").strip().lower()
    if algorithm == "tsne":
        embedding = _analysis_run_tsne(matrix, params)
        backend = "tsnecuda" if str(params.get("device") or "cpu").lower() == "cuda" else "openTSNE"
    elif algorithm == "umap":
        embedding = _analysis_run_umap(matrix, params, job_dir)
        backend = "umap-learn"
    else:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported dimensionality reduction algorithm: {algorithm}",
        )

    import numpy as np

    coords = np.asarray(embedding, dtype="float64")
    if coords.ndim != 2 or coords.shape[1] < 2 or coords.shape[0] != len(matrix_ids):
        raise HTTPException(
            status_code=500,
            detail="Dimensionality reduction did not return a two-dimensional embedding.",
        )

    columns = _analysis_plain_columns(dataset)
    x_values = list(columns.get("dimRedX") or [None] * len(ids))
    y_values = list(columns.get("dimRedy") or [None] * len(ids))
    if len(x_values) != len(ids):
        x_values = [None] * len(ids)
    if len(y_values) != len(ids):
        y_values = [None] * len(ids)

    for row_i, mol_id in enumerate(matrix_ids):
        target_i = id_to_index.get(mol_id)
        if target_i is None:
            continue
        x_values[target_i] = float(coords[row_i, 0])
        y_values[target_i] = float(coords[row_i, 1])

    warnings: list[str] = []
    if skipped:
        warnings.append(
            f"Skipped {len(skipped)} selected molecules without valid vectors in '{vector_name}'."
        )

    return {
        "message": (
            f"Dimensionality reduction finished with {algorithm.upper()} "
            f"({backend}) on {len(matrix_ids)} vectors from '{vector_name}'."
        ),
        "warnings": warnings,
        "addColumns": [
            {"name": "dimRedX", "kind": "numeric", "values": x_values},
            {"name": "dimRedy", "kind": "numeric", "values": y_values},
        ],
        "addDescriptors": [],
        "addMolecularVectors": [],
        "addAtomProperties": [],
        "stats": {
            "selected": len(rows),
            "processed": len(matrix_ids),
            "skippedMissingVectors": len(skipped),
            "vectorColumn": vector_name,
            "vectorDimension": dim,
            "algorithm": algorithm,
            "backend": backend,
            "columnsAdded": 2,
            "jobId": job_dir.name,
            "jobDir": str(job_dir),
            "backendVersion": ANALYSIS_BACKEND_VERSION,
        },
    }


def _analysis_execute_tool(tool_id: str, payload: AnalysisToolRunRequest, job_id: str | None = None):
    tool = ANALYSIS_TOOLS.get(tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail=f"Analysis tool not found: {tool_id}")

    job_id = job_id or uuid.uuid4().hex[:12]
    job_dir = (ANALYSIS_WORK_DIR / job_id).resolve()
    xyz_dir = job_dir / "input_xyz"
    job_dir.mkdir(parents=True, exist_ok=True)

    try:
        rows = _analysis_dataset_rows_for_origin(payload.dataset, payload.dataset_origin)
        skipped_ids: list[str] = []
        check_cols: list[str] = []

        payload_params = payload.params or {}
        using_filter_csv = bool(
            str(payload_params.get("filter_csv_job_id") or "").strip()
            or str(payload_params.get("filter_column") or "").strip()
        )

        if tool.get("mode") == "replace_xyz" and not using_filter_csv:
            eligible_rows, skipped_ids, check_cols_or_warnings = (
                _analysis_filter_optimization_rows(payload.dataset, rows)
            )
            if check_cols_or_warnings and isinstance(check_cols_or_warnings[0], str) and check_cols_or_warnings[0].startswith("No validity"):
                # No validity columns present — run on all rows without filtering
                rows_to_run = rows
                check_cols = []
                skipped_ids = []
            else:
                check_cols = check_cols_or_warnings
                rows_to_run = eligible_rows
                if not rows_to_run:
                    return {
                        "message": "No molecules were eligible for optimization.",
                        "warnings": ["All selected molecules failed at least one validity/connectivity boolean check."],
                        "replaceXyzById": {},
                        "stats": {"selected": len(rows), "eligible": 0, "skipped": len(skipped_ids), "jobId": job_id},
                    }
        elif tool.get("mode") == "replace_xyz":
            rows_to_run = rows
            filter_column = str(payload_params.get("filter_column") or "").strip()
            check_cols = [filter_column] if filter_column else []
        else:
            rows_to_run = rows

        if tool_id == "dimensionality_reduction":
            return _analysis_dimensionality_reduction_result(
                payload.dataset,
                rows_to_run,
                payload.params or {},
                job_dir,
            )

        if (
            tool_id == "featurize"
            and str((payload.params or {}).get("backend") or "").strip() == "fingerprint"
        ):
            add_columns, add_descriptors, warnings, parse_stats = _analysis_outputs_from_smiles_fingerprints(
                payload.dataset,
                rows_to_run,
                payload.params or {},
            )
            if not add_descriptors:
                raise HTTPException(
                    status_code=500,
                    detail="No valid Morgan fingerprints could be generated from the selected SMILES column.",
                )
            return {
                "message": (
                    f"{tool['name']} finished. Added {len(add_descriptors)} "
                    "Morgan fingerprint descriptor."
                ),
                "warnings": warnings,
                "addColumns": add_columns,
                "addDescriptors": add_descriptors,
                "addMolecularVectors": [],
                "addAtomProperties": [],
                "stats": {
                    "selected": len(rows),
                    "processed": len(rows_to_run),
                    "columnsAdded": len(add_columns),
                    "descriptorsAdded": len(add_descriptors),
                    "molecularVectorsAdded": 0,
                    "atomPropertiesAdded": 0,
                    "jobId": job_id,
                    "jobDir": str(job_dir),
                    "backendVersion": ANALYSIS_BACKEND_VERSION,
                    **parse_stats,
                },
            }

        stem_to_id = _analysis_stage_xyz(payload.dataset, rows_to_run, xyz_dir)
        cmd, expected_csv = _analysis_cmd_for_tool(tool_id, payload.params or {}, xyz_dir, job_dir)
        return_code, log_text = _analysis_run_command(cmd, job_dir, job_id=job_id)
        if return_code != 0:
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Analysis command failed with exit code {return_code}\n\n"
                    f"Job ID: {job_id}\n"
                    f"Job dir: {job_dir}\n\n"
                    f"{log_text}"
                ),
            )

        if tool.get("mode") == "replace_xyz":
            optimized_dir = job_dir / "optimized_xyz"
            replace_xyz_by_id: dict[str, str] = {}
            optimized_file_by_id: dict[str, str] = {}

            for stem, mol_id in stem_to_id.items():
                optimized_path = _analysis_find_optimized_xyz_for_stem(job_dir, xyz_dir, optimized_dir, stem)
                if optimized_path is not None:
                    replace_xyz_by_id[mol_id] = optimized_path.read_text(encoding="utf-8", errors="replace")
                    try:
                        optimized_file_by_id[mol_id] = str(optimized_path.relative_to(job_dir))
                    except Exception:
                        optimized_file_by_id[mol_id] = str(optimized_path)

            warnings = []
            if using_filter_csv:
                warnings.append(
                    "Optimization used the selected validity/connectivity CSV "
                    "filter; molecules failing the filter were skipped by "
                    "MolCraftDiffusion."
                )
            elif skipped_ids:
                warnings.append(f"Skipped {len(skipped_ids)} molecules because at least one validity/connectivity boolean field was not true.")

            missing_optimized_ids = [mol_id for mol_id in stem_to_id.values() if mol_id not in replace_xyz_by_id]
            if missing_optimized_ids:
                examples = ", ".join(missing_optimized_ids[:5])
                extra = f" Examples: {examples}" if examples else ""
                warnings.append(f"{len(missing_optimized_ids)} eligible molecules did not produce optimized XYZ output.{extra}")

            xyz_outputs = _analysis_list_xyz_outputs(job_dir)
            return {
                "message": f"Optimized {len(replace_xyz_by_id)} molecules. Existing XYZ should be replaced for the same IDs.",
                "warnings": warnings,
                "replaceXyzById": replace_xyz_by_id,
                "stats": {
                    "selected": len(rows),
                    "eligible": len(rows_to_run),
                    "optimized": len(replace_xyz_by_id),
                    "skipped": len(skipped_ids),
                    "validityColumnsChecked": ", ".join(check_cols),
                    "optimizedOutputDir": str(optimized_dir),
                    "optimizedFilesMatched": json.dumps(optimized_file_by_id, sort_keys=True),
                    "xyzOutputsFound": json.dumps(xyz_outputs[:50]),
                    "jobId": job_id,
                    "jobDir": str(job_dir),
                },
            }

        csv_path = expected_csv if expected_csv and expected_csv.exists() else _analysis_find_csv(job_dir, tool_id, xyz_dir)
        if csv_path is None:
            raise HTTPException(status_code=500, detail=f"Analysis finished but no CSV output was found in {job_dir}")

        if _analysis_is_xyz_to_smiles_output(tool_id, csv_path):
            (
                add_columns,
                add_descriptors,
                warnings,
                parse_stats,
            ) = _analysis_outputs_from_xyz_to_smiles(
                payload.dataset,
                csv_path,
                stem_to_id,
            )
            if not parse_stats.get("mappedSmiles") and not parse_stats.get(
                "mappedFingerprints"
            ):
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"XYZ to SMILES output was found at {csv_path}, but no "
                        "SMILES, scaffolds, or Morgan fingerprints could be "
                        "mapped to molecule IDs"
                    ),
                )

            column_part = (
                f"{len(add_columns)} columns"
                if add_columns
                else "no scalar columns"
            )
            descriptor_part = (
                f"{len(add_descriptors)} descriptors"
                if add_descriptors
                else "no descriptors"
            )
            return {
                "message": (
                    f"{tool['name']} finished. Added {column_part} and "
                    f"{descriptor_part} from {csv_path.name}."
                ),
                "warnings": warnings,
                "addColumns": add_columns,
                "addDescriptors": add_descriptors,
                "addMolecularVectors": [],
                "addAtomProperties": [],
                "stats": {
                    "processed": len(stem_to_id),
                    "columnsAdded": len(add_columns),
                    "descriptorsAdded": len(add_descriptors),
                    "molecularVectorsAdded": 0,
                    "atomPropertiesAdded": 0,
                    "csv": str(csv_path),
                    "jobId": job_id,
                    "jobDir": str(job_dir),
                    "backendVersion": ANALYSIS_BACKEND_VERSION,
                    **parse_stats,
                },
            }

        if tool_id == "featurize":
            add_columns, add_descriptors, warnings, parse_stats = _analysis_outputs_from_featurize(
                payload.dataset,
                csv_path,
                stem_to_id,
            )
            if not add_descriptors:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"Featurize output was found at {csv_path}, but no feature "
                        "vectors could be mapped to molecule IDs"
                    ),
                )
            return {
                "message": (
                    f"{tool['name']} finished. Added {len(add_descriptors)} "
                    f"descriptor from {csv_path.with_suffix('.npy').name}."
                ),
                "warnings": warnings,
                "addColumns": add_columns,
                "addDescriptors": add_descriptors,
                "addMolecularVectors": [],
                "addAtomProperties": [],
                "stats": {
                    "selected": len(rows),
                    "processed": len(stem_to_id),
                    "columnsAdded": len(add_columns),
                    "descriptorsAdded": len(add_descriptors),
                    "molecularVectorsAdded": 0,
                    "atomPropertiesAdded": 0,
                    "csv": str(csv_path),
                    "jobId": job_id,
                    "jobDir": str(job_dir),
                    "backendVersion": ANALYSIS_BACKEND_VERSION,
                    **parse_stats,
                },
            }

        if tool_id == "predict_properties":
            add_columns, warnings, parse_stats = _analysis_prediction_columns_from_csv(
                payload.dataset,
                csv_path,
                stem_to_id,
            )
            if not add_columns:
                raise HTTPException(
                    status_code=500,
                    detail=(
                        f"Prediction output was found at {csv_path}, but no "
                        "numeric prediction columns could be mapped to molecule IDs"
                    ),
                )
            return {
                "message": (
                    f"{tool['name']} finished. Added {len(add_columns)} "
                    f"prediction columns from {csv_path.name}."
                ),
                "warnings": warnings,
                "addColumns": add_columns,
                "addDescriptors": [],
                "addMolecularVectors": [],
                "addAtomProperties": [],
                "stats": {
                    "selected": len(rows),
                    "processed": len(stem_to_id),
                    "columnsAdded": len(add_columns),
                    "descriptorsAdded": 0,
                    "molecularVectorsAdded": 0,
                    "atomPropertiesAdded": 0,
                    "csv": str(csv_path),
                    "jobId": job_id,
                    "jobDir": str(job_dir),
                    "backendVersion": ANALYSIS_BACKEND_VERSION,
                    **parse_stats,
                },
            }

        add_columns, add_descriptors, add_molecular_vectors, add_atom_properties, parse_stats = _analysis_outputs_from_csv(
            payload.dataset, csv_path, stem_to_id, prefix=tool_id
        )
        # Staged XYZ diagnostics are intentionally not added during normal runs.
        parse_stats = {**parse_stats}

        warnings = []
        if tool_id == "xtb_electronic_properties":
            xtb_json_path = csv_path.with_suffix(".json")
            (
                xtb_columns,
                xtb_atom_properties,
                xtb_warnings,
                xtb_stats,
            ) = _analysis_outputs_from_xtb_json(
                payload.dataset,
                xtb_json_path,
                stem_to_id,
                prefix=tool_id,
            )
            add_columns.extend(xtb_columns)
            add_atom_properties.extend(xtb_atom_properties)
            warnings.extend(xtb_warnings)
            parse_stats = {**parse_stats, **xtb_stats}

        if not add_columns and not add_descriptors and not add_molecular_vectors and not add_atom_properties:
            raise HTTPException(status_code=500, detail=f"CSV output was found at {csv_path}, but no mergeable columns, descriptors, molecular vectors, or atom properties were detected")

        descriptor_warnings = parse_stats.get("warnings")
        if descriptor_warnings:
            warnings.append(str(descriptor_warnings))

        column_part = f"{len(add_columns)} columns" if add_columns else "no scalar columns"
        descriptor_part = f"{len(add_descriptors)} descriptors" if add_descriptors else "no descriptors"
        molecular_vector_part = f"{len(add_molecular_vectors)} molecular vectors" if add_molecular_vectors else "no molecular vectors"
        atom_property_part = f"{len(add_atom_properties)} atom properties" if add_atom_properties else "no atom properties"
        return {
            "message": f"{tool['name']} finished. Added {column_part}, {descriptor_part}, {molecular_vector_part}, and {atom_property_part} from {csv_path.name}.",
            "warnings": warnings,
            "addColumns": add_columns,
            "addDescriptors": add_descriptors,
            "addMolecularVectors": add_molecular_vectors,
            "addAtomProperties": add_atom_properties,
            "stats": {
                "selected": len(rows),
                "processed": len(stem_to_id),
                "columnsAdded": len(add_columns),
                "descriptorsAdded": len(add_descriptors),
                "molecularVectorsAdded": len(add_molecular_vectors),
                "atomPropertiesAdded": len(add_atom_properties),
                "csv": str(csv_path),
                "jobId": job_id,
                "jobDir": str(job_dir),
                **parse_stats,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        tb = traceback.format_exc()
        raise HTTPException(
            status_code=500,
            detail={"error": "Analysis tool failed", "message": str(exc), "traceback": tb, "jobId": job_id},
        )


def _analysis_job_dir(job_id: str) -> Path:
    if not job_id or "/" in job_id or "\\" in job_id or ".." in job_id:
        raise HTTPException(status_code=400, detail="Invalid analysis job id")
    job_dir = (ANALYSIS_WORK_DIR / job_id).resolve()
    _ensure_under(ANALYSIS_WORK_DIR, job_dir)
    return job_dir


def _analysis_status_path(job_dir: Path) -> Path:
    return job_dir / "status.json"


def _analysis_result_path(job_dir: Path) -> Path:
    return job_dir / "result.json"


def _analysis_read_job_status(job_id: str) -> dict[str, Any]:
    job_dir = _analysis_job_dir(job_id)
    path = _analysis_status_path(job_dir)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"Analysis job not found: {job_id}")
    status: dict[str, Any] | None = None
    read_error: Exception | None = None
    # Writing happens from a worker thread; briefly retry when polling catches
    # a transient empty/partial file during replacement.
    for _ in range(3):
        try:
            raw = path.read_text(encoding="utf-8").strip()
            if not raw:
                raise ValueError("status file is empty")
            loaded = json.loads(raw)
            status = loaded if isinstance(loaded, dict) else {}
            read_error = None
            break
        except Exception as exc:
            read_error = exc
            time.sleep(0.05)
            continue

    if status is None:
        proc = ACTIVE_ANALYSIS_PROCS.get(job_id)
        if proc is not None and proc.poll() is None:
            status = {"status": "running", "warning": f"Status file was temporarily unreadable: {read_error}"}
        else:
            raise HTTPException(status_code=500, detail=f"Could not read analysis job status: {read_error}")
    proc = ACTIVE_ANALYSIS_PROCS.get(job_id)
    if proc is not None and proc.poll() is None:
        status["status"] = "running"
    status["job_id"] = job_id
    status["job_dir"] = str(job_dir)
    status["has_result"] = _analysis_result_path(job_dir).exists()
    status["log_tail"] = _log_tail(job_dir)
    with ANALYSIS_QUEUE_CONDITION:
        pending = [
            queued_id
            for queued_id in ANALYSIS_QUEUE
            if queued_id in ANALYSIS_QUEUE_PAYLOADS
        ]
        if job_id in pending:
            status["queue_position"] = pending.index(job_id) + 1
        else:
            status.pop("queue_position", None)
    return status


def _analysis_write_job_status(job_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    job_dir = _analysis_job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    path = _analysis_status_path(job_dir)
    status: dict[str, Any] = {}
    if path.exists():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                status = loaded
        except Exception:
            status = {}
    status.update(patch)
    status["job_id"] = job_id
    status["job_dir"] = str(job_dir)
    status["updated_at"] = _utc_now()
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(
        json.dumps(status, indent=2, sort_keys=True), encoding="utf-8"
    )
    tmp_path.replace(path)
    return status


def _analysis_attach_column_ids(result: Any, dataset: dict[str, Any]) -> Any:
    """Attach the row identity used by each positional scalar result column."""
    if not isinstance(result, dict):
        return result

    ids = [str(value) for value in (dataset.get("ids", []) or [])]
    columns = result.get("addColumns")
    if not isinstance(columns, list):
        return result

    for column in columns:
        if not isinstance(column, dict) or isinstance(column.get("ids"), list):
            continue
        values = column.get("values")
        if isinstance(values, list) and len(values) == len(ids):
            column["ids"] = ids
    return result


def _analysis_run_job_worker(job_id: str, tool_id: str, payload: AnalysisToolRunRequest) -> None:
    current = _analysis_read_job_status(job_id)
    if current.get("status") == "cancelled":
        return
    _analysis_write_job_status(
        job_id,
        {
            "status": "running",
            "started_at": _utc_now(),
            "backend_version": ANALYSIS_BACKEND_VERSION,
        },
    )
    job_dir = _analysis_job_dir(job_id)
    try:
        result = _analysis_execute_tool(tool_id, payload, job_id=job_id)
        result = _analysis_attach_column_ids(result, payload.dataset)
        current = _analysis_read_job_status(job_id)
        if current.get("status") == "cancelled":
            return
        _analysis_result_path(job_dir).write_text(
            json.dumps(result, ensure_ascii=False, allow_nan=True),
            encoding="utf-8",
        )
        _analysis_write_job_status(
            job_id,
            {
                "status": "completed",
                "finished_at": _utc_now(),
                "message": result.get("message") if isinstance(result, dict) else "Analysis job completed.",
                "backend_version": ANALYSIS_BACKEND_VERSION,
            },
        )
    except HTTPException as exc:
        current = _analysis_read_job_status(job_id)
        if current.get("status") == "cancelled":
            return
        detail = exc.detail
        if not isinstance(detail, str):
            try:
                detail = json.dumps(detail)
            except Exception:
                detail = str(detail)
        _analysis_write_job_status(
            job_id,
            {
                "status": "failed",
                "finished_at": _utc_now(),
                "error": detail,
                "log_tail": _log_tail(job_dir),
                "backend_version": ANALYSIS_BACKEND_VERSION,
            },
        )
    except Exception as exc:
        current = _analysis_read_job_status(job_id)
        if current.get("status") == "cancelled":
            return
        _analysis_write_job_status(
            job_id,
            {
                "status": "failed",
                "finished_at": _utc_now(),
                "error": str(exc),
                "traceback": traceback.format_exc(),
                "log_tail": _log_tail(job_dir),
                "backend_version": ANALYSIS_BACKEND_VERSION,
            },
        )


def _analysis_queue_worker() -> None:
    while True:
        with ANALYSIS_QUEUE_CONDITION:
            while not ANALYSIS_QUEUE:
                ANALYSIS_QUEUE_CONDITION.wait()
            job_id = ANALYSIS_QUEUE.pop(0)
            item = ANALYSIS_QUEUE_PAYLOADS.pop(job_id, None)
            ANALYSIS_QUEUE_CONDITION.notify_all()

        if item is None:
            continue

        tool_id = item
        try:
            status = _analysis_read_job_status(job_id)
        except HTTPException:
            continue
        if status.get("status") == "cancelled":
            continue

        payload_path = _analysis_job_dir(job_id) / "payload.json"
        try:
            payload = AnalysisToolRunRequest(
                **json.loads(payload_path.read_text(encoding="utf-8"))
            )
        except Exception as exc:
            _analysis_write_job_status(
                job_id,
                {
                    "status": "failed",
                    "finished_at": _utc_now(),
                    "error": f"Could not load queued payload: {exc}",
                },
            )
            continue

        _analysis_run_job_worker(job_id, tool_id, payload)
        payload_path.unlink(missing_ok=True)


def _analysis_start_queue_worker_locked() -> None:
    global ANALYSIS_QUEUE_WORKER_STARTED
    if ANALYSIS_QUEUE_WORKER_STARTED:
        return
    ANALYSIS_QUEUE_WORKER_STARTED = True
    worker = Thread(target=_analysis_queue_worker, daemon=True)
    worker.start()


def _analysis_enqueue_job(
    job_id: str,
    tool_id: str,
    payload: AnalysisToolRunRequest,
) -> int:
    payload_path = _analysis_job_dir(job_id) / "payload.json"
    payload_path.write_text(
        json.dumps(payload.model_dump(), ensure_ascii=False, allow_nan=True),
        encoding="utf-8",
    )
    with ANALYSIS_QUEUE_CONDITION:
        _analysis_start_queue_worker_locked()
        ANALYSIS_QUEUE_PAYLOADS[job_id] = tool_id
        ANALYSIS_QUEUE.append(job_id)
        queue_position = len(
            [
                queued_id
                for queued_id in ANALYSIS_QUEUE
                if queued_id in ANALYSIS_QUEUE_PAYLOADS
            ]
        )
        ANALYSIS_QUEUE_CONDITION.notify_all()
        return queue_position


@app.post("/analysis-tools/{tool_id}/run")
def run_analysis_tool(tool_id: str, payload: AnalysisToolRunRequest):
    return _analysis_attach_column_ids(_analysis_execute_tool(tool_id, payload), payload.dataset)


@app.post("/analysis-tools/{tool_id}/jobs")
def create_analysis_job(tool_id: str, payload: AnalysisToolRunRequest):
    tool = ANALYSIS_TOOLS.get(tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail=f"Analysis tool not found: {tool_id}")

    job_id = uuid.uuid4().hex[:12]
    job_dir = _analysis_job_dir(job_id)
    job_dir.mkdir(parents=True, exist_ok=True)
    status = _analysis_write_job_status(
        job_id,
        {
            "status": "queued",
            "created_at": _utc_now(),
            "tool_id": tool_id,
            "tool_name": tool.get("name", tool_id),
            "dataset_origin": payload.dataset_origin,
            "params": payload.params or {},
            "backend_version": ANALYSIS_BACKEND_VERSION,
        },
    )
    queue_position = _analysis_enqueue_job(job_id, tool_id, payload)
    status["queue_position"] = queue_position
    status["has_result"] = False
    status["log_tail"] = ""
    return status


@app.get("/analysis-tools/jobs/{job_id}")
def get_analysis_job(job_id: str):
    return _analysis_read_job_status(job_id)


@app.delete("/analysis-tools/jobs/{job_id}")
def cancel_analysis_job(job_id: str):
    status = _analysis_read_job_status(job_id)
    if status.get("status") == "queued":
        with ANALYSIS_QUEUE_CONDITION:
            ANALYSIS_QUEUE_PAYLOADS.pop(job_id, None)
            ANALYSIS_QUEUE[:] = [queued_id for queued_id in ANALYSIS_QUEUE if queued_id != job_id]
            ANALYSIS_QUEUE_CONDITION.notify_all()
        _analysis_write_job_status(job_id, {"status": "cancelled", "finished_at": _utc_now()})
        return _analysis_read_job_status(job_id)

    proc = ACTIVE_ANALYSIS_PROCS.get(job_id)
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except Exception:
            proc.kill()
        _analysis_write_job_status(
            job_id,
            {
                "status": "cancelled",
                "finished_at": _utc_now(),
                "log_tail": _log_tail(_analysis_job_dir(job_id)),
            },
        )
        return _analysis_read_job_status(job_id)
    if status.get("status") in {"queued", "running"}:
        _analysis_write_job_status(job_id, {"status": "cancelled", "finished_at": _utc_now()})
    return _analysis_read_job_status(job_id)


def _analysis_backfill_featurize_columns(result: Any) -> Any:
    if not isinstance(result, dict):
        return result
    if result.get("addColumns"):
        return result
    stats = result.get("stats") if isinstance(result.get("stats"), dict) else {}
    if stats.get("featureBackend") is None:
        return result

    descriptors = result.get("addDescriptors")
    if not isinstance(descriptors, list) or not descriptors:
        return result
    descriptor = descriptors[0]
    if not isinstance(descriptor, dict):
        return result

    values_by_id = descriptor.get("valuesById")
    if not isinstance(values_by_id, dict) or not values_by_id:
        return result
    expected_count = int(stats.get("processed") or stats.get("selected") or 0)
    if expected_count and len(values_by_id) != expected_count:
        return result

    name = str(descriptor.get("name") or "features").strip() or "features"
    dim = int(stats.get("featureDimension") or 0)
    label = f"vec[{dim}]" if dim > 0 else "vec"
    result["addColumns"] = [
        {
            "name": name,
            "kind": "vector",
            "ids": [str(_id) for _id in values_by_id.keys()],
            "values": [label for _id in values_by_id.keys()],
        }
    ]
    stats["columnsAdded"] = 1
    return result


@app.post("/analysis-tools/jobs/{job_id}/apply")
def apply_analysis_job(job_id: str):
    status = _analysis_read_job_status(job_id)
    result_path = _analysis_result_path(_analysis_job_dir(job_id))
    if not result_path.exists():
        if status.get("status") == "failed":
            raise HTTPException(status_code=500, detail=status.get("error") or "Analysis job failed")
        raise HTTPException(status_code=400, detail=f"Analysis job has no result yet. Current status: {status.get('status')}")
    try:
        result = json.loads(result_path.read_text(encoding="utf-8"))
        return _analysis_backfill_featurize_columns(result)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read analysis job result: {exc}")

# -------------------------------------------------------------------
# Training jobs: SQLite persistence + queue
# -------------------------------------------------------------------

_TRAIN_DB_LOCK = __import__("threading").Lock()
# Guards status read-modify-write (worker finish vs cancel endpoint).
_TRAIN_STATUS_LOCK = threading.Lock()
_TRAINING_SCHEMA = """
CREATE TABLE IF NOT EXISTS training_jobs (
    job_id      TEXT PRIMARY KEY,
    mode        TEXT NOT NULL DEFAULT 'run',
    status      TEXT NOT NULL DEFAULT 'queued',
    created_at  TEXT,
    started_at  TEXT,
    finished_at TEXT,
    preset_name TEXT,
    task_family TEXT,
    config_yaml TEXT,
    config_path TEXT,
    output_dir  TEXT,
    log_path    TEXT,
    command_json TEXT,
    form_payload TEXT,
    error       TEXT,
    return_code INTEGER
)
"""


def _train_db_init() -> None:
    TRAIN_OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    TRAIN_DRY_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(str(TRAIN_DB_PATH)) as con:
        con.execute(_TRAINING_SCHEMA)
        con.commit()


_train_db_init()


def _train_db_conn() -> sqlite3.Connection:
    con = sqlite3.connect(str(TRAIN_DB_PATH), check_same_thread=False)
    con.row_factory = sqlite3.Row
    return con


def _train_db_upsert(job_id: str, fields: dict[str, Any]) -> None:
    cols = list(fields.keys())
    vals = [fields[c] for c in cols]
    placeholders = ", ".join("?" * len(cols))
    col_str = ", ".join(cols)
    update_str = ", ".join(f"{c} = excluded.{c}" for c in cols if c != "job_id")
    sql = (
        f"INSERT INTO training_jobs (job_id, {col_str}) VALUES (?, {placeholders}) "
        f"ON CONFLICT(job_id) DO UPDATE SET {update_str}"
    )
    with _TRAIN_DB_LOCK:
        with _train_db_conn() as con:
            con.execute(sql, [job_id] + vals)
            con.commit()


def _train_db_get(job_id: str) -> dict[str, Any]:
    with _train_db_conn() as con:
        row = con.execute(
            "SELECT * FROM training_jobs WHERE job_id = ?", (job_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail=f"Training job not found: {job_id}")
    return dict(row)


def _train_db_list(mode: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM training_jobs"
    params: list[Any] = []
    if mode:
        sql += " WHERE mode = ?"
        params.append(mode)
    sql += " ORDER BY created_at DESC"
    with _train_db_conn() as con:
        rows = con.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def _train_db_delete(job_id: str) -> None:
    with _TRAIN_DB_LOCK:
        with _train_db_conn() as con:
            con.execute("DELETE FROM training_jobs WHERE job_id = ?", (job_id,))
            con.commit()


def _train_job_dir_from_db(job_id: str) -> Path | None:
    row = _train_db_get(job_id)
    d = row.get("output_dir")
    return Path(d).resolve() if d else None


def _train_log_tail(job_id: str, max_lines: int = 200) -> str:
    row = _train_db_get(job_id)
    log_path = row.get("log_path")
    if not log_path:
        return row.get("error") or ""
    p = Path(log_path)
    if not p.exists():
        return row.get("error") or ""
    text = _tail_lines(p, max_lines)
    if not text.strip():
        # Log file is empty — surface the DB error field instead
        return row.get("error") or ""
    return text


def _training_run_job_worker(job_id: str, cmd: list[str], job_dir: Path, log_path: Path) -> None:
    _train_db_upsert(job_id, {"status": "running", "started_at": _utc_now()})
    try:
        with open(log_path, "w", encoding="utf-8") as log_fh:
            proc = subprocess.Popen(
                cmd,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                cwd=str(job_dir),
            )
        ACTIVE_TRAINING_PROCS[job_id] = proc
        return_code = proc.wait()
        ACTIVE_TRAINING_PROCS.pop(job_id, None)
        with _TRAIN_STATUS_LOCK:
            row = _train_db_get(job_id)
            if row.get("status") == "cancelled":
                return
            status = "completed" if return_code == 0 else "failed"
            _train_db_upsert(
                job_id,
                {
                    "status": status,
                    "finished_at": _utc_now(),
                    "return_code": return_code,
                    "error": "" if return_code == 0 else f"Process exited with code {return_code}",
                },
            )
    except Exception as exc:
        ACTIVE_TRAINING_PROCS.pop(job_id, None)
        err_msg = traceback.format_exc()
        # Write the Python exception into the log file so it surfaces in the UI
        try:
            with open(log_path, "a", encoding="utf-8") as _lf:
                _lf.write(f"\n--- worker exception ---\n{err_msg}\n")
        except Exception:
            pass
        _train_db_upsert(
            job_id,
            {
                "status": "failed",
                "finished_at": _utc_now(),
                "error": str(exc),
            },
        )


def _training_queue_worker() -> None:
    while True:
        with TRAINING_QUEUE_CONDITION:
            while not TRAINING_QUEUE:
                TRAINING_QUEUE_CONDITION.wait()
            job_id = TRAINING_QUEUE.pop(0)
            payload_item = TRAINING_QUEUE_PAYLOADS.pop(job_id, None)
            TRAINING_QUEUE_CONDITION.notify_all()

        if payload_item is None:
            continue

        try:
            row = _train_db_get(job_id)
        except HTTPException:
            continue
        if row.get("status") == "cancelled":
            continue

        cmd_raw = row.get("command_json")
        cmd = json.loads(cmd_raw) if cmd_raw else []
        job_dir_raw = row.get("output_dir")
        log_path_raw = row.get("log_path")
        if not cmd or not job_dir_raw or not log_path_raw:
            continue

        _training_run_job_worker(job_id, cmd, Path(job_dir_raw), Path(log_path_raw))


def _training_start_queue_worker_locked() -> None:
    global TRAINING_QUEUE_WORKER_STARTED
    if TRAINING_QUEUE_WORKER_STARTED:
        return
    TRAINING_QUEUE_WORKER_STARTED = True
    worker = Thread(target=_training_queue_worker, daemon=True)
    worker.start()


def _training_enqueue_job(job_id: str) -> int:
    with TRAINING_QUEUE_CONDITION:
        _training_start_queue_worker_locked()
        TRAINING_QUEUE_PAYLOADS[job_id] = {}
        TRAINING_QUEUE.append(job_id)
        position = len([j for j in TRAINING_QUEUE if j in TRAINING_QUEUE_PAYLOADS])
        TRAINING_QUEUE_CONDITION.notify_all()
        return position


class TrainingJobRequest(BaseModel):
    payload: Dict[str, Any]
    preset_name: str = ""
    mode: str = "run"  # "run" | "dry"


class TrainingJobListItem(BaseModel):
    job_id: str
    mode: str
    status: str
    created_at: str | None
    started_at: str | None
    finished_at: str | None
    task_family: str | None
    preset_name: str | None
    config_path: str | None
    output_dir: str | None
    error: str | None
    return_code: int | None


def _train_row_to_summary(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": row["job_id"],
        "mode": row.get("mode", "run"),
        "status": row.get("status", "unknown"),
        "created_at": row.get("created_at"),
        "started_at": row.get("started_at"),
        "finished_at": row.get("finished_at"),
        "task_family": row.get("task_family"),
        "preset_name": row.get("preset_name"),
        "config_path": row.get("config_path"),
        "output_dir": row.get("output_dir"),
        "error": row.get("error"),
        "return_code": row.get("return_code"),
    }


class UnlockBody(BaseModel):
    password: str


@app.post("/training/unlock")
def training_unlock(body: UnlockBody) -> dict[str, Any]:
    """Exchange a password for a session token that unlocks extended model families."""
    pwd = _unlock_password()
    if not pwd:
        raise HTTPException(status_code=404, detail="Unlock not configured.")
    if not secrets.compare_digest(body.password, pwd):
        raise HTTPException(status_code=401, detail="Incorrect password.")
    token = secrets.token_hex(32)
    while len(_UNLOCK_TOKENS) >= _UNLOCK_TOKENS_MAX:
        _UNLOCK_TOKENS.pop(next(iter(_UNLOCK_TOKENS)))
    _UNLOCK_TOKENS[token] = None
    return {"token": token}


@app.post("/training/jobs")
def create_training_job(
    body: TrainingJobRequest,
    x_training_token: str | None = Header(default=None),
) -> dict[str, Any]:
    """Submit a training job (run mode) or generate YAML only (dry mode)."""
    payload = body.payload
    try:
        validate_training_payload(payload)
    except TrainingValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if payload.get("task_family") not in _allowed_task_families(x_training_token):
        raise HTTPException(
            status_code=422,
            detail=f"Task family not available: {payload.get('task_family')}",
        )

    job_id = uuid.uuid4().hex[:12]
    date_part, time_part = _utc_now_parts()
    run_token = f"{time_part}_{job_id}"

    is_dry = body.mode == "dry"

    if is_dry:
        job_dir = (TRAIN_DRY_DIR / date_part / run_token).resolve()
    else:
        job_dir = (TRAIN_OUTPUTS_DIR / date_part / run_token).resolve()

    job_dir.mkdir(parents=True, exist_ok=True)
    config_path = job_dir / "config.yaml"
    log_path = job_dir / "job.log"

    yaml_text = build_yaml_text(payload, str(job_dir.resolve()))
    config_path.write_text(yaml_text, encoding="utf-8")
    if not is_dry:
        log_path.write_text("", encoding="utf-8")

    cmd = [MOLCRAFT_CMD, "train", str(config_path.resolve())]

    row: dict[str, Any] = {
        "mode": "dry" if is_dry else "run",
        "status": "dry" if is_dry else "queued",
        "created_at": _utc_now(),
        "preset_name": body.preset_name or None,
        "task_family": payload.get("task_family"),
        "config_yaml": yaml_text,
        "config_path": str(config_path.resolve()),
        "output_dir": str(job_dir.resolve()),
        "log_path": str(log_path.resolve()) if not is_dry else None,
        "command_json": json.dumps(cmd),
        "form_payload": json.dumps(payload),
    }
    _train_db_upsert(job_id, row)

    result = _train_row_to_summary(_train_db_get(job_id))
    result["config_yaml"] = yaml_text
    result["suggested_command"] = " ".join(cmd)

    if not is_dry:
        position = _training_enqueue_job(job_id)
        result["queue_position"] = position

    return result


@app.get("/training/jobs")
def list_training_jobs(
    mode: str = Query(default="run", description="Filter by mode: run, dry, or all"),
) -> dict[str, Any]:
    if mode == "all":
        rows = _train_db_list()
    else:
        rows = _train_db_list(mode=mode)
    return {"jobs": [_train_row_to_summary(r) for r in rows]}


@app.get("/training/jobs/{job_id}")
def get_training_job(job_id: str) -> dict[str, Any]:
    row = _train_db_get(job_id)
    # Check if process is still alive (might have been killed externally)
    proc = ACTIVE_TRAINING_PROCS.get(job_id)
    if proc is not None and proc.poll() is None and row.get("status") != "running":
        _train_db_upsert(job_id, {"status": "running"})
        row["status"] = "running"
    result = _train_row_to_summary(row)
    result["config_yaml"] = row.get("config_yaml")
    result["log_tail"] = _train_log_tail(job_id)
    result["suggested_command"] = (
        " ".join(json.loads(row["command_json"])) if row.get("command_json") else ""
    )
    return result


@app.get("/training/jobs/{job_id}/log", response_class=PlainTextResponse)
def get_training_job_log(job_id: str, lines: int = Query(default=0)) -> str:
    row = _train_db_get(job_id)
    log_path = row.get("log_path")
    if not log_path or not Path(log_path).exists():
        return ""
    # lines=0 means "default tail", not the whole file.
    return _tail_lines(Path(log_path), lines if lines > 0 else 200)


@app.delete("/training/jobs/{job_id}")
def cancel_training_job(job_id: str) -> dict[str, Any]:
    row = _train_db_get(job_id)
    status = row.get("status", "")

    if status == "queued":
        with TRAINING_QUEUE_CONDITION:
            TRAINING_QUEUE_PAYLOADS.pop(job_id, None)
            TRAINING_QUEUE[:] = [j for j in TRAINING_QUEUE if j != job_id]
            TRAINING_QUEUE_CONDITION.notify_all()
        _train_db_upsert(job_id, {"status": "cancelled", "finished_at": _utc_now()})
        return _train_row_to_summary(_train_db_get(job_id))

    proc = ACTIVE_TRAINING_PROCS.get(job_id)
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        ACTIVE_TRAINING_PROCS.pop(job_id, None)
        with _TRAIN_STATUS_LOCK:
            _train_db_upsert(
                job_id,
                {"status": "cancelled", "finished_at": _utc_now()},
            )
        return _train_row_to_summary(_train_db_get(job_id))

    if status in {"queued", "running"}:
        with _TRAIN_STATUS_LOCK:
            row = _train_db_get(job_id)
            if row.get("status") in {"queued", "running"}:
                _train_db_upsert(job_id, {"status": "cancelled", "finished_at": _utc_now()})
    return _train_row_to_summary(_train_db_get(job_id))


@app.delete("/training/jobs/{job_id}/history")
def delete_training_job_history(
    job_id: str,
    delete_files: bool = Query(default=False),
) -> dict[str, Any]:
    row = _train_db_get(job_id)
    if delete_files:
        out_dir = row.get("output_dir")
        if out_dir and Path(out_dir).exists():
            shutil.rmtree(out_dir, ignore_errors=True)
    _train_db_delete(job_id)
    return {"ok": True, "job_id": job_id}


@app.post("/training/jobs/{job_id}/clone")
def clone_training_job(job_id: str) -> dict[str, Any]:
    row = _train_db_get(job_id)
    raw = row.get("form_payload")
    if not raw:
        raise HTTPException(status_code=404, detail="No form payload stored for this job.")
    return {"job_id": job_id, "payload": json.loads(raw)}


@app.get("/training/task-families")
def list_task_families(
    x_training_token: str | None = Header(default=None),
) -> dict[str, Any]:
    families = _allowed_task_families(x_training_token)
    return {
        "families": [
            {"id": k, "label": v["label"], "category": v["category"]}
            for k, v in families.items()
        ],
        "unlock_available": _unlock_password() is not None,
        "unlocked": _check_token(x_training_token),
    }


class TrainingImportPathBody(BaseModel):
    path: str


@app.post("/training/import-yaml-path")
def import_training_yaml_path(body: TrainingImportPathBody) -> dict[str, Any]:
    """Parse a YAML file from an absolute server path and return form payload."""
    p = Path(body.path.strip())
    if not p.is_absolute():
        raise HTTPException(status_code=400, detail="Path must be absolute.")
    if not p.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {p}")
    if not p.is_file():
        raise HTTPException(status_code=400, detail=f"Not a file: {p}")
    try:
        yaml_text = p.read_text(encoding="utf-8")
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Cannot read file: {exc}")
    try:
        payload = _yaml_to_form_payload(yaml_text)
    except TrainingValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"payload": payload}


@app.post("/training/import-yaml")
async def import_training_yaml_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    """Parse an uploaded YAML file and return form payload."""
    try:
        content = await file.read()
        yaml_text = content.decode("utf-8", errors="replace")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot read upload: {exc}")
    try:
        payload = _yaml_to_form_payload(yaml_text)
    except TrainingValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"payload": payload}


# -------------------------------------------------------------------
# Presets (existing section, with 'training' added to allowed pages)
# -------------------------------------------------------------------
_VALID_PRESET_PAGES = {"generation", "structure-guided", "training"}


class PresetCreateBody(BaseModel):
    name: str
    config: Dict[str, Any]


@app.get("/presets/{page}")
def list_presets(page: str):
    if page not in _VALID_PRESET_PAGES:
        raise HTTPException(status_code=400, detail=f"Invalid preset page '{page}'.")
    page_dir = PRESETS_DIR / page
    try:
        page_dir.mkdir(parents=True, exist_ok=True)
        presets = []
        for f in page_dir.glob("*.json"):
            try:
                presets.append(json.loads(f.read_text()))
            except Exception:
                pass
        presets.sort(key=lambda p: p.get("createdAt", ""))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read presets: {exc}")
    return {"presets": presets}


@app.post("/presets/{page}")
def create_preset(page: str, body: PresetCreateBody):
    if page not in _VALID_PRESET_PAGES:
        raise HTTPException(status_code=400, detail=f"Invalid preset page '{page}'.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Preset name must not be empty.")
    page_dir = PRESETS_DIR / page
    try:
        page_dir.mkdir(parents=True, exist_ok=True)
        preset_id = str(uuid.uuid4())
        preset = {
            "id": preset_id,
            "name": name,
            "page": page,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "config": body.config,
        }
        (page_dir / f"{preset_id}.json").write_text(json.dumps(preset, indent=2))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not save preset: {exc}")
    return preset


@app.delete("/presets/{page}/{preset_id}")
def delete_preset(page: str, preset_id: str):
    if page not in _VALID_PRESET_PAGES:
        raise HTTPException(status_code=400, detail=f"Invalid preset page '{page}'.")
    f = PRESETS_DIR / page / f"{preset_id}.json"
    try:
        if f.exists():
            f.unlink()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not delete preset: {exc}")
    return {"ok": True}


@app.get("/healthz")
def healthz():
    tools, errors = discover_tools()
    # Cheap dir listing only — no model unpickling on a health check.
    model_count = 0
    if GEN_MODELS_DIR.exists():
        model_count = sum(
            1
            for p in GEN_MODELS_DIR.iterdir()
            if p.is_dir() and (p / "edm_chem.pkl").exists()
        )
    return {
        "ok": True,
        "ase_cached": len(ASE_XYZ),
        "tools": len(tools),
        "tool_errors": len(errors),
        "generation_models": model_count,
        "molcraft_available": shutil.which(MOLCRAFT_CMD) is not None,
    }


# -------------------------------------------------------------------
# Serve built frontend (so users can run uvicorn only)
# IMPORTANT: this is added at the end so /xyz and /ase/load still work.
# -------------------------------------------------------------------
#HERE = Path(__file__).parent.resolve()
#DIST = (HERE.parent / "frontend" / "dist").resolve()
#if DIST.exists():
#    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="static")
#


HERE = Path(__file__).parent.resolve()
DIST = (HERE.parent / "frontend" / "dist").resolve()

print(f"[frontend] main.py location: {HERE}")
print(f"[frontend] serving dist from: {DIST}")
print(f"[frontend] dist exists: {DIST.exists()}")

if DIST.exists():
    app.mount("/", StaticFiles(directory=str(DIST), html=True), name="static")
