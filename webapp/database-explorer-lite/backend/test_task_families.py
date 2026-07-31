"""Check that every Hydra config group this backend names actually exists.

The registries here are plain string tables; a typo or a renamed upstream group
only surfaces as a MissingConfigException minutes into a training or generation
job. Run this after touching TASK_FAMILIES or TASK_TYPE_TO_TASKS_CONFIG:

    python test_task_families.py

Locates configs/tasks/ via the installed MolecularDiffusion package, falling
back to MOLCRAFT_SRC or the sibling source checkout. Skips if none is found.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _tasks_dir() -> Path | None:
    try:
        import MolecularDiffusion

        candidate = Path(MolecularDiffusion.__file__).parent / "configs" / "tasks"
        if candidate.is_dir():
            return candidate
    except Exception:
        pass

    roots = []
    if os.environ.get("MOLCRAFT_SRC"):
        roots.append(Path(os.environ["MOLCRAFT_SRC"]))
    roots.append(Path(__file__).resolve().parents[4] / "MolCraftDiffusion")
    for root in roots:
        candidate = root / "src" / "MolecularDiffusion" / "configs" / "tasks"
        if candidate.is_dir():
            return candidate
    return None


def main() -> int:
    sys.path.insert(0, str(Path(__file__).parent))
    from training_config import PUBLIC_TASK_FAMILIES, TASK_FAMILIES

    unknown = PUBLIC_TASK_FAMILIES - set(TASK_FAMILIES)
    assert not unknown, f"PUBLIC_TASK_FAMILIES names families that do not exist: {sorted(unknown)}"

    tasks_dir = _tasks_dir()
    if tasks_dir is None:
        print("SKIP: no MolecularDiffusion configs/tasks/ found")
        return 0

    available = {p.stem for p in tasks_dir.glob("*.yaml")}

    missing = sorted(
        (name, meta["tasks_config"])
        for name, meta in TASK_FAMILIES.items()
        if meta["tasks_config"] not in available
    )
    assert not missing, f"TASK_FAMILIES point at absent task configs: {missing}"

    import main as backend

    # Not an assertion: a checkpoint of type X cannot exist unless the package can train
    # X, so a mapping ahead of the installed package is inert rather than wrong. Report
    # it so the gap stays visible when the package lags the source tree.
    ahead = sorted(v for v in backend.TASK_TYPE_TO_TASKS_CONFIG.values() if v not in available)
    if ahead:
        print(f"NOTE: task_type mappings not in this package (inert until it is updated): {ahead}")

    # An unmapped or absent task_type must fall back to the previous hardcoded group.
    assert backend._tasks_config_from_checkpoint(None) == "diffusion"
    assert backend._tasks_config_from_checkpoint({}) == "diffusion"
    assert backend._tasks_config_from_checkpoint({"task_type": "not_a_task"}) == "diffusion"
    assert (
        backend._tasks_config_from_checkpoint({"hyperparameters": {"task_type": "diffusion_flowmol"}})
        == "diffusion_flowmol"
    )
    assert backend._tasks_config_from_checkpoint({"task_type": "diffusion_tabasco"}) == "diffusion_tabasco"

    print(f"OK: {len(TASK_FAMILIES)} task families + {len(backend.TASK_TYPE_TO_TASKS_CONFIG)} task_type mappings resolve against {tasks_dir}")

    assert backend._version_at_least("1.6.0", "1.6") is True
    assert backend._version_at_least("1.4.0", "1.6.0") is False
    assert backend._version_at_least(None, "1.6.0") is None

    # Last, so the group checks above still report when the package is behind.
    found = backend._molcraft_version()
    assert backend._version_at_least(found, backend.MOLCRAFT_MIN_VERSION) is not False, (
        f"molcraftdiffusion {found} is older than the required "
        f"{backend.MOLCRAFT_MIN_VERSION}; reinstall from the current source tree"
    )
    if found is None:
        print("NOTE: molcraftdiffusion not importable from this interpreter; version unchecked")
    else:
        print(f"OK: molcraftdiffusion {found} >= {backend.MOLCRAFT_MIN_VERSION}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
