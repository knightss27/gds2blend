"""
Local web UI for writing the custom layer stack and colors YAML files that
build_gds_scene.py feeds to the BlenderGDS add-on.

Run from the project folder:
    .venv/bin/python webui/server.py
then open http://127.0.0.1:8000 (it opens automatically).

File paths in the UI are relative to the project folder (the one holding
build_gds_scene.py), and the server only reads and writes inside it.
"""
import argparse
import json
import os
import re
import tempfile
import threading
import webbrowser
from collections import OrderedDict
from pathlib import Path

import uvicorn
import yaml
from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from gds_preview import MAX_MASK_SIZE, MAX_REGION_SIZE, GdsDoc
from render_runs import QUICK_MAX_SAMPLES, RunManager, blender_info, open_in_blender, script_settings
from yaml_io import (MAX_NAME_LEN, colors_to_materials, materials_to_yaml, project_to_yaml,
                     validate, yaml_to_project)

WEBUI_DIR = Path(__file__).resolve().parent
PROJECT_DIR = WEBUI_DIR.parent
SKIP_DIRS = {".venv", "webui", ".git", "__pycache__", "renders"}
PROJECT_EXT = ".gds2blend.json"
LAYOUT_EXTS = (".gds", ".gds2", ".gdsii", ".oas", ".oasis")
BUILD_SCRIPT = PROJECT_DIR / "build_gds_scene.py"
RENDERS_DIR = PROJECT_DIR / "renders"
# run.json settings the server fills in for every run; the UI doesn't set them
RUN_FIXED = {"GDS_FILE", "OUTPUT_BLEND", "RENDER_IMAGE", "CUSTOM_LAYER_STACK",
             "CUSTOM_COLOR_FILE", "MATERIAL_OVERRIDES", "CROP_REGION", "PDK", "COLOR_SCHEME",
             "IMPORTED_SCENE", "SAVE_IMPORTED_SCENE"}
# Changing any of these (or the layout file or layer stack) means importing
# the layout again; other settings can be applied to an earlier import
IMPORT_SETTINGS = ("GDS_FILE", "UNIT_SCALE", "Z_SCALE", "MERGE_LAYERS", "INCLUDE_DUMMY_FILL",
                   "ADD_ON_SCENE_SETUP", "MAX_POLYGON_VERTICES", "CROP_REGION")
USER_PRESETS = WEBUI_DIR / "user_presets.yaml"
USER_PRESETS_HEADER = (
    "# Material presets saved from the web UI (\"Save as preset\").\n"
    "# Safe to edit by hand; the UI rewrites this file when presets change.\n\n")

# Where Blender keeps the BlenderGDS add-on, per OS. The newest Blender
# version that has it wins. GDS2BLEND_ADDON_CONFIGS overrides the search.
BLENDER_DIRS = [
    Path.home() / "Library/Application Support/Blender",          # macOS
    Path.home() / ".config/blender",                              # Linux
    Path(os.environ.get("APPDATA", "/nonexistent")) / "Blender Foundation/Blender",  # Windows
]

app = FastAPI(title="gds2blend config editor")

# Parsed layouts, most recently used last. A few are kept so switching back
# to a file doesn't re-read it.
_docs = OrderedDict()
MAX_DOCS = 4


def _project_path(rel):
    """Resolve a user-supplied path, refusing anything outside the project."""
    if not rel:
        raise HTTPException(400, "No file path given.")
    path = (PROJECT_DIR / rel).resolve()
    if PROJECT_DIR not in path.parents:
        raise HTTPException(400, f"{rel!r} is outside the project folder.")
    return path


def _remember(doc):
    _docs[doc.id] = doc
    _docs.move_to_end(doc.id)
    while len(_docs) > MAX_DOCS:
        _docs.popitem(last=False)
    return doc.summary()


def _load_gds(path, name):
    try:
        return _remember(GdsDoc(str(path), name))
    except (ValueError, OSError, RuntimeError) as err:
        raise HTTPException(400, f"Couldn't read {name}: {err}")


@app.get("/api/files")
def list_files():
    """Layout (GDS/OASIS), YAML and project files in the project folder (two levels deep)."""
    found = {"gds": [], "yaml": [], "projects": []}
    for root, dirs, files in os.walk(PROJECT_DIR):
        rel_root = Path(root).relative_to(PROJECT_DIR)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and len(rel_root.parts) < 2]
        for f in sorted(files):
            ext = Path(f).suffix.lower()
            key = "gds" if ext in LAYOUT_EXTS else \
                  "yaml" if ext in (".yaml", ".yml") else \
                  "projects" if f.lower().endswith(PROJECT_EXT) else None
            if key:
                found[key].append(str(rel_root / f) if rel_root.parts else f)
    return found


@app.post("/api/gds/open")
def open_gds(path: str = Body(..., embed=True)):
    full = _project_path(path)
    if not full.is_file():
        raise HTTPException(404, f"{path} not found.")
    return _load_gds(full, path)


@app.post("/api/gds/upload")
async def upload_gds(file: UploadFile = File(...)):
    with tempfile.NamedTemporaryFile(suffix=Path(file.filename or "").suffix or ".gds",
                                     delete=False) as tmp:
        tmp.write(await file.read())
    try:
        return _load_gds(tmp.name, file.filename)
    finally:
        os.unlink(tmp.name)


def _doc(doc_id):
    doc = _docs.get(doc_id)
    if doc is None:
        raise HTTPException(404, "Layout not loaded (the server may have restarted).")
    return doc


@app.get("/api/gds/{doc_id}/mask/{layer}/{datatype}.png")
def layer_mask(doc_id: str, layer: int, datatype: int,
               size: int = Query(2048, ge=64, le=MAX_MASK_SIZE)):
    doc = _doc(doc_id)
    try:
        png = doc.mask_png(layer, datatype, size)
    except KeyError as err:
        raise HTTPException(404, str(err))
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "private, max-age=3600"})


@app.get("/api/gds/{doc_id}/region/{layer}/{datatype}.png")
def layer_region(doc_id: str, layer: int, datatype: int, x: float, y: float,
                 upp: float = Query(..., gt=0),
                 w: int = Query(..., ge=1, le=MAX_REGION_SIZE),
                 h: int = Query(..., ge=1, le=MAX_REGION_SIZE)):
    """A layer's mask for part of the layout: w x h pixels, top-left corner at
    (x, y) µm, `upp` µm per pixel. Used for sharp zoomed-in views."""
    doc = _doc(doc_id)
    try:
        png = doc.region_png(layer, datatype, x, y, upp, w, h)
    except KeyError as err:
        raise HTTPException(404, str(err))
    return Response(png, media_type="image/png",
                    headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/gds/{doc_id}/crop-stats")
def crop_stats(doc_id: str, x: float = Body(...), y: float = Body(...),
               w: float = Body(..., gt=0), h: float = Body(..., gt=0)):
    return {"layers": _doc(doc_id).crop_stats(x, y, w, h)}


# --- Projects ----------------------------------------------------------------

@app.post("/api/project/save")
def save_project(path: str = Body(...), data: dict = Body(...), overwrite: bool = Body(False)):
    """Write a project file. Without overwrite, an existing file is left alone
    and the response says so."""
    if not path.lower().endswith(PROJECT_EXT):
        path += PROJECT_EXT
    full = _project_path(path)
    if full.exists() and not overwrite:
        return {"path": path, "exists": True}
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return {"path": path, "exists": False}


@app.get("/api/project/load")
def load_project(path: str):
    full = _project_path(path)
    if not full.is_file():
        raise HTTPException(404, f"{path} not found.")
    try:
        data = json.loads(full.read_text(encoding="utf-8"))
    except ValueError as err:
        raise HTTPException(400, f"{path} isn't a valid project file: {err}")
    if not isinstance(data, dict) or "layers" not in data:
        raise HTTPException(400, f"{path} isn't a gds2blend project file.")
    return {"path": path, "data": data}


# --- Material presets --------------------------------------------------------

def _read_yaml_mapping(path):
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return {}
    return data if isinstance(data, dict) else {}


def _user_presets():
    return {str(k): v for k, v in _read_yaml_mapping(USER_PRESETS).items() if isinstance(v, dict)}


def _write_user_presets(presets):
    USER_PRESETS.write_text(materials_to_yaml(presets, USER_PRESETS_HEADER), encoding="utf-8")


def _addon_configs_dir():
    override = os.environ.get("GDS2BLEND_ADDON_CONFIGS")
    if override:
        return Path(override) if Path(override).is_dir() else None
    candidates = []
    for root in BLENDER_DIRS:
        if not root.is_dir():
            continue
        for configs in root.glob("*/extensions/*/import_gdsii/configs"):
            version = configs.relative_to(root).parts[0]
            key = tuple(int(n) for n in re.findall(r"\d+", version))
            candidates.append((key, configs))
    return max(candidates)[1] if candidates else None


def _addon_presets():
    """Every material in the add-on's built-in color schemes, one group per
    PDK and scheme, e.g. "LNOI400 · Realistic"."""
    configs = _addon_configs_dir()
    if configs is None:
        return None, []
    groups = []
    for pdk_dir in sorted(p for p in (configs / "colors").iterdir() if p.is_dir()):
        meta = _read_yaml_mapping(configs / f"{pdk_dir.name}.yaml").get("pdk_config") or {}
        pdk_name = re.sub(r"\s+PDK$", "", meta.get("name") or pdk_dir.name.upper())
        for scheme_file in sorted(pdk_dir.glob("*.yaml")):
            data = _read_yaml_mapping(scheme_file)
            materials, _ = colors_to_materials(data)
            if materials:
                scheme = data.get("name") or scheme_file.stem.replace("-", " ").title()
                groups.append({"group": f"{pdk_name} · {scheme}", "presets": materials})
    return str(configs), groups


@app.get("/api/presets")
def presets():
    addon_dir, addon_groups = _addon_presets()
    return {
        "builtin": _read_yaml_mapping(WEBUI_DIR / "presets.yaml"),
        "user": _user_presets(),
        "addon": addon_groups,
        "addon_dir": addon_dir,
    }


def _check_preset_name(name):
    name = (name or "").strip()
    if not name or len(name) > MAX_NAME_LEN:
        raise HTTPException(400, f"Preset names need 1-{MAX_NAME_LEN} characters.")
    return name


@app.post("/api/presets/user")
def save_user_preset(name: str = Body(...), material: dict = Body(...),
                     overwrite: bool = Body(False)):
    name = _check_preset_name(name)
    presets = _user_presets()
    if name in presets and not overwrite:
        return {"exists": True, "user": presets}
    presets[name] = material
    _write_user_presets(presets)
    return {"exists": False, "user": presets}


@app.post("/api/presets/user/rename")
def rename_user_preset(old: str = Body(...), new: str = Body(...)):
    new = _check_preset_name(new)
    presets = _user_presets()
    if old not in presets:
        raise HTTPException(404, f"No preset named {old!r}.")
    if new != old and new in presets:
        raise HTTPException(409, f"A preset named {new!r} already exists.")
    # Rebuild so the renamed preset keeps its place in the file
    presets = {new if k == old else k: v for k, v in presets.items()}
    _write_user_presets(presets)
    return {"user": presets}


@app.delete("/api/presets/user")
def delete_user_preset(name: str):
    presets = _user_presets()
    if presets.pop(name, None) is None:
        raise HTTPException(404, f"No preset named {name!r}.")
    _write_user_presets(presets)
    return {"user": presets}


@app.post("/api/colors/materials")
def materials_from_colors(payload: dict = Body(...)):
    """The materials in a colors YAML, given as a project path or as text."""
    if payload.get("text") is not None:
        text = payload["text"]
    else:
        path = _project_path(payload.get("path"))
        if not path.is_file():
            raise HTTPException(404, f"{payload.get('path')} not found.")
        text = path.read_text(encoding="utf-8")
    try:
        data = yaml.safe_load(text) or {}
    except yaml.YAMLError as err:
        raise HTTPException(400, f"Couldn't read the YAML: {err}")
    if not isinstance(data, dict):
        raise HTTPException(400, "That file isn't a colors file.")
    materials, _ = colors_to_materials(data)
    if not materials:
        raise HTTPException(400, "No materials found. Is this a colors file (with a 'layers:' section)?")
    return {"materials": materials}


@app.post("/api/import")
def import_yaml(payload: dict = Body(...)):
    """Read a layer stack + colors pair, given as project paths or as text."""
    texts = {}
    for kind in ("layers", "colors"):
        if payload.get(f"{kind}_text") is not None:
            texts[kind] = payload[f"{kind}_text"]
        elif payload.get(f"{kind}_path"):
            path = _project_path(payload[f"{kind}_path"])
            if not path.is_file():
                raise HTTPException(404, f"{payload[f'{kind}_path']} not found.")
            texts[kind] = path.read_text(encoding="utf-8")
        else:
            texts[kind] = ""
    try:
        project, warnings = yaml_to_project(texts["layers"], texts["colors"])
    except (yaml.YAMLError, ValueError, KeyError, TypeError) as err:
        raise HTTPException(400, f"Couldn't read the YAML: {err}")
    return {"project": project, "warnings": warnings}


@app.post("/api/export")
def export_yaml(payload: dict = Body(...)):
    """
    Validate the project and render both files. With write=true, also save
    them; existing files are only replaced when overwrite=true, otherwise the
    response lists them under "exists" and nothing is written.
    """
    project = payload.get("project") or {}
    project.setdefault("layers", [])
    project.setdefault("materials", {})
    errors, warnings = validate(project)
    result = {"errors": errors, "warnings": warnings, "written": [], "exists": []}
    if errors:
        return result
    result["layers_yaml"], result["colors_yaml"] = project_to_yaml(project)

    if payload.get("write"):
        targets = {"layers": payload.get("layers_path"), "colors": payload.get("colors_path")}
        paths = {k: _project_path(v) for k, v in targets.items()}
        if paths["layers"] == paths["colors"]:
            raise HTTPException(400, "The two output files need different names.")
        if not payload.get("overwrite"):
            result["exists"] = [targets[k] for k, p in paths.items() if p.exists()]
            if result["exists"]:
                return result
        for kind, path in paths.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(result[f"{kind}_yaml"], encoding="utf-8")
            result["written"].append(targets[kind])
    return result


# --- Building and rendering in Blender -------------------------------------------

runs = RunManager(RENDERS_DIR, BUILD_SCRIPT)


@app.get("/api/render/info")
def render_info():
    """The build script's settings (defaults and help) and the Blender in use."""
    if not BUILD_SCRIPT.is_file():
        raise HTTPException(404, f"{BUILD_SCRIPT.name} isn't in the project folder.")
    try:
        settings = script_settings(BUILD_SCRIPT)
    except SyntaxError as err:
        raise HTTPException(400, f"Couldn't read the settings in {BUILD_SCRIPT.name}: {err}")
    return {"settings": {k: v for k, v in settings.items() if k not in RUN_FIXED},
            "blender": blender_info(), "addon": _addon_configs_dir() is not None}


@app.post("/api/render/run")
def start_run(project: dict = Body(...), settings: dict = Body(...),
              mode: str = Body(...), gds_path: str = Body(None), reimport: bool = Body(False)):
    """Write the YAML files and run.json into a new folder under renders/ and
    queue the build. Returns {"errors"} instead if the project can't be built.
    The layout is only imported again if something that affects the geometry
    changed since the last import, or if `reimport` is set."""
    if mode not in ("build", "quick", "final"):
        raise HTTPException(400, f"Unknown run mode {mode!r}.")
    errors, _ = validate(project)
    if not gds_path:
        errors.append("Open a GDS from the project folder first. Uploaded files can't be "
                      "passed to Blender; copy the file into the project folder instead.")
    elif not _project_path(gds_path).is_file():
        errors.append(f"{gds_path} isn't in the project folder anymore.")
    if not any(l.get("include") for l in project.get("layers", [])):
        errors.append("No layers are checked, so there's nothing to build.")
    known = script_settings(BUILD_SCRIPT)
    unknown = sorted(set(settings) - set(known) | (set(settings) & RUN_FIXED))
    if unknown:
        errors.append(f"Settings {', '.join(unknown)} can't be set from the UI.")
    if errors:
        return {"errors": errors}

    folder = runs.new_folder(mode)
    layers_yaml, colors_yaml = project_to_yaml(project)
    (folder / "custom_layers.yaml").write_text(layers_yaml, encoding="utf-8")
    (folder / "custom_colors.yaml").write_text(colors_yaml, encoding="utf-8")

    crop = project.get("crop")
    run_settings = dict(settings)
    if mode == "quick":
        samples = run_settings.get("CYCLES_SAMPLES", known.get("CYCLES_SAMPLES", {}).get("value", 64))
        run_settings["CYCLES_SAMPLES"] = min(QUICK_MAX_SAMPLES, int(samples))
        res = run_settings.get("RESOLUTION", known.get("RESOLUTION", {}).get("value", (1920, 1080)))
        run_settings["RESOLUTION"] = [max(16, int(v) // 2) for v in res]
    run_settings.update({
        "GDS_FILE": str(_project_path(gds_path)),
        "CUSTOM_LAYER_STACK": str(folder / "custom_layers.yaml"),
        "CUSTOM_COLOR_FILE": str(folder / "custom_colors.yaml"),
        "OUTPUT_BLEND": str(folder / "scene.blend"),
        "RENDER_IMAGE": None if mode == "build" else str(folder / "render.png"),
        "MATERIAL_OVERRIDES": {},  # materials come from the UI's colors file
        "CROP_REGION": [crop["x"], crop["y"], crop["w"], crop["h"]] if crop else None,
    })
    included = [l["name"] for l in project["layers"] if l.get("include")]
    info = {"gds": gds_path, "layers": included, "crop": crop, "settings": settings,
            "resolution": run_settings.get("RESOLUTION"), "samples": run_settings.get("CYCLES_SAMPLES")}
    gds_stat = _project_path(gds_path).stat()
    import_inputs = {k: run_settings.get(k, known.get(k, {}).get("value")) for k in IMPORT_SETTINGS}
    import_inputs.update(gds_size=gds_stat.st_size, gds_mtime=gds_stat.st_mtime_ns,
                         layer_stack=layers_yaml)
    run = runs.start(folder, mode, run_settings, len(included), info,
                     import_inputs=import_inputs, reimport=reimport)
    return {"errors": [], "run": run.summary()}


@app.get("/api/render/runs")
def list_runs():
    return {"runs": runs.list()}


def _run_or_404(name):
    meta, lines = runs.get(name)
    if meta is None:
        raise HTTPException(404, f"No run named {name!r}.")
    return meta, lines


@app.get("/api/render/runs/{name}")
def get_run(name: str, since: int = Query(0, ge=0)):
    """A run's status, plus its log from line `since` on."""
    meta, lines = _run_or_404(name)
    return {"run": meta, "lines": lines[since:], "next": len(lines)}


@app.get("/api/render/runs/{name}/{file}")
def run_file(name: str, file: str):
    if file not in ("render.png", "thumb.jpg", "log.txt", "run.json"):
        raise HTTPException(404, "Not a run file.")
    _run_or_404(name)
    path = RENDERS_DIR / name / file
    if not path.is_file():
        raise HTTPException(404, f"{file} doesn't exist for this run.")
    return FileResponse(path)


@app.post("/api/render/runs/{name}/cancel")
def cancel_run(name: str):
    if not runs.cancel(name):
        raise HTTPException(400, "That run isn't waiting or running.")
    return {"ok": True}


@app.post("/api/render/runs/{name}/open")
def open_run(name: str):
    _run_or_404(name)
    blend = RENDERS_DIR / name / "scene.blend"
    if not blend.is_file():
        raise HTTPException(404, "This run has no .blend file.")
    try:
        open_in_blender(blend)
    except (RuntimeError, OSError) as err:
        raise HTTPException(400, str(err))
    return {"ok": True}


class PageFiles(StaticFiles):
    """The page's own files. Browsers check them for changes on every load
    (cheap: unchanged files come back as 304), so an updated editor shows up
    after a plain reload instead of a stale cached copy."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Registered last so the /api routes above take precedence
app.mount("/", PageFiles(directory=WEBUI_DIR / "static", html=True), name="static")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    print(f"gds2blend config editor: {url}")
    if not args.no_browser:
        # Give uvicorn a moment to start listening first
        threading.Timer(1.0, webbrowser.open, args=(url,)).start()
    # Localhost only: the server reads and writes files in the project folder
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
