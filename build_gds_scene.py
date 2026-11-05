"""
Build a Blender scene from a GDS file with the BlenderGDS add-on
(https://github.com/aesc-silicon/BlenderGDS) and save it as a .blend.

Edit the SETTINGS section below, then run:
    blender --background --python build_gds_scene.py
or build and render from the web UI, which passes its settings in a JSON
file (see load_settings_file below).

Open the resulting .blend and everything is already set up.
Rerun the script whenever the GDS or the settings change.

IMPORTANT:
This will most likely break if not take forever to run / eat up all your
computer's RAM if the layout has polygons with lots of vertices.
MAX_POLYGON_VERTICES below splits them before importing (the same as KLayout's
Save As with a max vertex count); lower it, to 50 or even smaller, if a large
file is still too slow.

Custom layers and colors are dictated by the two .yaml files. To make or
edit them with a preview of the layout, run the web UI (see webui/README.md):
    .venv/bin/python webui/server.py


"""
import json
import math
import os
import shutil
import sys
import tempfile
import time

import addon_utils
import bpy
from mathutils import Vector

# Print each line as it happens even when the output goes to a pipe (the web
# UI shows it live), rather than all at once when Blender exits
sys.stdout.reconfigure(line_buffering=True)

# Relative paths below are resolved against the folder this script lives in,
# so it doesn't matter which directory you launch Blender from.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ===========================================================================
# SETTINGS
# ===========================================================================

# --- Files -----------------------------------------------------------------
GDS_FILE = "coilsbs.gds"         # layout to import (.gds or .oas)
OUTPUT_BLEND = "coil_test.blend"  # .blend written at the end (overwritten on each run)


# Ignore PDK selection since we want our own custom things...

# --- Layer stack / PDK -----------------------------------------------------
# Built-in PDKs (the key is the config file name, uppercased, '-' -> '_'):
#   "IHP_SG13G2"      IHP Open PDK SG13G2 (130 nm BiCMOS)
#   "IHP_SG13CMOS5L"  IHP SG13CMOS5L
#   "SKY130"          SkyWater SKY130
#   "GF180MCU"        GlobalFoundries GF180MCU
#   "SIEPIC"          SiEPIC EBeam (silicon photonics)
#   "LNOI400"         Luxtelligence LNOI400 (thin-film lithium niobate)
PDK = "IHP_SG13G2"

# Color scheme for a built-in PDK: "realistic", "fancy", "marketing", "marketing-gold"
COLOR_SCHEME = "realistic"

# Custom layer stack instead of a built-in PDK. Set both to YAML file paths to
# use them (format is described in the add-on README); leave as None to use PDK above.
CUSTOM_LAYER_STACK = "custom_layers_sbs.yaml"    # e.g. "my_stack.yaml"  (layer index/type/z/height)
CUSTOM_COLOR_FILE = "custom_colors_sbs.yaml"     # e.g. "my_colors.yaml" (Principled BSDF values per layer)

# --- Import options --------------------------------------------------------
# GDS database unit scale. 1e-6 means 1 Blender unit = 1 um, which is what the
# layer-stack z/height values and the add-on's scene setup assume.
UNIT_SCALE = 1e-4

# Multiplies every layer's z position and thickness. Real stacks are only a few
# um tall, so on a mm-sized chip they look flat; 5-20 exaggerates the 3D effect.
Z_SCALE = 0.1

# Union overlapping shapes on each layer before meshing. Leave on: it avoids
# black rendering artifacts in Cycles from overlapping faces.
MERGE_LAYERS = False

# Split polygons into pieces of at most this many vertices before importing,
# the same as KLayout's Save As with a max vertex count. Polygons with
# thousands of vertices make the import very slow or run out of memory, and
# OASIS files can't be saved with a limit, so this matters most for .oas.
# It costs one extra read and write of the layout. Cropping and MERGE_LAYERS
# join touching shapes again, so they can bring large polygons back.
# None imports the file as it is.
MAX_POLYGON_VERTICES = 50

# Include metal dummy fill layers (only matters for PDKs that define them).
# Usually off: fill adds a lot of geometry and visual clutter.
INCLUDE_DUMMY_FILL = False

# Import only part of the chip. Set to (x, y, width, height) in um, measured
# from the layout's origin; the cropped area is shifted so its lower-left
# corner sits at Blender's origin. None imports the whole layout.
CROP_REGION = None           # e.g. (100.0, 200.0, 50.0, 50.0)
# CROP_REGION = (50.0, 34650.0, 3400.0, 2800.0)
# CROP_REGION = (-17500.0, 12500.0, 38500.0, 25500.0)

# Let the add-on create Cycles render settings (GPU if available), a dark
# world, a sun light, a camera and a dark "ChipBase" ground plane.
ADD_ON_SCENE_SETUP = True

# Height of the ChipBase ground plane, in the same units as the layer stack's
# z (um, before Z_SCALE). The add-on puts it at -1 Blender unit, which is
# -1 / Z_SCALE um (10 um below z = 0 at Z_SCALE = 0.1). Keep it a little
# below your lowest layer: at exactly that layer's z, the two faces overlap
# and flicker in the render. None leaves it where the add-on put it.
CHIP_BASE_Z = -0.05

# --- Scene tweaks applied after the import ---------------------------------
# Layers to hide in viewport and render. Use layer names as they appear in the
# PDK's layer stack (objects are created as "L" + name, e.g. "LMetal1").
# Imported layer names are printed to the console when the script runs.
HIDE_LAYERS = [""]             # e.g. ["NWell", "Substrate"]

# Per-layer material overrides: layer name -> Principled BSDF inputs.
# Anything not listed keeps the color scheme's values.
MATERIAL_OVERRIDES = {
    # "Metal1": {"Base Color": (0.9, 0.6, 0.2, 1.0), "Metallic": 1.0, "Roughness": 0.25},
}

# Camera. The add-on puts it straight down at z = 200 um with a 100-unit clip
# distance, which only works for tiny layouts. With REFRAME_CAMERA on, the
# camera is moved to fit the whole imported chip instead.
REFRAME_CAMERA = True
CAMERA_TILT_DEG = 0         # 0 = looking straight down, 90 = looking from the side
CAMERA_DISTANCE = 2.0        # distance as a multiple of the chip's largest side; smaller = closer
CAMERA_LENS_MM = 46          # focal length; longer = flatter perspective

# Sun light. A sun is directional: its light arrives in parallel rays from one
# direction, so only that direction and the strength matter, not its distance.
# Azimuth is the side the light comes from, in degrees clockwise from the
# layout's +y ("up" in KLayout): 0 = top, 90 = right, 180 = bottom, 270 = left.
# Elevation is its height above the horizon: 90 = straight down, low values
# give long shadows. The defaults match the add-on's own sun.
# ADJUST_SUN = False leaves the add-on's sun as it is. With it on and
# ADD_ON_SCENE_SETUP off, a sun is created.
ADJUST_SUN = True
SUN_STRENGTH = 3.0           # irradiance in W/m^2; 1-5 is typical
SUN_AZIMUTH_DEG = 134        # side the light comes from, clockwise from layout +y
SUN_ELEVATION_DEG = 44       # height above the horizon, 0-90
SUN_ANGLE_DEG = 0.5          # apparent size of the sun; larger = softer shadow edges

# Reflection "softbox": a large emissive panel placed where the camera sees it
# mirrored in the chip surface, so metallic/glossy materials have something
# bright to reflect. It is invisible to the camera itself; only its reflection
# and light show up. Needs REFRAME_CAMERA (or any camera) to position it.
ADD_SOFTBOX = True
SOFTBOX_STRENGTH = 1.0       # emission strength; raise if the sheen is too faint
SOFTBOX_SIZE = 5.0           # panel size as a multiple of the chip's largest side

# Render output
RESOLUTION = (1920, 1080)
CYCLES_SAMPLES = 256         # more = less noise, slower renders

# Render the camera view after saving the .blend. Set to None to skip rendering.
# The extension picks the format: .png (default), .jpg, .tif or .exr.
RENDER_IMAGE = "coil1.png"
# Transparent background instead of the world color (PNG/TIFF/EXR only).
# Useful for dropping the chip onto slides or posters.
TRANSPARENT_BACKGROUND = False

# Glow around bright pixels (e.g. emissive waveguides), added in the compositor
# after rendering. Only pixels brighter than GLARE_THRESHOLD glow, so set the
# waveguides' Emission Strength well above 1 and leave the threshold at ~1 to
# keep the rest of the chip crisp.
ADD_GLARE = True
GLARE_TYPE = "BLOOM"         # "BLOOM" (soft, wide glow), "FOG_GLOW", "STREAKS", "GHOSTS", "SIMPLE_STAR"
GLARE_THRESHOLD = 1.0        # brightness above which pixels glow; lower = more glows
GLARE_STRENGTH = 0.5         # glow intensity (Blender 4.4+; older versions ignore it)

# ===========================================================================
# END OF SETTINGS
# ===========================================================================

# The web UI sets these to skip the GDS import when only materials, lighting,
# camera or render settings changed since an earlier build. The scene saved
# right after that import is opened instead, its materials are rebuilt from
# CUSTOM_COLOR_FILE, and everything below the import runs as usual.
IMPORTED_SCENE = None        # .blend to start from instead of importing
SAVE_IMPORTED_SCENE = None   # where to save the scene right after importing

# The web UI runs this script as
#     blender --background --python build_gds_scene.py -- --settings run.json
# Values in that JSON file replace the settings above; anything it leaves out
# keeps the value set here.
def load_settings_file():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--settings" not in args:
        return
    path = args[args.index("--settings") + 1]
    with open(path, encoding="utf-8") as f:
        overrides = json.load(f)
    settings = globals()
    for key, value in overrides.items():
        if not key.isupper() or key not in settings:
            print(f"Settings file: unknown setting {key!r}, ignored")
            continue
        # JSON has no tuples; RESOLUTION, CROP_REGION and colors expect them
        settings[key] = tuple(value) if isinstance(value, list) else value
    print(f"Settings from {path}: {', '.join(overrides)}")


load_settings_file()


def resolve(path):
    """Make a settings path absolute, relative to this script's folder."""
    return path if os.path.isabs(path) else os.path.join(SCRIPT_DIR, path)


gds_path = resolve(GDS_FILE)
out_path = resolve(OUTPUT_BLEND)
if not os.path.isfile(gds_path):
    sys.exit(f"GDS file not found: {gds_path}")

if IMPORTED_SCENE:
    bpy.ops.wm.open_mainfile(filepath=IMPORTED_SCENE, load_ui=False)
    print(f"Opened imported scene {IMPORTED_SCENE} instead of importing the GDS again")
else:
    # Start from an empty scene. read_homefile (unlike read_factory_settings)
    # keeps your preferences, so the installed extension stays enabled.
    bpy.ops.wm.read_homefile(use_empty=True)


def importer_registered():
    return hasattr(bpy.types, "IMPORT_SCENE_OT_gdsii")


if not importer_registered():
    # Module name depends on how the extension was installed:
    # Get Extensions -> blender_org, Install from Disk (zip) -> user_default
    for mod in ("bl_ext.blender_org.import_gdsii", "bl_ext.user_default.import_gdsii"):
        try:
            addon_utils.enable(mod, default_set=True)
        except Exception:
            pass
        if importer_registered():
            break
if not importer_registered():
    sys.exit("GDSII Importer extension not found. Install it from Get Extensions first.")

scene = bpy.context.scene
use_custom = CUSTOM_LAYER_STACK is not None
if use_custom and CUSTOM_COLOR_FILE is None:
    sys.exit("CUSTOM_LAYER_STACK needs CUSTOM_COLOR_FILE set too")


def import_layout():
    # In the GUI, the "Select PDK" dialog stores the PDK choice in these scene
    # properties and then opens the importer, which reads them back from the scene.
    # Setting them here lets us call the importer directly and skip the dialog.
    if use_custom:
        scene.gdsii_use_custom_config = True
        scene.gdsii_custom_config_path = resolve(CUSTOM_LAYER_STACK)
        scene.gdsii_custom_color_path = resolve(CUSTOM_COLOR_FILE)
        for p in (scene.gdsii_custom_config_path, scene.gdsii_custom_color_path):
            if not os.path.isfile(p):
                sys.exit(f"Custom config file not found: {p}")
        # Note: the add-on still prints "Using PDK: <name>" in this mode; ignore it.
        # Its "Layer stack config:" line shows the file actually used.
        print(f"Using CUSTOM layer stack: {scene.gdsii_custom_config_path}")
        print(f"Using CUSTOM colors:      {scene.gdsii_custom_color_path}")
    else:
        scene.gdsii_use_custom_config = False
        scene.gdsii_pdk_selection = PDK

    import_kwargs = dict(
        filepath=gds_path,
        unit_scale=UNIT_SCALE,
        z_scale=Z_SCALE,
        create_collection=True,   # layers go in a collection named after the GDS file
        setup_scene=ADD_ON_SCENE_SETUP,
        merge_layers=MERGE_LAYERS,
        add_fill=INCLUDE_DUMMY_FILL,
    )
    if not use_custom:
        import_kwargs["color_scheme"] = COLOR_SCHEME
    if CROP_REGION is not None:
        # The add-on reads the crop in Blender units (um only at UNIT_SCALE = 1e-6),
        # so convert from um. Passing um at another scale crops far off the chip.
        um_to_bu = 1e-6 / UNIT_SCALE
        x, y, w, h = (v * um_to_bu for v in CROP_REGION)
        # The add-on silently enlarges crops narrower than 0.1 Blender units
        min_um = 0.1 / um_to_bu
        if min(w, h) < 0.1:
            sys.exit(f"CROP_REGION width and height must be at least {min_um:g} um at UNIT_SCALE = {UNIT_SCALE:g}")
        import_kwargs.update(use_crop=True, crop_x=x, crop_y=y, crop_width=w, crop_height=h)

    split_dir = None
    if MAX_POLYGON_VERTICES:
        from klayout import db  # bundled with the add-on

        started = time.time()
        layout = db.Layout()
        layout.read(gds_path)  # GDS or OASIS
        split_dir = tempfile.mkdtemp(prefix="gds2blend_")
        # Keep the file's name: the add-on names the layer collection after it
        stem = os.path.splitext(os.path.basename(gds_path))[0]
        import_kwargs["filepath"] = os.path.join(split_dir, stem + ".gds")
        options = db.SaveLayoutOptions()
        options.format = "GDS2"
        options.gds2_max_vertex_count = max(4, int(MAX_POLYGON_VERTICES))  # KLayout's minimum is 4
        layout.write(import_kwargs["filepath"], options)
        layout._destroy()
        print(f"Split polygons to at most {options.gds2_max_vertex_count} vertices "
              f"in {time.time() - started:.1f} s")

    try:
        result = bpy.ops.import_scene.gdsii(**import_kwargs)
    finally:
        if split_dir:
            shutil.rmtree(split_dir, ignore_errors=True)
    if "FINISHED" not in result:
        sys.exit(f"GDS import failed ({result}); see the console output above.")


def use_gpu():
    """Turn on GPU rendering the way the add-on's scene setup does. The device
    choice is a preference, not part of the .blend, so an opened scene needs it
    again."""
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            if any(d.type != "CPU" for d in prefs.devices):
                for d in prefs.devices:
                    d.use = True
                print(f"Cycles GPU: {backend}")
                return
        except Exception:
            continue
    scene.cycles.device = "CPU"
    print("Cycles GPU: no compatible device found, falling back to CPU")


def rebuild_materials():
    """Replace the layer materials in an opened scene with the ones in
    CUSTOM_COLOR_FILE, built by the add-on's own code so they come out the
    same as in a fresh import."""
    import yaml  # bundled with the add-on

    if not use_custom:
        sys.exit("IMPORTED_SCENE needs CUSTOM_LAYER_STACK and CUSTOM_COLOR_FILE")
    with open(resolve(CUSTOM_COLOR_FILE), encoding="utf-8") as f:
        colors = yaml.safe_load(f) or {}
    addon = next(m for name, m in sys.modules.items()
                 if name.endswith(".import_gdsii") and hasattr(m, "create_material"))
    objs = [o for o in scene.objects if o.type == "MESH" and o.name.startswith("L")]
    for mat in {m for o in objs for m in o.data.materials if m}:
        bpy.data.materials.remove(mat)
    for obj in objs:
        name = cfg_name = obj.name[1:]
        cfg = colors.get("layers", {}).get(name, {})
        if isinstance(cfg, str):  # a layer pointing to a shared material
            cfg_name, cfg = cfg, colors.get("materials", {}).get(cfg, {})
        mat = addon.create_material(cfg_name, cfg or {})
        if obj.data.materials:
            obj.data.materials[0] = mat
        else:
            obj.data.materials.append(mat)


if IMPORTED_SCENE:
    rebuild_materials()
    if scene.render.engine == "CYCLES" and scene.cycles.device == "GPU":
        use_gpu()
else:
    import_layout()
    if SAVE_IMPORTED_SCENE:
        # Before any of the changes below, so a later run can start from here
        if os.path.exists(SAVE_IMPORTED_SCENE):
            os.remove(SAVE_IMPORTED_SCENE)  # no .blend1 backup next to it
        bpy.ops.wm.save_as_mainfile(filepath=SAVE_IMPORTED_SCENE, copy=True)
        print(f"Kept the imported scene for later runs: {SAVE_IMPORTED_SCENE}")

# Layer objects are named "L<LayerName>", their materials "<LayerName>"
layer_objs = [o for o in scene.objects if o.type == "MESH" and o.name.startswith("L")]
print("Imported layers:", ", ".join(o.name[1:] for o in layer_objs))

# --- Hide layers -----------------------------------------------------------
for name in HIDE_LAYERS:
    obj = scene.objects.get("L" + name)
    if obj is None:
        print(f"HIDE_LAYERS: no layer named {name!r}")
        continue
    obj.hide_render = obj.hide_viewport = True

# --- Chip base height ------------------------------------------------------
chip_base = scene.objects.get("ChipBase")
if CHIP_BASE_Z is not None and chip_base is not None:
    # Its vertices sit at z = -1; move the object so they end up at CHIP_BASE_Z
    chip_base.location.z = CHIP_BASE_Z * Z_SCALE + 1

# --- Material overrides ----------------------------------------------------
for name, values in MATERIAL_OVERRIDES.items():
    mat = bpy.data.materials.get(name)
    if mat is None:
        print(f"MATERIAL_OVERRIDES: no material named {name!r}")
        continue
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    for key, value in values.items():
        bsdf.inputs[key].default_value = value

# --- Camera ----------------------------------------------------------------
visible = [o for o in layer_objs if not o.hide_render]
if REFRAME_CAMERA and visible:
    pts = [o.matrix_world @ Vector(c) for o in visible for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    size = max(hi.x - lo.x, hi.y - lo.y)

    cam = scene.camera
    if cam is None:  # no camera if ADD_ON_SCENE_SETUP is off
        cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
        scene.collection.objects.link(cam)
        scene.camera = cam

    cam.data.lens = CAMERA_LENS_MM
    cam.data.clip_start = size * 1e-4
    cam.data.clip_end = size * 20
    tilt = math.radians(CAMERA_TILT_DEG)
    dist = size * CAMERA_DISTANCE
    cam.location = center + Vector((0, -math.sin(tilt) * dist, math.cos(tilt) * dist))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    # cam.rotation_euler.x = math.radians(44.0)

# --- Sun -------------------------------------------------------------------
if ADJUST_SUN:
    sun = next((o for o in scene.objects if o.type == "LIGHT" and o.data.type == "SUN"), None)
    if sun is None:
        sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", type="SUN"))
        scene.collection.objects.link(sun)
    az, el = math.radians(SUN_AZIMUTH_DEG), math.radians(SUN_ELEVATION_DEG)
    # Unit vector from the chip toward the sun
    toward_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    # A sun shines along its local -Z
    sun.rotation_euler = (-toward_sun).to_track_quat("-Z", "Y").to_euler()
    sun.data.energy = SUN_STRENGTH
    sun.data.angle = math.radians(SUN_ANGLE_DEG)
    # Position doesn't affect the light; this just puts the sun where you can
    # see it in the viewport, off to the side it shines from
    if visible:
        pts = [o.matrix_world @ Vector(c) for o in visible for c in o.bound_box]
        center = sum(pts, Vector()) / len(pts)
        size = max(max(p.x for p in pts) - min(p.x for p in pts),
                   max(p.y for p in pts) - min(p.y for p in pts))
        sun.location = center + toward_sun * size
    print(f"Sun: strength {SUN_STRENGTH}, azimuth {SUN_AZIMUTH_DEG}°, elevation {SUN_ELEVATION_DEG}°")

# --- Reflection softbox ----------------------------------------------------
# A flat mirror only shows what lies along the mirror direction of the camera.
# Mirror the camera position through the vertical axis at the chip center and
# put a big emissive panel there, facing the chip. An emissive surface is used
# instead of an area light because Blender treats 1 unit as 1 m, so at this
# micrometer scale a light's falloff over "thousands of meters" makes it
# almost invisible, while emission strength doesn't depend on distance.
if ADD_SOFTBOX and visible and scene.camera is not None:
    pts = [o.matrix_world @ Vector(c) for o in visible for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    center = (lo + hi) / 2
    size = max(hi.x - lo.x, hi.y - lo.y)

    v = scene.camera.matrix_world.translation - center
    mirror_pos = center + Vector((-v.x, -v.y, v.z))

    half = size * SOFTBOX_SIZE / 2
    mesh = bpy.data.meshes.new("SoftboxMesh")
    mesh.from_pydata([(-half, -half, 0), (half, -half, 0), (half, half, 0), (-half, half, 0)],
                     [], [(0, 1, 2, 3)])
    softbox = bpy.data.objects.new("Softbox", mesh)
    scene.collection.objects.link(softbox)
    softbox.location = mirror_pos
    # Point the panel's normal (+Z) at the chip center
    softbox.rotation_euler = (center - mirror_pos).to_track_quat("Z", "Y").to_euler()
    softbox.visible_camera = False     # seen only in reflections
    softbox.visible_shadow = False     # don't shade the chip

    mat = bpy.data.materials.new("SoftboxMat")
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    nodes.clear()
    emit = nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = SOFTBOX_STRENGTH
    out = nodes.new("ShaderNodeOutputMaterial")
    links.new(emit.outputs["Emission"], out.inputs["Surface"])
    mesh.materials.append(mat)

# --- Render settings -------------------------------------------------------
scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
if scene.render.engine == "CYCLES":
    scene.cycles.samples = CYCLES_SAMPLES

scene.render.film_transparent = TRANSPARENT_BACKGROUND


# --- Compositor glare ------------------------------------------------------
def set_node_option(node, prop_name, socket_name, values):
    """Set a node option that is a property in older Blender versions and an
    input socket in newer ones. Tries each candidate value until one sticks."""
    for value in values:
        try:
            if hasattr(node, prop_name):
                setattr(node, prop_name, value)
            elif socket_name in node.inputs:
                node.inputs[socket_name].default_value = value
            else:
                return False
            return True
        except (TypeError, ValueError):
            continue
    return False


def add_glare(scene):
    """Render Layers -> Glare -> output, in a fresh compositor node tree."""
    if hasattr(scene, "compositing_node_group"):
        # Blender 5.0+: the compositor is a node group assigned to the scene,
        # and its result goes to a Group Output node
        tree = bpy.data.node_groups.new("Compositing", "CompositorNodeTree")
        tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        scene.compositing_node_group = tree
        nodes, links = tree.nodes, tree.links
        rl = nodes.new("CompositorNodeRLayers")
        out = nodes.new("NodeGroupOutput")
        out_socket = out.inputs[0]
    else:
        # Blender 4.x: the scene owns its compositor tree once use_nodes is on
        scene.use_nodes = True
        tree = scene.node_tree
        nodes, links = tree.nodes, tree.links
        nodes.clear()
        rl = nodes.new("CompositorNodeRLayers")
        out = nodes.new("CompositorNodeComposite")
        out_socket = out.inputs["Image"]

    glare = nodes.new("CompositorNodeGlare")
    rl.location, glare.location, out.location = (-400, 0), (0, 0), (300, 0)

    type_ok = set_node_option(glare, "glare_type", "Type",
                              [GLARE_TYPE, GLARE_TYPE.replace("_", " ").title()])
    set_node_option(glare, "threshold", "Threshold", [GLARE_THRESHOLD])
    set_node_option(glare, "__no_such_prop__", "Strength", [GLARE_STRENGTH])
    if not type_ok:
        print(f"Glare: couldn't set type {GLARE_TYPE!r}, using the node's default")

    links.new(rl.outputs["Image"], glare.inputs["Image"])
    links.new(glare.outputs["Image"], out_socket)
    scene.render.use_compositing = True


if ADD_GLARE:
    try:
        add_glare(scene)
    except Exception as err:  # don't lose the whole build over a cosmetic step
        print(f"Glare: skipped ({err})")

# Store the image path and format in the .blend too, so F12 + Image > Save in
# the GUI defaults to the same output.
if RENDER_IMAGE is not None:
    image_path = resolve(RENDER_IMAGE)
    formats = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG",
               ".tif": "TIFF", ".tiff": "TIFF", ".exr": "OPEN_EXR"}
    ext = os.path.splitext(image_path)[1].lower()
    scene.render.image_settings.file_format = formats.get(ext, "PNG")
    if scene.render.image_settings.file_format in ("PNG", "TIFF", "OPEN_EXR"):
        scene.render.image_settings.color_mode = "RGBA" if TRANSPARENT_BACKGROUND else "RGB"
    else:
        scene.render.image_settings.color_mode = "RGB"  # JPEG has no alpha
    scene.render.filepath = image_path
    scene.render.use_file_extension = False  # use the path exactly as given

# Save before rendering, so the .blend exists even if you stop a long render
bpy.ops.wm.save_as_mainfile(filepath=out_path)
print(f"Saved {out_path}")

# --- Render ----------------------------------------------------------------
if RENDER_IMAGE is not None:
    if scene.camera is None:
        sys.exit("No camera in the scene to render from")
    print(f"Rendering {scene.render.resolution_x}x{scene.render.resolution_y} "
          f"with {scene.render.engine} ...")

    # Background renders print no progress of their own; report Cycles'
    # status ("Sample 12/256", time remaining) about once a second
    last_report = [0.0]

    def report_progress(stats):
        now = time.monotonic()
        if now - last_report[0] >= 1 or "Finished" in stats:
            last_report[0] = now
            print(f"Render progress: {stats}")

    bpy.app.handlers.render_stats.append(report_progress)
    # write_still saves the result to scene.render.filepath
    bpy.ops.render.render(write_still=True)
    print(f"Rendered {image_path}")