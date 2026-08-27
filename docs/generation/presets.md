# Configuration Presets

The **3D molecule generation**, **Structure-directed generation**, and **Model training** tabs include a **Presets** bar that lets you save and restore named parameter configurations. Presets are stored as JSON files on disk and survive server restarts.


## Saving a preset

1. Configure all parameters as desired.
2. In the Presets bar, type a name in the text field.
3. Click **Save current**.

The current values of all parameters — including property targets, scaffold XYZ, and atom selection — are written to disk.

If the name already matches an existing preset, saving does not silently overwrite it: a warning row appears (`"<name>" already exists.`) with **Overwrite** and **Cancel** buttons. Click **Overwrite** to replace the existing preset with the current values, or **Cancel** to back out and pick a different name.

## Loading a preset

Pick a preset from the dropdown, then click **Load**. All parameters are restored to the saved values. Any unsaved current values are overwritten without further confirmation.

## Downloading and deleting

With a preset selected in the dropdown:

- **Download** exports the preset (name, page, creation time, and full config) as a `.json` file.
- **Delete** removes it immediately. A toast with an **Undo** action appears briefly afterward — click it to restore the preset (it is recreated with a new internal ID, but the same name and config).

## Notes

- Presets are per-page: each tab (3D molecule generation, Structure-directed generation, Model training) keeps its own preset list; presets saved on one tab do not appear on the others.
- Scaffold XYZ content is embedded in the preset; the original file path is not stored.
