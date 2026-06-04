from __future__ import annotations

import importlib.util
import json
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

TOOLS_DIR = (Path(__file__).parent / "tools").resolve()


class ToolError(Exception):
    pass


@dataclass
class ToolSpec:
    id: str
    name: str
    description: str
    manifest_path: Path
    tool_dir: Path
    runner_path: Path
    requirements_path: Path | None
    inputs: List[Dict[str, Any]]
    raw: Dict[str, Any]

    def to_public_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "inputs": self.inputs,
            "hasRequirements": self.requirements_path is not None,
            "manifestVersion": self.raw.get("manifestVersion", 1),
            "output": self.raw.get("output", {"kind": "add_columns"}),
            "needsXyz": bool(self.raw.get("needsXyz", False)),
        }


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ToolError(f"Failed to read {path.name}: {exc}") from exc


SUPPORTED_INPUT_TYPES = {
    "string",
    "text",
    "integer",
    "float",
    "boolean",
    "select",
    "multiselect",
    "slider_int",
    "slider_float",
    "column",
    "column_multi",
    "column_numeric",
    "column_categorical",
    "column_multi_numeric",
    "column_multi_categorical",
}


def _validate_manifest(path: Path, data: Dict[str, Any]) -> ToolSpec:
    tool_id = data.get("id")
    name = data.get("name")
    desc = data.get("description", "")
    inputs = data.get("inputs", [])

    if not tool_id or not isinstance(tool_id, str):
        raise ToolError('manifest.json must define string field "id"')
    if not name or not isinstance(name, str):
        raise ToolError('manifest.json must define string field "name"')
    if not isinstance(inputs, list):
        raise ToolError('manifest.json field "inputs" must be a list')

    for idx, item in enumerate(inputs):
        if not isinstance(item, dict):
            raise ToolError(f"inputs[{idx}] must be an object")
        key = item.get("key")
        typ = item.get("type")
        if not key or not isinstance(key, str):
            raise ToolError(f'inputs[{idx}] must define string field "key"')
        if typ not in SUPPORTED_INPUT_TYPES:
            raise ToolError(f"inputs[{idx}] has unsupported type {typ!r}")

    tool_dir = path.parent
    runner_path = tool_dir / "runner.py"
    if not runner_path.exists():
        raise ToolError(f"{tool_id}: runner.py not found")

    req_path = tool_dir / "requirements.txt"
    return ToolSpec(
        id=tool_id,
        name=name,
        description=desc,
        manifest_path=path,
        tool_dir=tool_dir,
        runner_path=runner_path,
        requirements_path=req_path if req_path.exists() else None,
        inputs=inputs,
        raw=data,
    )


def discover_tools() -> tuple[list[ToolSpec], list[Dict[str, str]]]:
    tools: list[ToolSpec] = []
    errors: list[Dict[str, str]] = []

    if not TOOLS_DIR.exists():
        return tools, errors

    for manifest_path in sorted(TOOLS_DIR.glob("*/manifest.json")):
        try:
            spec = _validate_manifest(manifest_path, _read_json(manifest_path))
            tools.append(spec)
        except Exception as exc:
            errors.append(
                {
                    "path": str(manifest_path.relative_to(TOOLS_DIR.parent)),
                    "error": str(exc),
                }
            )

    return tools, errors


def _coerce_param(field: Dict[str, Any], value: Any) -> Any:
    typ = field["type"]
    key = field["key"]

    if value is None:
        if "default" in field:
            return field["default"]
        if field.get("required", False):
            raise ToolError(f"Missing required parameter: {key}")
        return None

    try:
        if typ in {
            "string",
            "text",
            "select",
            "column",
            "column_numeric",
            "column_categorical",
        }:
            return str(value)

        if typ == "integer":
            return int(value)

        if typ == "float":
            return float(value)

        if typ == "boolean":
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                return value.strip().lower() in {"1", "true", "yes", "on"}
            return bool(value)

        if typ in {
            "multiselect",
            "column_multi",
            "column_multi_numeric",
            "column_multi_categorical",
        }:
            if not isinstance(value, list):
                raise ToolError(f"Parameter {key} must be a list")
            return [str(v) for v in value]

        if typ == "slider_int":
            return int(value)

        if typ == "slider_float":
            return float(value)

    except ValueError as exc:
        raise ToolError(f"Invalid value for {key}: {value!r}") from exc

    return value


def _plain_columns(dataset: Dict[str, Any]) -> Dict[str, list[Any]]:
    cols = dataset.get("columns", {}) or {}
    out: Dict[str, list[Any]] = {}
    for name, values in cols.items():
        if isinstance(values, list):
            out[name] = values
        else:
            out[name] = list(values)
    return out


def validate_params(spec: ToolSpec, params: Dict[str, Any], dataset: Dict[str, Any]) -> None:
    dataset_columns = dataset.get("columns", {}) or {}
    meta = dataset.get("meta", {}) or {}
    numeric_columns = set(meta.get("numericColumns", []) or [])
    categorical_columns = set(meta.get("categoricalColumns", []) or [])

    for field in spec.inputs:
        key = field["key"]
        label = field.get("label") or key
        field_type = field["type"]
        value = params.get(key)

        if field.get("required", False):
            if value is None or value == "" or (isinstance(value, list) and not value):
                raise ToolError(f"Missing required field: {label}")

        if value is None:
            continue

        if field_type == "integer":
            if not isinstance(value, int):
                raise ToolError(f"Field '{label}' must be an integer")

        elif field_type == "float":
            if not isinstance(value, (int, float)):
                raise ToolError(f"Field '{label}' must be a number")

        elif field_type in {"column", "column_numeric", "column_categorical"}:
            if not isinstance(value, str):
                raise ToolError(f"Field '{label}' must be a column name")
            if value not in dataset_columns:
                raise ToolError(f"Column '{value}' does not exist")

            if field_type == "column_numeric" and value not in numeric_columns:
                raise ToolError(f"Column '{value}' is not a numeric column")

            if field_type == "column_categorical" and value not in categorical_columns:
                raise ToolError(f"Column '{value}' is not a categorical column")

        elif field_type in {"column_multi", "column_multi_numeric", "column_multi_categorical"}:
            if not isinstance(value, list):
                raise ToolError(f"Field '{label}' must be a list of column names")

            for v in value:
                if v not in dataset_columns:
                    raise ToolError(f"Column '{v}' does not exist")

                if field_type == "column_multi_numeric" and v not in numeric_columns:
                    raise ToolError(f"Column '{v}' is not a numeric column")

                if field_type == "column_multi_categorical" and v not in categorical_columns:
                    raise ToolError(f"Column '{v}' is not a categorical column")


def validate_tool_result(result: Any, dataset: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(result, dict):
        raise ValueError("Tool result must be a dictionary.")

    dataset_ids = dataset.get("ids", [])
    dataset_columns = dataset.get("columns", {})
    dataset_len = len(dataset_ids)

    normalized: Dict[str, Any] = {}

    allowed_keys = {"message", "warnings", "addColumns", "addDescriptor", "stats"}
    unknown_keys = set(result.keys()) - allowed_keys
    if unknown_keys:
        raise ValueError(f"Tool result contains unsupported keys: {sorted(unknown_keys)}")

    if "message" in result:
        if not isinstance(result["message"], str):
            raise ValueError("Tool result field 'message' must be a string.")
        normalized["message"] = result["message"]

    if "warnings" in result:
        warnings = result["warnings"]
        if not isinstance(warnings, list) or not all(isinstance(w, str) for w in warnings):
            raise ValueError("Tool result field 'warnings' must be a list of strings.")
        normalized["warnings"] = warnings
    else:
        normalized["warnings"] = []

    if "stats" in result:
        stats = result["stats"]
        if not isinstance(stats, dict):
            raise ValueError("Tool result field 'stats' must be a dictionary.")
        for key, value in stats.items():
            if not isinstance(key, str):
                raise ValueError("All keys in 'stats' must be strings.")
            if not isinstance(value, (str, int, float, bool, type(None))):
                raise ValueError(
                    f"Stats field '{key}' must be a JSON-serializable scalar "
                    "(string, int, float, bool, or null)."
                )
        normalized["stats"] = stats
    else:
        normalized["stats"] = {}

    if "addColumns" in result:
        add_columns = result["addColumns"]
        if not isinstance(add_columns, list):
            raise ValueError("Tool result field 'addColumns' must be a list.")

        seen_names = set()
        normalized_columns: List[Dict[str, Any]] = []

        for i, col in enumerate(add_columns):
            if not isinstance(col, dict):
                raise ValueError(f"addColumns[{i}] must be a dictionary.")

            required_keys = {"name", "kind", "values"}
            missing = required_keys - set(col.keys())
            if missing:
                raise ValueError(f"addColumns[{i}] is missing required keys: {sorted(missing)}")

            name = col["name"]
            kind = col["kind"]
            values = col["values"]

            if not isinstance(name, str) or not name.strip():
                raise ValueError(f"addColumns[{i}].name must be a non-empty string.")

            if name in dataset_columns:
                raise ValueError(f"Tool tried to create column '{name}', but it already exists.")

            if name in seen_names:
                raise ValueError(f"Tool tried to create duplicate output column '{name}' in the same run.")
            seen_names.add(name)

            if kind not in {"numeric", "categorical"}:
                raise ValueError(
                    f"addColumns[{i}].kind must be 'numeric' or 'categorical', got {kind!r}."
                )

            if not isinstance(values, list):
                raise ValueError(f"addColumns[{i}].values must be a list.")

            if len(values) != dataset_len:
                raise ValueError(
                    f"addColumns[{i}].values has length {len(values)}, "
                    f"but dataset has {dataset_len} rows."
                )

            if kind == "numeric":
                for j, v in enumerate(values):
                    if v is not None and not isinstance(v, (int, float)):
                        raise ValueError(
                            f"addColumns[{i}].values[{j}] must be int, float, or null for numeric columns."
                        )
            elif kind == "categorical":
                for j, v in enumerate(values):
                    if v is not None and not isinstance(v, str):
                        raise ValueError(
                            f"addColumns[{i}].values[{j}] must be string or null for categorical columns."
                        )

            normalized_columns.append(
                {
                    "name": name,
                    "kind": kind,
                    "values": values,
                }
            )

        normalized["addColumns"] = normalized_columns
    else:
        normalized["addColumns"] = []


    if "addDescriptor" in result:
        desc = result["addDescriptor"]
        if not isinstance(desc, dict):
            raise ValueError("Tool result field 'addDescriptor' must be a dictionary.")

        required_keys = {"name", "valuesById"}
        missing = required_keys - set(desc.keys())
        if missing:
            raise ValueError(f"addDescriptor is missing required keys: {sorted(missing)}")

        name = desc["name"]
        values_by_id = desc["valuesById"]
        dtype = desc.get("dtype", "float32")
        source = desc.get("source")

        if not isinstance(name, str) or not name.strip():
            raise ValueError("addDescriptor.name must be a non-empty string.")

        if name in dataset_columns:
            raise ValueError(f"Tool tried to create descriptor '{name}', but a column with that name already exists.")

        if not isinstance(values_by_id, dict):
            raise ValueError("addDescriptor.valuesById must be a dictionary keyed by dataset id.")

        dataset_id_set = set(dataset_ids)
        dim = None

        for entry_id, vec in values_by_id.items():
            if not isinstance(entry_id, str):
                raise ValueError("All addDescriptor.valuesById keys must be strings.")
            if entry_id not in dataset_id_set:
                raise ValueError(f"addDescriptor references unknown dataset id '{entry_id}'.")
            if not isinstance(vec, list) or len(vec) == 0:
                raise ValueError(f"Descriptor vector for id '{entry_id}' must be a non-empty list.")
            for j, v in enumerate(vec):
                if not isinstance(v, (int, float)):
                    raise ValueError(
                        f"Descriptor vector for id '{entry_id}' contains non-numeric value at position {j}."
                    )
            if dim is None:
                dim = len(vec)
            elif len(vec) != dim:
                raise ValueError("All descriptor vectors in addDescriptor must have the same dimension.")

        if dim is None:
            raise ValueError("addDescriptor must contain at least one descriptor vector.")

        if dtype != "float32":
            raise ValueError("addDescriptor.dtype currently must be 'float32'.")

        if source is not None:
            if not isinstance(source, dict):
                raise ValueError("addDescriptor.source must be a dictionary if provided.")
            if "kind" in source and source["kind"] not in {"tool", "file"}:
                raise ValueError("addDescriptor.source.kind must be 'tool' or 'file'.")

        normalized["addDescriptor"] = {
            "name": name,
            "valuesById": values_by_id,
            "dtype": dtype,
            "source": source,
            "dim": dim,
        }

    if (
        "message" not in normalized
        and not normalized["warnings"]
        and not normalized["addColumns"]
        and "addDescriptor" not in normalized
        and not normalized["stats"]
    ):
        raise ValueError(
            "Tool returned an empty result. It must return at least one of: "
            "message, warnings, addColumns, or stats."
        )

    return normalized


def run_tool(spec: ToolSpec, dataset: Dict[str, Any], params: Dict[str, Any]) -> Dict[str, Any]:
    safe_params: Dict[str, Any] = {}
    for field in spec.inputs:
        safe_params[field["key"]] = _coerce_param(field, params.get(field["key"]))

    ids = [str(v) for v in dataset.get("ids", [])]
    columns = _plain_columns(dataset)
    meta = dataset.get("meta", {}) or {}

    module_name = f"external_tool_{spec.id}"
    loaded = importlib.util.spec_from_file_location(module_name, spec.runner_path)
    if loaded is None or loaded.loader is None:
        raise ToolError(f"Could not load runner for tool {spec.id}")

    module = importlib.util.module_from_spec(loaded)
    loaded.loader.exec_module(module)

    if not hasattr(module, "run_tool"):
        raise ToolError(f"{spec.id}: runner.py must define run_tool(dataset, params)")

    payload = {
        "ids": ids,
        "columns": columns,
        "meta": meta,
        "xyzById": dataset.get("xyzById", {}) or {},
        "descriptors": dataset.get("descriptors", {}) or {},
    }

    validate_params(spec, safe_params, payload)

    try:
        result = module.run_tool(payload, safe_params)
        result = validate_tool_result(result, payload)
        return result
    except ModuleNotFoundError as exc:
        pkg = getattr(exc, "name", None) or str(exc)
        req_hint = ""
        if spec.requirements_path is not None:
            req_hint = (
                f" Install tool dependencies from {spec.requirements_path.name} "
                "into the backend Python environment."
            )
        raise ToolError(f"Missing Python dependency {pkg!r} for tool {spec.id}.{req_hint}") from exc
    except ToolError:
        raise
    except Exception as exc:
        tb = traceback.format_exc()
        raise ToolError(f"Tool {spec.id} failed: {exc}\n{tb}") from exc
