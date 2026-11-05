# gds2blend

Turn a chip layout (GDS or OASIS) into a rendered 3D scene in Blender.

- `build_gds_scene.py` imports a layout into Blender with the
  [BlenderGDS](https://github.com/aesc-silicon/BlenderGDS) add-on, sets up
  materials, camera and lighting, saves a `.blend` and renders an image.
- `webui/` is a local web editor for the two files the script needs: the
  layer stack (which layers to extrude, at what height and thickness) and the
  colors (a material for each layer). It previews the layout, and can run the
  script in Blender and show the renders.

## Requirements

- **Python 3.9 or newer**, for the web editor.
- **Blender 4.2 or newer** (tested with 5.0). On macOS it's expected in
  `/Applications`; on Windows under `Program Files\Blender Foundation`;
  otherwise it must be on the `PATH`. If it's somewhere else, set `BLENDER` to
  its executable before starting the editor:
  `export BLENDER=/path/to/blender`.
- **The GDSII Importer add-on** in Blender: *Edit → Preferences → Get
  Extensions*, search for "GDSII Importer" and install it. It brings its own
  copy of KLayout, which is what reads the layout files.

## Setup

Once, from the project folder (the folder this README is in):

```sh
python3 -m venv .venv
.venv/bin/pip install -r webui/requirements.txt
```

On Windows, use `.venv\Scripts\pip` and `.venv\Scripts\python` instead.

## Running the editor

```sh
.venv/bin/python webui/server.py
```

This opens http://127.0.0.1:8000 in your browser. `--port 8001` picks another
port and `--no-browser` skips opening a tab. The server only listens on your
own computer, and only reads and writes files inside the project folder.
Stop it with Ctrl+C.

A typical session:

1. Prepare your layout (see [Preparing your layout](#preparing-your-layout))
   and put it in the project folder (see below). If the editor is already
   open, reload the page so the file shows up in the menu.
2. Pick it in the layout menu at the top and click **Open**. Every
   layer/datatype in the file gets a row, unchecked and without a material.
3. Check the layers to build, give them names, heights and thicknesses, and
   pick a material for each.
4. On the **Render** tab, click **Quick render** to check the result, then
   **Final render**. Or use **Export YAML…** and run the script yourself.
5. **Save** keeps your work as a project file to open again later.

[webui/README.md](webui/README.md) describes the editor in detail: materials
and presets, cropping, render settings, the sun dial, and reusing imports
between runs.

## Where files go

Everything lives in the project folder, the one containing
`build_gds_scene.py`:

```
gds2blend/
├── build_gds_scene.py          the Blender script
├── my_chip.oas                 ← your layouts go here …
├── layouts/
│   └── other_chip.gds          ← … or in subfolders, up to two levels deep
├── my_chip.gds2blend.json      project files (saved next to the layout by default)
├── custom_layers.yaml          layer stack and colors, written by Export YAML…
├── custom_colors.yaml
├── renders/                    one folder per run from the Render tab (created for you)
└── webui/
    └── user_presets.yaml       materials you saved as presets (created for you)
```

- **Layouts** (`.gds`, `.gds2`, `.gdsii`, `.oas`, `.oasis`) must be in the
  project folder or a subfolder up to two levels down to show up in the
  editor's menu. The `webui/`, `renders/` and `.venv/` folders aren't searched,
  so don't put layouts there.
- **Upload…** previews a layout from anywhere, but Blender can't build from an
  uploaded file. To render it, copy it into the project folder and open it
  from the menu.
- **Project files** (`*.gds2blend.json`) and **YAML files** can be anywhere in
  the project folder too; the Open… and Import YAML… dialogs list them. Paths
  inside a project are stored relative to the project folder, so keep the
  layout where it was when you saved, or open the project and pick the layout
  again.
- **Renders**: each run from the Render tab writes `renders/<date>_<mode>/`
  with the YAML files and settings it used, the log, `scene.blend` and
  `render.png`. Your own `custom_*.yaml` files and the script aren't changed
  by runs. `renders/_imported_scenes/` holds the last two imports so later
  runs can skip importing; it's safe to delete.

Layouts, YAML files, projects, renders, `.blend` files and images are all
ignored by git (see `.gitignore`), except the editor's built-in material
presets in `webui/presets.yaml`.

## Running the script without the editor

Edit the SETTINGS section at the top of `build_gds_scene.py` (`GDS_FILE`,
`CUSTOM_LAYER_STACK`, `CUSTOM_COLOR_FILE`, `OUTPUT_BLEND`, `RENDER_IMAGE` and
the rest; each is explained in a comment), then run:

```sh
blender --background --python build_gds_scene.py
```

Relative paths in the settings are relative to the script's folder, so it
doesn't matter where you run Blender from. To rerun a build from the editor
with exactly the same settings:

```sh
blender --background --python build_gds_scene.py -- --settings renders/<run>/run.json
```

## Preparing your layout

A little preparation in KLayout before you start saves a lot of trouble later.

> **Save GDS files with at most 50 vertices per polygon.** In KLayout, use
> *File → Save As*, choose GDS2, and set the maximum vertex count to 50 or
> less in the options that appear. Polygons with thousands of vertices make
> the import very slow or run out of memory. The script also splits polygons
> before importing (`MAX_POLYGON_VERTICES`, 50 by default; **Split polygons to
> max vertices** in the editor's Render settings), but a file saved this way
> imports faster and works even with that step off. OASIS files can't be
> saved with a limit, so for those, leave the split on.

> **Put everything you want drawn differently on its own layer.** Each
> layer/datatype becomes one Blender object with one height, one thickness
> and one material, and the editor can't tell shapes on the same layer apart.
> For example, SiN that isn't a waveguide (logos, alignment markers, labels)
> should be on a separate layer or datatype from the SiN waveguides, so it
> can get its own material or be left out.

> **Draw pockets as the material around them, not as the pockets.** Every
> shape is extruded upward, so a layer can only add material. To get a layer
> with pockets in it, draw the inverse: a rectangle the size of the die with
> the pockets cut out. In KLayout, draw the die rectangle on a new layer and
> subtract the pocket layer from it (*Edit → Layer → Boolean Operations*,
> "A NOT B"). Shapes with holes import fine.

Very large scenes can also run out of GPU memory when rendering. Render a
crop (**Crop** on the Layout tab) or hide layers you don't need.
