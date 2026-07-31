"""Check the structure-guidance config the backend emits.

The placement block is gated on init_method and skeleton_type, and getting it wrong
fails inside the sampler rather than at request time. The jitter_scale case is the one
that matters most: en_diffusion._resolve_jitter_scale raises instead of defaulting, so
omitting it kills every sampling batch.

    python test_structure_guidance.py
"""
from __future__ import annotations

import pathlib
import sys


def main() -> int:
    sys.path.insert(0, str(pathlib.Path(__file__).parent))
    import main as b

    xyz = "3\n\nC 0 0 0\nC 1 0 0\nO 2 0 0\n"
    model = {"id": "m", "path": "/tmp/m", "properties": ["S1_exc"], "tasks_config": "diffusion"}

    def cfgs(sg, **kw):
        fields = dict(
            model_id="m", num_generate=2, batch_size=1, seed=1, n_frames=1,
            diffusion_steps=50, size_mode="fixed", fixed_size=10, max_size=10,
            property_targets=[],
            structure_guidance={"reference_xyz": xyz, "sampling_mode": "sample", **sg},
        )
        fields.update(kw)
        payload = b.GenerationJobRequest(**fields)
        built, _ = b._validate_structure_guidance(payload, model)
        cc = built["condition_configs"]
        return cc.get("inpaint_cfgs") or cc.get("outpaint_cfgs")

    out = {"mode": "outpaint", "selected_indices": [0], "connector_bonds": {"0": 2}}

    # Default path: skeleton + random_walk + jitter. jitter_scale must be present.
    d = cfgs(out)
    assert d["jitter_scale"] == b.DEFAULT_JITTER_SCALE, d
    assert d["skeleton_type"] == "random_walk" and "spread" in d, d
    assert d["connectors"] == {0: [2]}, d

    # Inpaint reads the same keys for extended inpainting, including jitter_scale.
    d = cfgs({"mode": "inpaint", "selected_indices": [1]})
    assert d["jitter_scale"] == b.DEFAULT_JITTER_SCALE, d
    assert d["mask_node_index"] == [1], d

    # Non-random_walk builders ignore spread, so it must not be emitted.
    d = cfgs({**out, "skeleton_type": "aromatic_ring"})
    assert "spread" not in d, d
    assert d["bond_len"] == 1.5, d

    # forward_noise off means no jitter_scale is required or sent.
    d = cfgs({**out, "forward_noise": "off"})
    assert "jitter_scale" not in d, d

    # seed placement: spread is a position sigma, no skeleton/bond/noise knobs.
    d = cfgs({**out, "init_method": "seed", "n_bq_atom": 2})
    assert d["n_bq_atom"] == 2 and "spread" in d, d
    for absent in ("skeleton_type", "bond_len", "forward_noise", "jitter_scale"):
        assert absent not in d, (absent, d)

    # outpaintft ignores the bonding degree and adds t_critical.
    d = cfgs({**out, "mode": "outpaintft", "t_critical": 0.1})
    assert d["connectors"] == {0: [0]}, d
    assert d["t_critical"] == 0.1, d

    # Zero connectors are only allowed for seed placement with phantom atoms.
    d = cfgs({"mode": "outpaint", "selected_indices": [], "init_method": "seed", "n_bq_atom": 1})
    assert d["connectors"] == {}, d
    for bad, label in (
        ({"mode": "outpaint", "selected_indices": []}, "no connectors, skeleton"),
        ({**out, "init_method": "nope"}, "bad init_method"),
        ({**out, "skeleton_type": "nope"}, "bad skeleton_type"),
        ({**out, "forward_noise": "nope"}, "bad forward_noise"),
    ):
        try:
            cfgs(bad)
        except Exception:
            pass
        else:
            raise AssertionError(f"expected rejection: {label}")

    # Inpaint no longer enforces a lower size bound; the model snaps mol_size up.
    cfgs({"mode": "inpaint", "selected_indices": [0]}, fixed_size=2, max_size=2)

    print("OK: structure-guidance placement gating")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
