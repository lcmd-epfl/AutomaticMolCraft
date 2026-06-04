# Workflows

This page describes common end-to-end usage patterns. Each workflow links to the relevant tab documentation for parameter details.

---

## 1. Generate → Analyze → Visualize

The most common workflow: produce a batch of molecules, enrich them with properties, then explore the chemical space.

1. **[3D Generation](../generation/index.md)** — run a de-novo job and inspect the generated XYZ files in the Results panel.
2. **[Data Manager](../data-manager.md)** — use **Add generated molecules**, click **Register generated molecules**, then **Compile dataset**.
3. **[Analysis tools](../analysis-tools.md)** — run **XYZ to SMILES** (required first), then **XTB electronic properties** or **Predict properties**.
4. Apply results to the dataset.
5. **[Analysis tools](../analysis-tools.md)** — run **Featurize** (SOAP), then **Dimensionality reduction** (UMAP) to produce 2D layout columns.
6. **[Visualization](../visualization.md)** — create a 2D scatter plot with UMAP coordinates on the axes, color by energy or HOMO–LUMO gap.

---

## 2. Property-targeted generation

Generate molecules steered toward a specific property value using CFG.

1. Choose a **CFG** model in [3D Generation](../generation/index.md) (labelled "CFG" in the model list).
2. Set **CFG scale** > 1 (start with 2–3) and enter the target value for each property.
3. Optionally set a **Negative target** to steer *away from* an undesired value.
4. Run multiple jobs with different seeds to build a diverse set.
5. Proceed with steps 2–6 from workflow 1 to compare the generated set against an unconditional baseline.

---

## 3. Scaffold extension (outpaint)

Extend a known fragment into a complete molecule.

1. In **[Structure-directed generation](../generation/structure-guided.md)**, load a reference `.xyz` scaffold.
2. Set mode to **Outpaint**.
3. Click the atoms that form the attachment point(s) — these are held fixed.
4. Set **Connector bonds** for each selected atom.
5. Set **Fixed atom count** to scaffold atoms + desired extension size.
6. Generate, then use **Use as ref** (→) to feed a promising result back as a new scaffold for further extension.

---

## 4. Dataset curation and export

Curate a mixed-source dataset for downstream modelling.

1. **[Data Manager](../data-manager.md)** — stage each source (CSV + XYZ folder, ASE .db, or generated output folder).
2. Per-source: rename or drop columns to harmonise the schema.
3. Compile with **duplicate-ID = rename** and **column-conflict = merge**.
4. **[Analysis tools](../analysis-tools.md)** — run **Validity and connectivity metrics** to flag problematic geometries.
5. **[Visualization](../visualization.md)** — use a **Boolean filter** on validity columns to exclude invalid molecules.
6. **Data Manager** → **Download dataset** → select **Filtered view** and click **Download ASE .db** for downstream use.

---

!!! note "Detailed workflow recipes"
    Step-by-step worked examples with specific parameter recommendations will be added in a follow-up update.
