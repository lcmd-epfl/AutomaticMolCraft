from typing import Dict, List, Tuple
import numpy as np


def _read_xyz_coords_from_text(xyz_text: str) -> np.ndarray:
    """
    Reads XYZ text and returns coordinates as shape (n_atoms, 3).
    Expected format:
      line 1: atom count
      line 2: comment
      remaining: symbol x y z
    """
    text = xyz_text.strip().splitlines()
    if len(text) < 3:
        raise ValueError("XYZ text is too short")

    try:
        n_atoms = int(text[0].strip())
    except Exception as exc:
        raise ValueError("First line is not a valid atom count") from exc

    atom_lines = text[2:]
    if len(atom_lines) < n_atoms:
        raise ValueError("XYZ text has fewer atom lines than declared")

    coords: List[List[float]] = []
    for i in range(n_atoms):
        parts = atom_lines[i].split()
        if len(parts) < 4:
            raise ValueError(f"Invalid atom line {i+3}")
        try:
            x = float(parts[1])
            y = float(parts[2])
            z = float(parts[3])
        except Exception as exc:
            raise ValueError(f"Invalid coordinates at line {i+3}") from exc
        coords.append([x, y, z])

    arr = np.asarray(coords, dtype=float)
    if arr.shape != (n_atoms, 3):
        raise ValueError(f"Unexpected coordinate shape: {arr.shape}")
    return arr


def _pairwise_distances(coords: np.ndarray) -> np.ndarray:
    n = coords.shape[0]
    if n < 2:
        return np.asarray([], dtype=float)

    diff = coords[:, None, :] - coords[None, :, :]
    dmat = np.sqrt(np.sum(diff * diff, axis=2))
    iu = np.triu_indices(n, k=1)
    return dmat[iu]


def _compute_descriptor(coords: np.ndarray) -> List[float]:
    n_atoms = int(coords.shape[0])
    dists = _pairwise_distances(coords)

    if dists.size == 0:
        mean_pair = 0.0
        std_pair = 0.0
        max_pair = 0.0
    else:
        mean_pair = float(np.mean(dists))
        std_pair = float(np.std(dists))
        max_pair = float(np.max(dists))

    return [float(n_atoms), mean_pair, std_pair, max_pair]


def run_tool(dataset: Dict, params: Dict) -> Dict:
    ids = dataset.get("ids", [])
    xyz_by_id = dataset.get("xyzById", {}) or {}
    descriptor_name = (params.get("descriptor_name") or "basic_geom").strip()

    if not descriptor_name:
        raise ValueError("Descriptor name must be non-empty")

    values_by_id: Dict[str, List[float]] = {}
    missing_ids: List[str] = []
    failed_ids: List[Tuple[str, str]] = []

    for entry_id in ids:
        xyz_text = xyz_by_id.get(entry_id)
        if not xyz_text:
            missing_ids.append(entry_id)
            continue

        try:
            coords = _read_xyz_coords_from_text(xyz_text)
            desc = _compute_descriptor(coords)
            values_by_id[entry_id] = desc
        except Exception as exc:
            failed_ids.append((entry_id, str(exc)))

    warnings: List[str] = []
    if missing_ids:
        warnings.append(
            f"{len(missing_ids)} entries have no loaded XYZ content and did not receive descriptor values."
        )
    if failed_ids:
        warnings.append(
            f"{len(failed_ids)} entries failed during descriptor generation."
        )

    return {
        "message": f"Generated descriptor '{descriptor_name}'.",
        "warnings": warnings,
        "addDescriptor": {
            "name": descriptor_name,
            "valuesById": values_by_id,
            "dtype": "float32",
            "source": {
                "kind": "tool",
                "label": "Basic geom descriptor"
            }
        },
        "stats": {
            "dim": 4,
            "nPresent": len(values_by_id),
            "nMissingLoadedXyz": len(missing_ids),
            "nFailed": len(failed_ids)
        }
    }
