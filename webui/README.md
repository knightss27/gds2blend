# gds2blend config editor

A local web page for writing `custom_layers.yaml` and `custom_colors.yaml`,
the two files `build_gds_scene.py` hands to the BlenderGDS add-on.

## Run

Setup, starting the editor, and where layout and other files go are in the
[top-level README](../README.md). In short, from the project folder:

```sh
.venv/bin/python webui/server.py            # opens http://127.0.0.1:8000
```

## Use

1. The editor starts empty. To continue earlier work, open a project
   (**Open…**) or load existing YAML files with **Import YAML…**.
2. Pick a GDS or OASIS (`.oas`) file from the project folder and click
   **Open**, or **Upload…** one from elsewhere. Every layer/datatype gets a
   row in the layer list, unchecked and without a material.
3. For each layer: check it to include it, give it a name, set `z` and `h`
   (height, in µm), and pick a material. The dropdown can also create a new
   material from a preset in `presets.yaml`.
4. Select a layer to edit its material. Layers can share a material; use
   **Make a copy for this layer** to split one off.
5. **Export YAML…** shows both files, lists any problems, and writes them to
   the project folder. It asks before replacing existing files.

The preview shows color, opacity and emission glow only. Metallic, roughness
and IOR show up in the Blender render.

## Projects, presets and undo

- **Save / Save as… / Open…** in the top bar handle project files
  (`*.gds2blend.json`, by default next to the GDS). A project file keeps what
  the YAML files can't: unchecked layers and their names, which layers share
  a material, unused materials, the GDS file, export paths and preview
  settings. The YAML files are still what `build_gds_scene.py` reads, so
  export them when you're ready to build. ⌘S saves; a ● next to the project
  name means unsaved changes.
- If the GDS changed since the project was saved, opening the project lists
  new layers (added unchecked) and layers that are no longer in the file.
- Unsaved work is copied to the browser's storage as you go. If the tab or
  server closes before you save, the next start offers to restore it.
- **Undo / redo:** ⌘Z and ⇧⌘Z (or the ↶ ↷ buttons). A slider drag or a typed
  value counts as one step. While a text field has focus, ⌘Z undoes typing in
  that field instead.
- **Presets:** in the material editor, **Save as preset…** stores the material
  in `webui/user_presets.yaml` ("My presets"), so other projects can use it.
  **Browse all presets…** in a layer's material dropdown lists My presets,
  the shipped `presets.yaml`, and every material in the BlenderGDS add-on's
  built-in color schemes (LNOI400, SiEPIC, IHP, SKY130, GF180MCU). There you
  can search, rename or delete your own presets, and copy all the materials
  from another colors YAML into the project.
- The add-on's schemes are found in the newest Blender version's extensions
  folder. If yours is somewhere else, set `GDS2BLEND_ADDON_CONFIGS` to the
  add-on's `configs` folder before starting the server.

## Zooming and cropping

- Scroll to zoom, drag to pan, double-click to fit. Once you zoom in past
  what the whole-chip preview can show, the visible area is drawn again at
  screen resolution ("Loading detail…" in the corner). You can zoom to about
  1 nm per screen pixel.
- **Crop** (in the view tools, or **Crop region** in the side panel) picks
  `CROP_REGION` for `build_gds_scene.py`: the part of the chip the add-on
  imports. Drag on the canvas to draw it, drag its edges or inside to adjust
  it, or type x, y, width and height in µm. Edges snap to round numbers;
  hold ⌥ to turn that off. Space-drag pans and Esc finishes.
- With a crop set, each layer row shows how many shapes are inside it, and
  warns if cropping leaves polygons over 1000 vertices. The add-on merges
  touching shapes on a layer when it crops, so a crop can create larger
  polygons than the GDS has. When too many shapes touch the crop to merge
  quickly, the counts are for the shapes as drawn.
- The crop is saved in the project file but isn't part of the YAML files.
  Copy the `CROP_REGION = (…)` line from the panel into `build_gds_scene.py`.

## Building and rendering in Blender

The **Render** tab runs `build_gds_scene.py` in Blender with what's in the
UI: the current layers and materials, the crop, and the render settings.
Your YAML files and the script aren't changed.

- **Build .blend** imports and saves the scene without rendering. **Quick
  render** uses half the resolution and at most 32 samples, for checking
  framing and colors. **Final render** uses the full settings.
- **Settings** lists the script's settings (unit scale, chip base, hidden
  layers, camera, softbox, glow, resolution, samples). They start at the
  values in `build_gds_scene.py`; changed ones are marked and saved with the
  project. **Reset** goes back to the script's values. Hover a setting for the
  script's comment on it.
- Each run gets a folder under `renders/` with the YAML files and `run.json`
  it ran with, `log.txt`, `scene.blend` and `render.png`. Runs go one at a
  time; the tab title shows progress. Pick a run in the strip to see its image
  and log, **Use these settings** to load its settings and crop back, or
  **Open in Blender** to open its `.blend`.
- Importing the layout is usually the slow part, so runs skip it when they
  can. A run that imports also keeps the scene as it was right after the
  import (in `renders/_imported_scenes/`, the last two imports). A later run
  that changes only materials, lighting, camera, glow, hidden layers, chip base
  height or render settings starts from that scene. It rebuilds the materials
  and redoes the rest, with the same result as a fresh import. Changing the
  layout file, the layer stack (checked layers, names, z, heights), the crop,
  or unit scale, Z scale, merging, polygon splitting or scene setup imports
  again. The run's summary says which happened. Check **Re-import layout** to
  import again anyway, e.g. after editing the import part of
  `build_gds_scene.py` or updating the add-on.
- **Camera** on the Layout tab outlines what the camera will see, for a
  straight-down camera.
- **Sun** on the Layout tab shows the sun's direction as a dial centered on
  the scene: the center is straight overhead, the dashed circle is the
  horizon. Drag the sun around the dial to change the side the light comes
  from (azimuth), and toward the center to raise it (elevation). Strength and
  shadow softness are in the Sun settings. A sun lights everything from one
  direction, so it has no distance to set.
- **Side by side** shows the layout and the render next to each other.
- Blender is found in `/Applications`, on the `PATH`, or under Program Files.
  Set `BLENDER` to its executable before starting the server if it's
  elsewhere.
- To run the script with the same settings outside the UI:
  `blender --background --python build_gds_scene.py -- --settings renders/<run>/run.json`

The layer stack column on the left shows the checked layers as a cross-section.
**Schematic** draws every layer the same height; **To scale** uses the real
thicknesses. Click a layer to select it.

## Notes

- Colors are linear RGB, the same values Blender uses. The color pickers
  convert to and from screen (sRGB) colors for you.
- **Share materials between layers in Blender** writes each material once
  under `materials:` and makes layers point to it by name. The add-on
  supports this format. Layers using the same material then share one
  Blender material.
- Material settings the editor doesn't show, and extra stack keys such as
  `purpose`, are kept unchanged on export.
- A ⚠ next to a layer means it has polygons with more than 1000 vertices that
  will reach Blender. The script splits large polygons before importing
  (**Split polygons to max vertices** in the Render settings, on at 50 by
  default), so the ⚠ only shows when that's off, when **Merge overlapping
  shapes** is on, or when a crop merges touching shapes back together.
- OASIS files are usually much smaller than the same layout as GDS, but
  KLayout can't limit their vertex count when saving. Leave the polygon split
  on for them.
