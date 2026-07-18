# Configuration Presets

The **3D molecule generation**, **Structure-directed generation**, and **Model training** tabs include a **Presets** bar that lets you save and restore named parameter configurations. Presets are stored as JSON files on disk and survive server restarts.


## Saving a preset

1. Configure all parameters as desired.
2. In the Presets bar, type a name in the text field.
3. Click **Save**.

The current values of all parameters — including property targets, scaffold XYZ, and atom selection — are written to disk.

## Loading a preset

Click a preset name in the Presets bar. All parameters are restored to the saved values. Any unsaved current values are overwritten without confirmation.

## Notes

- Presets are per-page: each tab keeps its own preset list; presets saved on one tab do not appear on the others.
- Scaffold XYZ content is embedded in the preset; the original file path is not stored.
