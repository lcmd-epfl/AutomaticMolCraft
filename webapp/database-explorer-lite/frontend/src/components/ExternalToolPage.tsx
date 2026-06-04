import React, { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store/store";
import type { Dataset } from "../models/dataModel";
import { getXYZ } from "../utils/xyzLoader";
import { buildXyzById } from "../utils/xyzLoader";
import { shallow } from "zustand/shallow";
import { BACKEND } from "../config";

const SERIALIZED_DATASET_CACHE: WeakMap<Dataset, any> = new WeakMap();
const EXTERNAL_TOOL_RUN_STORAGE_PREFIX = "molcraft.externalToolRun.";

type PersistedExternalToolRun = {
  toolId: string;
  toolName: string;
  startedAt: string;
  status: "running" | "cancelled" | "completed" | "failed";
  message?: string;
};

function storageKeyForTool(toolId: string) {
  return `${EXTERNAL_TOOL_RUN_STORAGE_PREFIX}${toolId}`;
}

function readPersistedRun(toolId: string): PersistedExternalToolRun | null {
  try {
    const raw = window.localStorage.getItem(storageKeyForTool(toolId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.toolId !== toolId) return null;
    return parsed as PersistedExternalToolRun;
  } catch {
    return null;
  }
}

function writePersistedRun(run: PersistedExternalToolRun) {
  try {
    window.localStorage.setItem(
      storageKeyForTool(run.toolId),
      JSON.stringify(run),
    );
  } catch {
    // Ignore storage failures.
  }
}

function clearPersistedRun(toolId: string) {
  try {
    window.localStorage.removeItem(storageKeyForTool(toolId));
  } catch {
    // Ignore storage failures.
  }
}

export type ToolInput = {
  key: string;
  label?: string;
  type:
    | "string"
    | "text"
    | "integer"
    | "float"
    | "boolean"
    | "select"
    | "multiselect"
    | "slider_int"
    | "slider_float"
    | "column"
    | "column_multi"
    | "column_numeric"
    | "column_categorical"
    | "column_multi_numeric"
    | "column_multi_categorical";
  default?: any;
  required?: boolean;
  options?: Array<string | { value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  help?: string;
};

export type ToolSpec = {
  id: string;
  name: string;
  description?: string;
  inputs: ToolInput[];
  output?: any;
  hasRequirements?: boolean;
  manifestVersion?: number;
  needsXyz?: boolean;
};

type ToolRunResponse = {
  message?: string;
  warnings?: string[];
  addColumns?: {
    name: string;
    kind?: string;
    values: Array<number | string | null>;
  }[];
  addDescriptor?: {
    name: string;
    valuesById: Record<string, number[]>;
    dtype?: "float32";
    source?: { kind: "tool" | "file"; label?: string };
  };
  stats?: Record<string, any>;
};

export default function ExternalToolPage({ tool }: { tool: ToolSpec }) {
  //const source = useStore(s => s.source)
  //const ds = useStore(s => s.dataset)
  const source = useStore((s) => s.source);
  const datasetIdsLength = useStore((s) => s.dataset?.ids.length ?? 0);
  const allColumns = useStore(
    (s) =>
      s.dataset?.columnOrder && s.dataset.columnOrder.length
        ? s.dataset.columnOrder
        : s.dataset
          ? Object.keys(s.dataset.columns)
          : [],
    shallow,
  );
  const numericColumns = useStore(
    (s) => s.dataset?.meta.numericColumns ?? [],
    shallow,
  );
  const categoricalColumns = useStore(
    (s) => s.dataset?.meta.categoricalColumns ?? [],
    shallow,
  );
  const ds = useStore((s) => s.dataset);
  const addColumns = useStore((s) => s.addColumns);
  const addDescriptor = useStore((s) => s.addDescriptor);

  const [formValues, setFormValues] = useState<Record<string, any>>({});
  const [runBusy, setRunBusy] = useState(false);
  const [runMessage, setRunMessage] = useState("");
  const [runError, setRunError] = useState("");
  const [runWarnings, setRunWarnings] = useState<string[]>([]);
  const [runStats, setRunStats] = useState<Record<string, any> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [persistedRun, setPersistedRun] =
    useState<PersistedExternalToolRun | null>(() => readPersistedRun(tool.id));

  const serializedDataset = useMemo(() => {
    if (!ds) return null;
    return serializeDataset(ds);
  }, [ds]);

  useEffect(() => {
    const next: Record<string, any> = {};
    for (const field of tool.inputs || []) {
      if (field.default !== undefined) next[field.key] = field.default;
      else if (field.type === "boolean") next[field.key] = false;
      else if (field.type === "multiselect" || field.type === "column_multi")
        next[field.key] = [];
      else next[field.key] = "";
    }
    setFormValues(next);
    setRunMessage("");
    setRunError("");
    setRunWarnings([]);
    setRunStats(null);

    const restored = readPersistedRun(tool.id);
    setPersistedRun(restored);
    setRunBusy(restored?.status === "running");
  }, [tool.id]);

  const setFieldValue = React.useCallback((key: string, value: any) => {
    setFormValues((prev) => {
      if (Object.is(prev[key], value)) return prev;
      return { ...prev, [key]: value };
    });
  }, []);

  const runTool = async () => {
    if (!ds) return;

    // VALIDATION
    for (const field of tool.inputs || []) {
      const value = formValues[field.key];

      if (field.required) {
        if (
          value === undefined ||
          value === null ||
          value === "" ||
          (Array.isArray(value) && value.length === 0)
        ) {
          setRunMessage(`Missing required field: ${field.label || field.key}`);
          return;
        }
      }

      if (
        field.type === "integer" &&
        value !== "" &&
        !Number.isInteger(Number(value))
      ) {
        setRunMessage(`Field ${field.label || field.key} must be an integer`);
        return;
      }

      if (field.type === "float" && value !== "" && isNaN(Number(value))) {
        setRunMessage(`Field ${field.label || field.key} must be a number`);
        return;
      }
    }

    setRunBusy(true);
    const persisted: PersistedExternalToolRun = {
      toolId: tool.id,
      toolName: tool.name,
      startedAt: new Date().toISOString(),
      status: "running",
      message: "The backend request is running.",
    };
    setPersistedRun(persisted);
    writePersistedRun(persisted);
    setRunMessage("");
    setRunError("");
    setRunWarnings([]);
    setRunStats(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      //const xyzById = await buildXyzById(ds, source)
      const xyzById = tool.needsXyz ? await buildXyzById(ds, source) : {};
      console.log(
        "basic_geom xyz loaded:",
        Object.keys(xyzById).length,
        "of",
        ds.ids.length,
      );

      //const payload = {
      //  dataset: serializeDataset(ds),
      //  xyzById,
      //  params: formValues,
      //}
      //const payload = {
      //  dataset: {
      //    ...serializeDataset(ds),
      //    xyzById,
      //  },
      //  params: formValues,
      //}
      const payload = {
        dataset: {
          ...(serializedDataset || serializeDataset(ds)),
          xyzById,
        },
        params: formValues,
      };

      const resp = await fetch(`${BACKEND}/tools/${tool.id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data?.detail || `HTTP ${resp.status}`);

      const result = data as ToolRunResponse;

      if (result.addColumns?.length) {
        addColumns(result.addColumns);
      }

      const warnings = [...(result.warnings || [])];

      if (result.addDescriptor) {
        const out = addDescriptor({
          name: result.addDescriptor.name,
          valuesById: result.addDescriptor.valuesById,
          dtype: result.addDescriptor.dtype || "float32",
          source: result.addDescriptor.source || {
            kind: "tool",
            label: tool.name,
          },
        });
        if (out.warning) warnings.push(out.warning);
      }

      clearPersistedRun(tool.id);
      setPersistedRun(null);
      setRunMessage(result.message || `Tool ${tool.name} finished.`);
      setRunError("");
      setRunWarnings(warnings);
      setRunStats(result.stats || null);
    } catch (err: any) {
      const wasCancelled = err?.name === "AbortError";
      if (wasCancelled) {
        clearPersistedRun(tool.id);
        setPersistedRun(null);
      } else {
        const failed: PersistedExternalToolRun = {
          toolId: tool.id,
          toolName: tool.name,
          startedAt: persisted.startedAt,
          status: "failed",
          message: err?.message || String(err),
        };
        writePersistedRun(failed);
        setPersistedRun(failed);
      }
      setRunMessage("");
      setRunError(
        wasCancelled ? "Tool run cancelled." : err?.message || String(err),
      );
      setRunWarnings([]);
      setRunStats(null);
    } finally {
      abortControllerRef.current = null;
      setRunBusy(false);
    }
  };

  const cancelRun = () => {
    abortControllerRef.current?.abort();
    clearPersistedRun(tool.id);
    setPersistedRun(null);
    setRunBusy(false);
    setRunError("Tool run cancelled.");
  };

  const clearStoredRun = () => {
    clearPersistedRun(tool.id);
    setPersistedRun(null);
    setRunBusy(false);
  };

  return (
    <div style={{ display: "grid", gap: 12, padding: "0 10px 12px 10px" }}>
      <div className="card p-md">
        <div style={{ fontWeight: 800, marginBottom: 6 }}>{tool.name}</div>
        <div className="legend">{tool.description}</div>
        <div> &nbsp; </div>
        <div style={{ display: "grid", gap: 10 }}>
          {tool.inputs.map((field) => (
            <FieldRow
              key={field.key}
              field={field}
              value={formValues[field.key]}
              allColumns={allColumns}
              numericColumns={numericColumns}
              categoricalColumns={categoricalColumns}
              setFieldValue={setFieldValue}
            />
          ))}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 12,
          }}
        >
          {runBusy ? <button onClick={cancelRun}>Cancel</button> : null}
          <button onClick={runTool} disabled={!ds || runBusy}>
            {runBusy ? "Running…" : "Run tool"}
          </button>
        </div>

        {runBusy ? (
          <div
            style={{
              marginTop: 10,
              border: "1px solid #2a4a6a",
              borderRadius: 8,
              padding: 8,
              background: "#101923",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Running tool</div>
            <div className="legend">
              {abortControllerRef.current
                ? `Please wait while the backend executes ${tool.name}.`
                : `${tool.name} was started earlier. Plug-in tools do not have backend job polling yet, so this status is restored from local browser state.`}
            </div>
            {persistedRun?.startedAt ? (
              <div className="legend" style={{ marginTop: 4 }}>
                Started: {new Date(persistedRun.startedAt).toLocaleString()}
              </div>
            ) : null}
            {!abortControllerRef.current ? (
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  marginTop: 8,
                }}
              >
                <button onClick={clearStoredRun}>Clear restored status</button>
              </div>
            ) : null}
          </div>
        ) : null}

        {runMessage ? (
          <div
            style={{
              marginTop: 10,
              border: "1px solid #244b2c",
              borderRadius: 8,
              padding: 8,
              background: "#101b12",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4 }}>Result</div>
            <div className="legend">{runMessage}</div>
          </div>
        ) : null}

        {runError ? (
          <div
            style={{
              marginTop: 10,
              border: "1px solid #7a1d1d",
              borderRadius: 8,
              padding: 8,
              background: "#1d1111",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 4, color: "#ffb4b4" }}>
              Error
            </div>
            <div className="legend">{runError}</div>
          </div>
        ) : null}

        {runWarnings.length > 0 ? (
          <div
            style={{
              marginTop: 10,
              border: "1px solid #7a5a1d",
              borderRadius: 8,
              padding: 8,
              background: "#1a1610",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Warnings</div>
            <div style={{ display: "grid", gap: 4 }}>
              {runWarnings.map((w, i) => (
                <div key={`${i}-${w}`} className="legend">
                  {w}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {runStats && Object.keys(runStats).length > 0 ? (
          <div
            style={{
              marginTop: 10,
              border: "1px solid #223246",
              borderRadius: 8,
              padding: 8,
              background: "#0f141b",
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Run statistics
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {Object.entries(runStats).map(([k, v]) => (
                <div
                  key={k}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "180px 1fr",
                    gap: 8,
                    alignItems: "start",
                  }}
                >
                  <div className="legend field-title">
                    {k}
                  </div>
                  <div className="legend">{String(v)}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function serializeDataset(ds: Dataset) {
  const hit = SERIALIZED_DATASET_CACHE.get(ds);
  if (hit) return hit;

  const plainColumns: Record<string, any[]> = {};
  for (const [name, values] of Object.entries(ds.columns)) {
    plainColumns[name] = Array.from(values as any);
  }

  const out = {
    ids: ds.ids,
    columns: plainColumns,
    meta: ds.meta,
    descriptors: ds.descriptors || {},
  };

  SERIALIZED_DATASET_CACHE.set(ds, out);
  return out;
}

function normalizeOptions(
  options?: Array<string | { value: string; label: string }>,
) {
  return (options || []).map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt,
  );
}

const FieldRow = React.memo(function FieldRow({
  field,
  value,
  allColumns,
  numericColumns,
  categoricalColumns,
  setFieldValue,
}: {
  field: ToolInput;
  value: any;
  allColumns: string[];
  numericColumns: string[];
  categoricalColumns: string[];
  setFieldValue: (key: string, value: any) => void;
}) {
  const onChange = React.useCallback(
    (nextValue: any) => setFieldValue(field.key, nextValue),
    [setFieldValue, field.key],
  );

  return (
    <ToolField
      field={field}
      value={value}
      columns={allColumns}
      numericColumns={numericColumns}
      categoricalColumns={categoricalColumns}
      onChange={onChange}
    />
  );
});

//function ToolField({
const ToolField = React.memo(function ToolField({
  field,
  value,
  columns,
  numericColumns,
  categoricalColumns,
  onChange,
}: {
  field: ToolInput;
  value: any;
  columns: string[];
  numericColumns: string[];
  categoricalColumns: string[];
  onChange: (value: any) => void;
}) {
  const label = field.label || field.key;
  const commonStyle: React.CSSProperties = { width: "100%" };

  if (field.type === "text") {
    return (
      <label style={{ display: "grid", gap: 4 }}>
        <span>{label}</span>
        <textarea
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          style={commonStyle}
        />
      </label>
    );
  }

  if (field.type === "boolean") {
    return (
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{label}</span>
      </label>
    );
  }

  if (
    field.type === "select" ||
    field.type === "column" ||
    field.type === "column_numeric" ||
    field.type === "column_categorical"
  ) {
    let options;

    if (field.type === "column") {
      options = columns.map((c) => ({ value: c, label: c }));
    } else if (field.type === "column_numeric") {
      options = numericColumns.map((c) => ({ value: c, label: c }));
    } else if (field.type === "column_categorical") {
      options = categoricalColumns.map((c) => ({ value: c, label: c }));
    } else {
      options = normalizeOptions(field.options);
    }

    return (
      <label style={{ display: "grid", gap: 4 }}>
        <span>{label}</span>
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          style={commonStyle}
        >
          <option value="">Select…</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (
    field.type === "multiselect" ||
    field.type === "column_multi" ||
    field.type === "column_multi_numeric" ||
    field.type === "column_multi_categorical"
  ) {
    let options;

    if (field.type === "column_multi") {
      options = columns.map((c) => ({ value: c, label: c }));
    } else if (field.type === "column_multi_numeric") {
      options = numericColumns.map((c) => ({ value: c, label: c }));
    } else if (field.type === "column_multi_categorical") {
      options = categoricalColumns.map((c) => ({ value: c, label: c }));
    } else {
      options = normalizeOptions(field.options);
    }

    const selected = new Set(Array.isArray(value) ? value.map(String) : []);

    return (
      <div style={{ display: "grid", gap: 4 }}>
        <span>{label}</span>
        <div
          style={{
            border: "1px solid #223246",
            borderRadius: 8,
            padding: 8,
            maxHeight: 140,
            overflow: "auto",
            display: "grid",
            gap: 4,
          }}
        >
          {options.map((opt) => (
            <label
              key={opt.value}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <input
                type="checkbox"
                checked={selected.has(opt.value)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(opt.value);
                  else next.delete(opt.value);
                  onChange(Array.from(next));
                }}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === "slider_int" || field.type === "slider_float") {
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const step = field.step ?? (field.type === "slider_int" ? 1 : 0.1);
    const numericValue =
      value === "" || value == null ? (field.default ?? min) : Number(value);
    return (
      <label style={{ display: "grid", gap: 4 }}>
        <span>
          {label}: <b>{numericValue}</b>
        </span>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={numericValue}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </label>
    );
  }

  const inputType =
    field.type === "integer"
      ? "number"
      : field.type === "float"
        ? "number"
        : "text";
  const step =
    field.type === "integer" ? 1 : field.type === "float" ? "any" : undefined;
  return (
    <label style={{ display: "grid", gap: 4 }}>
      <span>{label}</span>
      <input
        type={inputType}
        step={step}
        value={String(value ?? "")}
        onChange={(e) => {
          if (field.type === "integer")
            onChange(
              e.target.value === "" ? "" : Number.parseInt(e.target.value, 10),
            );
          else if (field.type === "float")
            onChange(
              e.target.value === "" ? "" : Number.parseFloat(e.target.value),
            );
          else onChange(e.target.value);
        }}
        style={commonStyle}
      />
      {field.help ? <span className="legend">{field.help}</span> : null}
    </label>
  );
});
