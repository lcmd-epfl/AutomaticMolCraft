import numpy as np


def run_tool(dataset, params):
    ids = dataset.get("ids", [])
    descriptors = dataset.get("descriptors", {}) or {}

    descriptor_name = (params.get("descriptor_name") or "").strip()
    if not descriptor_name:
        raise ValueError("Descriptor name must be provided")

    if descriptor_name not in descriptors:
        raise ValueError(f"Descriptor '{descriptor_name}' not found in dataset")

    desc = descriptors[descriptor_name]
    values_by_id = desc.get("valuesById", {}) or {}

    present_ids = [entry_id for entry_id in ids if entry_id in values_by_id]
    missing_ids = [entry_id for entry_id in ids if entry_id not in values_by_id]

    if len(present_ids) < 2:
        raise ValueError(
            f"Descriptor '{descriptor_name}' has only {len(present_ids)} available entries; at least 2 are needed for PCA"
        )

    X = np.asarray([values_by_id[entry_id] for entry_id in present_ids], dtype=float)
    if X.ndim != 2:
        raise ValueError("Descriptor matrix is not 2-dimensional")

    n_samples, n_features = X.shape
    if n_features < 2:
        raise ValueError(
            f"Descriptor '{descriptor_name}' has dimension {n_features}; at least 2 are needed for a 2D PCA"
        )

    # Center
    X_centered = X - np.mean(X, axis=0, keepdims=True)

    # PCA via SVD
    U, S, Vt = np.linalg.svd(X_centered, full_matrices=False)

    scores = X_centered @ Vt.T
    pc1_scores = scores[:, 0]
    pc2_scores = scores[:, 1]

    pc1_name = (params.get("pc1_name") or f"{descriptor_name}_pc1").strip()
    pc2_name = (params.get("pc2_name") or f"{descriptor_name}_pc2").strip()

    pc1_map = {entry_id: float(v) for entry_id, v in zip(present_ids, pc1_scores)}
    pc2_map = {entry_id: float(v) for entry_id, v in zip(present_ids, pc2_scores)}

    pc1_values = [pc1_map.get(entry_id, None) for entry_id in ids]
    pc2_values = [pc2_map.get(entry_id, None) for entry_id in ids]

    warnings = []
    if missing_ids:
        warnings.append(
            f"{len(missing_ids)} entries had no descriptor '{descriptor_name}' and received null PCA values."
        )

    explained_variance = (S ** 2) / max(1, (n_samples - 1))
    total_var = float(np.sum(explained_variance))
    evr1 = float(explained_variance[0] / total_var) if total_var > 0 else 0.0
    evr2 = float(explained_variance[1] / total_var) if total_var > 0 else 0.0

    return {
        "message": f"Computed PCA for descriptor '{descriptor_name}' and added two numeric columns.",
        "warnings": warnings,
        "addColumns": [
            {
                "name": pc1_name,
                "kind": "numeric",
                "values": pc1_values
            },
            {
                "name": pc2_name,
                "kind": "numeric",
                "values": pc2_values
            }
        ],
        "stats": {
            "descriptor": descriptor_name,
            "nPresent": len(present_ids),
            "nMissing": len(missing_ids),
            "dim": int(n_features),
            "pc1ExplainedVarianceRatio": evr1,
            "pc2ExplainedVarianceRatio": evr2
        }
    }
