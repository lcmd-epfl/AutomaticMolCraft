"""Training config builder and validator for MolCraftDiff train."""
from __future__ import annotations

import re
from typing import Any


# ---------------------------------------------------------------------------
# Task family registry
# ---------------------------------------------------------------------------
#
# Every `tasks_config` here MUST name a real file in the installed package's
# configs/tasks/ directory — Hydra raises MissingConfigException at job start
# otherwise. This registry was originally written against MolCraftDiffusion_dev/,
# which carries task groups the shipped package does not; those entries are gone.
#
# Deliberately still absent, because they need a `data:` group other than the
# mol_dataset that build_yaml_dict hardcodes: diffusion_{adit,difflinker,diffpharma,
# diffsmol,extraf,flowmol,geoldm,gfmdiff,pmdm}, vae_geoldm.

TASK_FAMILIES: dict[str, dict[str, Any]] = {
    "diffusion": {
        "label": "Diffusion (EGCL)",
        "tasks_config": "diffusion",
        "trainer_config": "default",
        "category": "diffusion",
    },
    "diffusion_pretrained": {
        "label": "Diffusion (EGCL, pretrained defaults)",
        "tasks_config": "diffusion_pretrained",
        "trainer_config": "default",
        "category": "diffusion",
    },
    "diffusion_egt": {
        "label": "Diffusion (EGT)",
        "tasks_config": "diffusion_egt",
        "trainer_config": "default",
        "category": "diffusion",
    },
    "diffusion_tabasco": {
        "label": "Tabasco (Flow)",
        "tasks_config": "diffusion_tabasco",
        "trainer_config": "default",
        "category": "diffusion",
    },
    "regression": {
        "label": "Regression (EGCL)",
        "tasks_config": "regression",
        "trainer_config": "regression",
        "category": "regression",
        "data_type": "pyg",
    },
    "regression_esen": {
        "label": "Regression (eSEN)",
        "tasks_config": "regression_esen",
        "trainer_config": "regression",
        "category": "regression",
        "data_type": "pyg",
    },
    "regression_equiformer": {
        "label": "Regression (EquiformerV2)",
        "tasks_config": "regression_equiformer",
        "trainer_config": "regression",
        "category": "regression",
        "data_type": "pyg",
    },
    "ssl3d_egcl": {
        "label": "SSL-3D (EGCL)",
        "tasks_config": "ssl3d_egcl",
        "trainer_config": "default",
        "category": "ssl3d",
    },
    "ssl3d_egt": {
        "label": "SSL-3D (EGT)",
        "tasks_config": "ssl3d_egt",
        "trainer_config": "default",
        "category": "ssl3d",
    },
    "ssl3d_esen": {
        "label": "SSL-3D (eSEN)",
        "tasks_config": "ssl3d_esen",
        "trainer_config": "default",
        "category": "ssl3d",
    },
    "ssl3d_equiformer": {
        "label": "SSL-3D (Equiformer)",
        "tasks_config": "ssl3d_equiformer",
        "trainer_config": "default",
        "category": "ssl3d",
    },
    "vae_equiformer": {
        "label": "VAE (Equiformer)",
        "tasks_config": "vae_equiformer",
        "trainer_config": "default",
        "category": "vae",
    },
    "vae_transformer": {
        "label": "VAE (Transformer)",
        "tasks_config": "vae_transformer",
        "trainer_config": "default",
        "category": "vae",
    },
    "guidance": {
        "label": "Guidance (EGCL)",
        "tasks_config": "guidance",
        "trainer_config": "default",
        "category": "guidance",
    },
    "guidance_esen": {
        "label": "Guidance (eSEN)",
        "tasks_config": "guidance_esen",
        "trainer_config": "default",
        "category": "guidance",
    },
}

# Families exposed in public / open-source mode (MOLCRAFT_ALL_FAMILIES unset).
# Set MOLCRAFT_ALL_FAMILIES=1 to unlock the full list.
PUBLIC_TASK_FAMILIES: frozenset[str] = frozenset({
    "diffusion",
    "diffusion_pretrained",
    "diffusion_egt",
    "diffusion_tabasco",
    "regression",
    "regression_esen",
    "regression_equiformer",
    "ssl3d_egcl",
    "ssl3d_egt",
    "ssl3d_esen",
    "ssl3d_equiformer",
    "vae_equiformer",
    "vae_transformer",
    "guidance",
    "guidance_esen",
})


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

class ValidationError(ValueError):
    pass


def _require(payload: dict[str, Any], key: str, label: str) -> Any:
    v = payload.get(key)
    if v is None or v == "" or v == []:
        raise ValidationError(f"{label} is required.")
    return v


def validate_payload(payload: dict[str, Any]) -> None:
    """Raise ValidationError if payload is invalid for its task_family."""
    task_family = _require(payload, "task_family", "Task family")
    if task_family not in TASK_FAMILIES:
        raise ValidationError(f"Unknown task family: {task_family!r}")

    category = TASK_FAMILIES[task_family]["category"]

    # Data section
    _require(payload, "dataset_name", "Dataset name")
    data_root = payload.get("data_root", "")
    if not data_root:
        raise ValidationError("Data root is required.")

    has_csv = bool(payload.get("csv_path", ""))
    has_xyz = bool(payload.get("xyz_dir", ""))
    has_ase = bool(payload.get("ase_db_path", ""))
    if not has_csv and not has_ase:
        raise ValidationError("Either CSV path or ASE DB path is required.")
    if has_csv and not has_xyz and not has_ase:
        raise ValidationError("XYZ directory is required when using CSV input.")

    # Task-specific
    if category == "regression":
        task_learn = payload.get("task_learn", [])
        if not task_learn or not isinstance(task_learn, list):
            raise ValidationError(
                "Regression task requires at least one property column in 'task_learn'."
            )

    if category in ("diffusion", "flow_matching"):
        steps = payload.get("diffusion_steps", 0)
        try:
            steps_int = int(steps) if steps else 0
        except (TypeError, ValueError):
            raise ValidationError("diffusion_steps must be an integer greater than 0.")
        if steps_int <= 0:
            raise ValidationError("diffusion_steps must be greater than 0.")

    if category == "ssl3d":
        if not payload.get("ssl3d_denoise_weight") and payload.get("ssl3d_denoise_weight", 0) <= 0:
            pass  # allow 0; it just means that objective is off

    if category == "vae":
        if not payload.get("latent_dim", 0):
            raise ValidationError("VAE task requires latent_dim > 0.")

    # Trainer
    num_epochs = payload.get("num_epochs", 0)
    num_steps = payload.get("num_steps", None)
    if not num_epochs and not num_steps:
        raise ValidationError("Either num_epochs or num_steps must be set.")

    output_path = payload.get("output_path", "")
    if not output_path:
        raise ValidationError("Trainer output_path is required.")


# ---------------------------------------------------------------------------
# YAML generation
# ---------------------------------------------------------------------------

def _atom_vocab(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("atom_vocab", "")
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        return [s.strip() for s in raw.replace(",", " ").split() if s.strip()]
    return ["H", "B", "C", "N", "O", "F", "Al", "Si", "P", "S", "Cl", "As", "Se", "Br", "I"]


def _condition_names(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("condition_names", "")
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        return [s.strip() for s in raw.replace(",", " ").split() if s.strip()]
    return []


def _string_list(payload: dict[str, Any], key: str) -> list[str]:
    raw = payload.get(key, [])
    if isinstance(raw, list):
        return [str(v).strip() for v in raw if str(v).strip()]
    if isinstance(raw, str) and raw.strip():
        return [s.strip() for s in raw.replace(",", " ").split() if s.strip()]
    return []


def _tags(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("tags", "")
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        return [s.strip() for s in raw.split(",") if s.strip()]
    return []


def _maybe(d: dict[str, Any], key: str, default: Any = None) -> Any:
    v = d.get(key, default)
    return v if v != "" else default


def build_yaml_dict(payload: dict[str, Any], output_path: str) -> dict[str, Any]:
    """Build the Hydra-compatible config dict from form payload."""
    task_family = payload["task_family"]
    meta = TASK_FAMILIES[task_family]
    category = meta["category"]
    trainer_cfg = meta["trainer_config"]
    data_type = meta.get("data_type", payload.get("data_type", "pointcloud"))

    atom_vocab = _atom_vocab(payload)
    condition_names = _condition_names(payload)

    # ------------------------------------------------------------------
    # defaults list (Hydra composition)
    # ------------------------------------------------------------------
    cfg: dict[str, Any] = {
        "defaults": [
            {"data": "mol_dataset"},
            {"tasks": meta["tasks_config"]},
            {"trainer": trainer_cfg},
            {"logger": "default"},
            {"engine": payload.get("engine_type", "original")},
            {"hydra": "default"},
            "_self_",
        ]
    }

    # Top-level
    if payload.get("name"):
        cfg["name"] = payload["name"]
    cfg["seed"] = int(payload.get("seed", 42))
    tags = _tags(payload)
    if tags:
        cfg["tags"] = tags

    # ------------------------------------------------------------------
    # data block
    # ------------------------------------------------------------------
    data: dict[str, Any] = {
        "root": payload.get("data_root", "data/"),
        "dataset_name": payload["dataset_name"],
        "data_type": data_type,
        "atom_vocab": atom_vocab,
        "batch_size": int(payload.get("batch_size", 48)),
        "max_atom": int(payload.get("max_atom", 86)),
        "with_hydrogen": bool(payload.get("with_hydrogen", True)),
        "use_ohe_feature": bool(payload.get("use_ohe_feature", True)),
        "allow_unknown": bool(payload.get("allow_unknown", False)),
        "data_efficient_collator": bool(payload.get("data_efficient_collator", True)),
        "train_ratio": float(payload.get("train_ratio", 0.8)),
    }
    csv_path = payload.get("csv_path", "")
    xyz_dir = payload.get("xyz_dir", "")
    ase_db = payload.get("ase_db_path", "")
    if ase_db:
        data["ase_db_path"] = ase_db
    else:
        if csv_path:
            data["filename"] = csv_path
        if xyz_dir:
            data["xyz_dir"] = xyz_dir
    # Target fields for regression / conditional
    if condition_names:
        data["target_fields"] = condition_names
    cfg["data"] = data

    # ------------------------------------------------------------------
    # tasks block
    # ------------------------------------------------------------------
    tasks: dict[str, Any] = {
        "atom_vocab": "${data.atom_vocab}",
        "condition_names": condition_names,
        "hidden_size": int(payload.get("hidden_size", 256)),
        "num_layers": int(payload.get("num_layers", 9)),
        "num_sublayers": int(payload.get("num_sublayers", 1)),
        "dropout": float(payload.get("dropout", 0.0)),
        "attention": bool(payload.get("attention", True)),
        "tanh": bool(payload.get("tanh", True)),
    }

    # Category-specific fields
    if category in ("diffusion", "flow_matching"):
        tasks["diffusion_steps"] = int(payload.get("diffusion_steps", 500))
        tasks["diffusion_noise_schedule"] = payload.get(
            "diffusion_noise_schedule", "polynomial_2"
        )
        tasks["diffusion_loss_type"] = payload.get("diffusion_loss_type", "vlb")
        tasks["normalize_factors"] = payload.get(
            "normalize_factors", [1.0, 4.0, 10.0]
        )
        tasks["context_mask_rate"] = float(payload.get("context_mask_rate", 0.0))
        tasks["mask_value"] = int(payload.get("mask_value", 5))
        normalize_condition = payload.get("normalize_condition", "value_10")
        tasks["normalize_condition"] = (
            None
            if normalize_condition in (None, "", "none", "None")
            else normalize_condition
        )
        tasks["sp_regularizer_deploy"] = bool(
            payload.get("sp_regularizer_deploy", False)
        )
        if tasks["sp_regularizer_deploy"]:
            tasks["sp_regularizer_regularizer"] = payload.get(
                "sp_regularizer_regularizer", "hard"
            )
            tasks["sp_regularizer_lambda_"] = float(
                payload.get("sp_regularizer_lambda_", 0)
            )
            tasks["sp_regularizer_lambda_2"] = float(
                payload.get("sp_regularizer_lambda_2", 1000)
            )
            tasks["sp_regularizer_lambda_update_value"] = float(
                payload.get("sp_regularizer_lambda_update_value", 1)
            )
            tasks["sp_regularizer_lambda_update_step"] = int(
                payload.get("sp_regularizer_lambda_update_step", 100)
            )
            tasks["sp_regularizer_polynomial_p"] = float(
                payload.get("sp_regularizer_polynomial_p", 1.1)
            )
            tasks["sp_regularizer_warm_up_steps"] = int(
                payload.get("sp_regularizer_warm_up_steps", 100)
            )
        tasks["use_adapter_module"] = bool(payload.get("use_adapter_module", False))
        tasks["adapter_conditions"] = _string_list(payload, "adapter_conditions")
        tasks["n_samples"] = int(payload.get("n_samples", 48))
        tasks["generative_analysis"] = bool(payload.get("generative_analysis", True))
        tasks["use_posebuster"] = bool(payload.get("use_posebuster", True))
        if payload.get("chkpt_path"):
            tasks["chkpt_path"] = payload["chkpt_path"]

    if category == "flow_matching":
        tasks["fm_min_t"] = float(payload.get("fm_min_t", 0.01))
        tasks["fm_num_timesteps"] = int(payload.get("fm_num_timesteps", 100))
        tasks["fm_self_condition"] = bool(payload.get("fm_self_condition", False))
        tasks["use_velocity"] = bool(payload.get("use_velocity", False))

    if category == "regression":
        task_learn = payload.get("task_learn", [])
        if isinstance(task_learn, str):
            task_learn = [s.strip() for s in task_learn.split(",") if s.strip()]
        tasks["task_learn"] = task_learn
        tasks["criterion"] = payload.get("criterion", "mse")
        tasks["metric"] = payload.get("metric", ["mae"])
        tasks["num_mlp_layer"] = int(payload.get("num_mlp_layer", 3))
        tasks["mlp_batch_norm"] = payload.get("mlp_batch_norm", "batchnorm")
        tasks["target_normalization"] = bool(payload.get("target_normalization", True))
        tasks["mlp_dropout"] = float(payload.get("mlp_dropout", 0.2))
        tasks["prediction_mlp_type"] = payload.get("prediction_mlp_type", "pernode")

    if category == "ssl3d":
        tasks["ssl3d_denoise_weight"] = float(payload.get("ssl3d_denoise_weight", 1.0))
        tasks["ssl3d_mask_rate"] = float(payload.get("ssl3d_mask_rate", 0.15))
        tasks["ssl3d_mtype_weight"] = float(payload.get("ssl3d_mtype_weight", 0.5))
        tasks["ssl3d_sigma_min"] = float(payload.get("ssl3d_sigma_min", 0.01))
        tasks["ssl3d_sigma_max"] = float(payload.get("ssl3d_sigma_max", 2.0))
        tasks["ssl3d_sigma_schedule"] = payload.get("ssl3d_sigma_schedule", "uniform")

    if category == "vae":
        tasks["latent_dim"] = int(payload.get("latent_dim", 8))
        tasks["augment_noise"] = float(payload.get("augment_noise", 0.1))
        tasks["augment_rotation"] = bool(payload.get("augment_rotation", True))
        raw_lw = payload.get("loss_weights", {})
        if isinstance(raw_lw, dict):
            tasks["loss_weights"] = raw_lw
        else:
            tasks["loss_weights"] = {"pos": 1.0, "atom_types": 1.0, "kl": 0.0001}

    cfg["tasks"] = tasks

    # ------------------------------------------------------------------
    # trainer block
    # ------------------------------------------------------------------
    trainer: dict[str, Any] = {
        "optimizer_choice": payload.get("optimizer_choice", "adamw"),
        "lr": float(payload.get("lr", 2e-4)),
        "weight_decay": float(payload.get("weight_decay", 1e-12)),
        "betas": payload.get("betas", [0.9, 0.999]),
        "scheduler": payload.get("scheduler", "cosineannealing"),
        "validation_interval": int(payload.get("validation_interval", 3)),
        "output_path": output_path,
        "ema_decay": float(payload.get("ema_decay", 0.9999)),
        "precision": payload.get("precision", 32),
        "save_top_k": int(payload.get("save_top_k", 3)),
        "save_every_val_epoch": bool(payload.get("save_every_val_epoch", False)),
        "gradient_clip_mode": payload.get("gradient_clip_mode", "norm"),
        "init_grad_norm": float(payload.get("init_grad_norm", 3000.0)),
    }

    num_epochs = payload.get("num_epochs")
    num_steps = payload.get("num_steps")
    if num_steps:
        trainer["num_steps"] = int(num_steps)
    else:
        trainer["num_epochs"] = int(num_epochs or 200)

    sched_kw = payload.get("scheduler_kwargs")
    if sched_kw and isinstance(sched_kw, dict):
        trainer["scheduler_kwargs"] = sched_kw
    elif trainer["scheduler"] == "cosineannealing":
        trainer["scheduler_kwargs"] = {
            "T_max": trainer.get("num_epochs", 200),
            "eta_min": 1e-6,
        }

    if payload.get("resume_from_checkpoint"):
        trainer["resume_from_checkpoint"] = payload["resume_from_checkpoint"]
    if payload.get("load_weights_from"):
        trainer["load_weights_from"] = payload["load_weights_from"]
    if payload.get("monitor_metric"):
        trainer["monitor_metric"] = payload["monitor_metric"]
        trainer["monitor_mode"] = payload.get("monitor_mode", "max")

    cfg["trainer"] = trainer

    # ------------------------------------------------------------------
    # logger block
    # ------------------------------------------------------------------
    logger: dict[str, Any] = {
        "logger": payload.get("logger_backend", "logging"),
        "log_interval": int(payload.get("log_interval", 2)),
        "dir_wandb": "${trainer.output_path}",
    }
    if logger["logger"] == "wandb":
        logger["name_wandb"] = payload.get("wandb_name", "MolecularDiffusion")
        logger["project_wandb"] = payload.get("wandb_project", "MolecularDiffusion")
        if payload.get("wandb_tags"):
            logger["tags"] = payload["wandb_tags"]
    cfg["logger"] = logger

    # ------------------------------------------------------------------
    # engine block (inline, not via defaults key)
    # ------------------------------------------------------------------
    engine_type = payload.get("engine_type", "original")
    if engine_type == "lightning":
        cfg["engine"] = {
            "engine_type": "lightning",
            "num_workers": int(payload.get("num_workers", 2)),
            "pin_memory": bool(payload.get("pin_memory", False)),
            "persistent_workers": bool(payload.get("persistent_workers", False)),
        }

    return cfg


def build_yaml_text(payload: dict[str, Any], output_path: str) -> str:
    """Return the YAML string for the given payload."""
    import yaml as _yaml
    cfg = build_yaml_dict(payload, output_path)
    return _yaml.dump(cfg, sort_keys=False, default_flow_style=False, allow_unicode=True)


# ---------------------------------------------------------------------------
# YAML → form payload (reverse direction: import existing config)
# ---------------------------------------------------------------------------

def _resolve_interpolations(cfg: dict[str, Any]) -> dict[str, Any]:
    """Resolve simple ${var} Hydra interpolations using top-level scalar vars."""
    scalars: dict[str, str] = {}
    for k, v in cfg.items():
        if isinstance(v, (str, int, float, bool)) and v is not None:
            scalars[k] = str(v)
        elif isinstance(v, list) and all(isinstance(i, str) for i in v):
            # e.g. contexts: ["a", "b"] → "${contexts}" → "a, b" (not Python repr)
            scalars[k] = ", ".join(v)

    def _sub(val: Any) -> Any:
        if isinstance(val, str):
            def replacer(m: re.Match) -> str:  # type: ignore[type-arg]
                return scalars.get(m.group(1), m.group(0))
            return re.sub(r"\$\{([^}]+)\}", replacer, val)
        if isinstance(val, list):
            return [_sub(v) for v in val]
        if isinstance(val, dict):
            return {k: _sub(v) for k, v in val.items()}
        return val

    return {k: _sub(v) for k, v in cfg.items()}


def _join_list(val: Any, sep: str = ", ") -> str:
    if isinstance(val, list):
        return sep.join(str(v) for v in val)
    if val is None:
        return ""
    return str(val)


def _str(val: Any, default: Any = "") -> str:
    if val is None:
        return str(default)
    return str(val)


def yaml_to_form_payload(yaml_text: str) -> dict[str, Any]:
    """
    Parse an existing MolCraftDiff training YAML and return a form payload dict
    that matches the frontend FormState shape.
    """
    import yaml as _yaml

    try:
        raw = _yaml.safe_load(yaml_text)
    except _yaml.YAMLError as exc:
        raise ValidationError(f"Invalid YAML: {exc}")

    if not isinstance(raw, dict):
        raise ValidationError("YAML root must be a mapping.")

    # ------------------------------------------------------------------
    # Extract task family + profile choices from defaults list
    # ------------------------------------------------------------------
    defaults = raw.get("defaults", [])
    task_family = "diffusion"
    logger_from_defaults = None
    engine_from_defaults = "original"

    for item in defaults:
        if isinstance(item, dict):
            if "tasks" in item:
                task_family = item["tasks"]
            if "logger" in item:
                logger_from_defaults = item["logger"]
            if "engine" in item:
                engine_from_defaults = item["engine"]
        # handle string items like "_self_"

    # ------------------------------------------------------------------
    # Resolve ${...} interpolations
    # ------------------------------------------------------------------
    cfg = _resolve_interpolations(raw)

    data_cfg: dict[str, Any] = cfg.get("data", {}) or {}
    tasks_cfg: dict[str, Any] = cfg.get("tasks", {}) or {}
    trainer_cfg: dict[str, Any] = cfg.get("trainer", {}) or {}
    logger_cfg: dict[str, Any] = cfg.get("logger", {}) or {}
    engine_cfg: dict[str, Any] = cfg.get("engine", {}) or {}

    # ------------------------------------------------------------------
    # Condition names: top-level `contexts` or tasks.condition_names
    # After _resolve_interpolations, tasks.condition_names may already be
    # the resolved string (e.g. "energy_score, valid, dihedral_deg").
    # ------------------------------------------------------------------
    contexts_raw = raw.get("contexts", [])  # use raw (pre-interpolation) list
    condition_names = tasks_cfg.get("condition_names", contexts_raw)
    condition_names_str = _join_list(condition_names)

    # ------------------------------------------------------------------
    # Logger backend
    # ------------------------------------------------------------------
    logger_backend = logger_cfg.get("logger", "logging")
    if logger_from_defaults == "wandb" and logger_backend == "logging":
        logger_backend = "wandb"

    # ------------------------------------------------------------------
    # Atom vocab
    # ------------------------------------------------------------------
    atom_vocab_raw = data_cfg.get("atom_vocab", [])
    atom_vocab_str = _join_list(atom_vocab_raw) if atom_vocab_raw else ""

    # ------------------------------------------------------------------
    # Normalize factors
    # ------------------------------------------------------------------
    nf_raw = tasks_cfg.get("normalize_factors", [1.0, 4.0, 10.0])
    normalize_factors_str = _join_list(nf_raw)

    normalize_condition_raw = tasks_cfg.get("normalize_condition", "value_10")
    normalize_condition = (
        "none" if normalize_condition_raw is None else _str(normalize_condition_raw)
    )
    normalize_condition_divisor = "10"
    value_match = re.fullmatch(r"value_([0-9]+(?:\.[0-9]+)?)", normalize_condition)
    if value_match:
        normalize_condition = "value"
        normalize_condition_divisor = value_match.group(1)

    # ------------------------------------------------------------------
    # Regression fields
    # ------------------------------------------------------------------
    task_learn_str = _join_list(tasks_cfg.get("task_learn", []))
    metric_str = _join_list(tasks_cfg.get("metric", ["mae"]))

    # ------------------------------------------------------------------
    # Tags
    # ------------------------------------------------------------------
    tags_raw = cfg.get("tags", [])
    tags_str = _join_list(tags_raw)

    # ------------------------------------------------------------------
    # num_epochs / num_steps
    # ------------------------------------------------------------------
    num_epochs = trainer_cfg.get("num_epochs", "")
    num_steps = trainer_cfg.get("num_steps", "")

    # ------------------------------------------------------------------
    # Engine type
    # ------------------------------------------------------------------
    engine_type = engine_cfg.get("engine_type", engine_from_defaults)

    # ------------------------------------------------------------------
    # ASE db path: may be a directory path (not a file) in some configs
    # ------------------------------------------------------------------
    ase_db_path = _str(data_cfg.get("ase_db_path", ""))

    payload: dict[str, Any] = {
        "task_family": task_family,
        "name": _str(cfg.get("name", "")),
        "seed": _str(cfg.get("seed", 42)),
        "tags": tags_str,
        "condition_names": condition_names_str,
        # data
        "dataset_name": _str(data_cfg.get("dataset_name", "")),
        "data_root": _str(data_cfg.get("root", "data/")),
        "csv_path": _str(data_cfg.get("filename", "")),
        "xyz_dir": _str(data_cfg.get("xyz_dir", "")),
        "ase_db_path": ase_db_path,
        "atom_vocab": atom_vocab_str,
        "batch_size": _str(data_cfg.get("batch_size", 48)),
        "max_atom": _str(data_cfg.get("max_atom", 86)),
        "with_hydrogen": bool(data_cfg.get("with_hydrogen", True)),
        "use_ohe_feature": bool(data_cfg.get("use_ohe_feature", True)),
        "allow_unknown": bool(data_cfg.get("allow_unknown", False)),
        "train_ratio": _str(data_cfg.get("train_ratio", 0.8)),
        "data_efficient_collator": bool(data_cfg.get("data_efficient_collator", True)),
        # model common
        "hidden_size": _str(tasks_cfg.get("hidden_size", 256)),
        "num_layers": _str(tasks_cfg.get("num_layers", 9)),
        "num_sublayers": _str(tasks_cfg.get("num_sublayers", 1)),
        "dropout": _str(tasks_cfg.get("dropout", 0.0)),
        "attention": bool(tasks_cfg.get("attention", True)),
        "tanh": bool(tasks_cfg.get("tanh", True)),
        "chkpt_path": _str(tasks_cfg.get("chkpt_path", "")),
        # diffusion / flow-matching
        "diffusion_steps": _str(tasks_cfg.get("diffusion_steps", 500)),
        "diffusion_noise_schedule": _str(
            tasks_cfg.get("diffusion_noise_schedule", "polynomial_2")
        ),
        "diffusion_loss_type": _str(tasks_cfg.get("diffusion_loss_type", "vlb")),
        "context_mask_rate": _str(tasks_cfg.get("context_mask_rate", 0.0)),
        "mask_value": _str(tasks_cfg.get("mask_value", 5)),
        "normalize_condition": normalize_condition,
        "normalize_condition_divisor": normalize_condition_divisor,
        "use_adapter_module": bool(tasks_cfg.get("use_adapter_module", False)),
        "adapter_conditions": _join_list(tasks_cfg.get("adapter_conditions", [])),
        "sp_regularizer_deploy": bool(
            tasks_cfg.get("sp_regularizer_deploy", False)
        ),
        "sp_regularizer_regularizer": _str(
            tasks_cfg.get("sp_regularizer_regularizer", "hard")
        ),
        "sp_regularizer_lambda_": _str(tasks_cfg.get("sp_regularizer_lambda_", 0)),
        "sp_regularizer_lambda_2": _str(
            tasks_cfg.get("sp_regularizer_lambda_2", 1000)
        ),
        "sp_regularizer_lambda_update_value": _str(
            tasks_cfg.get("sp_regularizer_lambda_update_value", 1)
        ),
        "sp_regularizer_lambda_update_step": _str(
            tasks_cfg.get("sp_regularizer_lambda_update_step", 100)
        ),
        "sp_regularizer_polynomial_p": _str(
            tasks_cfg.get("sp_regularizer_polynomial_p", 1.1)
        ),
        "sp_regularizer_warm_up_steps": _str(
            tasks_cfg.get("sp_regularizer_warm_up_steps", 100)
        ),
        "normalize_factors": normalize_factors_str,
        "n_samples": _str(tasks_cfg.get("n_samples", 48)),
        "generative_analysis": bool(tasks_cfg.get("generative_analysis", True)),
        "use_posebuster": bool(tasks_cfg.get("use_posebuster", True)),
        "fm_min_t": _str(tasks_cfg.get("fm_min_t", 0.01)),
        "fm_num_timesteps": _str(tasks_cfg.get("fm_num_timesteps", 100)),
        "fm_self_condition": bool(tasks_cfg.get("fm_self_condition", False)),
        "use_velocity": bool(tasks_cfg.get("use_velocity", False)),
        # regression
        "task_learn": task_learn_str,
        "criterion": _str(tasks_cfg.get("criterion", "mse")),
        "metric": metric_str,
        "num_mlp_layer": _str(tasks_cfg.get("num_mlp_layer", 3)),
        "mlp_batch_norm": _str(tasks_cfg.get("mlp_batch_norm", "batchnorm")),
        "target_normalization": bool(tasks_cfg.get("target_normalization", True)),
        "mlp_dropout": _str(tasks_cfg.get("mlp_dropout", 0.2)),
        "prediction_mlp_type": _str(tasks_cfg.get("prediction_mlp_type", "pernode")),
        # ssl3d
        "ssl3d_denoise_weight": _str(tasks_cfg.get("ssl3d_denoise_weight", 1.0)),
        "ssl3d_mask_rate": _str(tasks_cfg.get("ssl3d_mask_rate", 0.15)),
        "ssl3d_mtype_weight": _str(tasks_cfg.get("ssl3d_mtype_weight", 0.5)),
        "ssl3d_sigma_min": _str(tasks_cfg.get("ssl3d_sigma_min", 0.01)),
        "ssl3d_sigma_max": _str(tasks_cfg.get("ssl3d_sigma_max", 2.0)),
        "ssl3d_sigma_schedule": _str(tasks_cfg.get("ssl3d_sigma_schedule", "uniform")),
        # vae
        "latent_dim": _str(tasks_cfg.get("latent_dim", 8)),
        "augment_noise": _str(tasks_cfg.get("augment_noise", 0.1)),
        "augment_rotation": bool(tasks_cfg.get("augment_rotation", True)),
        # trainer
        "optimizer_choice": _str(trainer_cfg.get("optimizer_choice", "adamw")),
        "lr": _str(trainer_cfg.get("lr", 0.0002)),
        "weight_decay": _str(trainer_cfg.get("weight_decay", 1e-12)),
        "num_epochs": _str(num_epochs),
        "num_steps": _str(num_steps),
        "scheduler": _str(trainer_cfg.get("scheduler", "cosineannealing")),
        "validation_interval": _str(trainer_cfg.get("validation_interval", 3)),
        "ema_decay": _str(trainer_cfg.get("ema_decay", 0.9999)),
        "precision": _str(trainer_cfg.get("precision", 32)),
        "save_top_k": _str(trainer_cfg.get("save_top_k", 3)),
        "save_every_val_epoch": bool(trainer_cfg.get("save_every_val_epoch", False)),
        "gradient_clip_mode": _str(trainer_cfg.get("gradient_clip_mode", "norm")),
        "init_grad_norm": _str(trainer_cfg.get("init_grad_norm", 3000)),
        "resume_from_checkpoint": _str(trainer_cfg.get("resume_from_checkpoint", "")),
        "load_weights_from": _str(trainer_cfg.get("load_weights_from", "")),
        "monitor_metric": _str(trainer_cfg.get("monitor_metric", "")),
        "monitor_mode": _str(trainer_cfg.get("monitor_mode", "max")),
        # logger
        "logger_backend": logger_backend,
        "log_interval": _str(logger_cfg.get("log_interval", 2)),
        "wandb_name": _str(logger_cfg.get("name_wandb", "MolecularDiffusion")),
        "wandb_project": _str(logger_cfg.get("project_wandb", "MolecularDiffusion")),
        "wandb_tags": _join_list(logger_cfg.get("tags", [])),
        # engine
        "engine_type": engine_type,
        "num_workers": _str(engine_cfg.get("num_workers", 2)),
    }

    return payload
