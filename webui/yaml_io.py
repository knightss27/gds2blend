"""
Convert between the web UI's project state and the two YAML files the
BlenderGDS add-on reads (layer stack + colors).

Project state, as sent by the browser:
    {
      "stack":  {"name", "description", "def_color"},
      "scheme": {"name", "description"},
      "share_materials": bool,
      "materials": {material_name: {Principled BSDF input: value, ...}},
      "layers": [{"name", "index", "type", "z", "height", "material",
                  "include", "extra": {other stack keys, e.g. "purpose"}}],
    }

Materials are stored separately from layers so several layers can share one.
On export they are either copied into each layer's entry (the add-on's
default format) or written once under "materials:" and referenced by name,
which the add-on also accepts and which makes the layers share one Blender
material.
"""
import math

import yaml

STACK_META_KEY = "pdk_config"
STACK_KEYS = ("index", "type", "z", "height")
MAX_NAME_LEN = 60  # Blender names max out at 63 chars and the add-on prefixes "L"


class _Dumper(yaml.SafeDumper):
    pass


# Colors as [r, g, b, a] on one line, like the add-on's own files
_Dumper.add_representer(
    list, lambda d, v: d.represent_sequence("tag:yaml.org,2002:seq", v, flow_style=True))


def _dump(data):
    return yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True,
                     default_flow_style=False)


def _round(value, digits):
    """Round floats, and turn whole numbers back into floats: JSON from the
    browser sends 1.0 as 1, and the YAML should keep reading "1.0"."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return round(float(value), digits)
    if isinstance(value, list):
        return [_round(v, digits) for v in value]
    return value


def _material_out(props):
    """Material as written to YAML: emission keys only when it actually glows."""
    out = {k: _round(v, 4) for k, v in props.items()}
    if not out.get("Emission Strength"):
        out.pop("Emission Color", None)
        out.pop("Emission Strength", None)
    return out


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate(project):
    """Return (errors, warnings). Errors block export, warnings don't."""
    errors, warnings = [], []
    included = [l for l in project["layers"] if l.get("include")]
    if not included:
        errors.append("No layers are included.")

    seen_names, seen_gds = set(), {}
    for layer in included:
        name = (layer.get("name") or "").strip()
        label = f"Layer {layer.get('index')}/{layer.get('type')}"
        if not name:
            errors.append(f"{label} has no name.")
            continue
        label = f"Layer {name!r} ({layer.get('index')}/{layer.get('type')})"
        if name == STACK_META_KEY:
            errors.append(f"{label}: {STACK_META_KEY!r} is reserved.")
        if len(name) > MAX_NAME_LEN:
            errors.append(f"{label}: name is longer than {MAX_NAME_LEN} characters.")
        if name in seen_names:
            errors.append(f"Layer name {name!r} is used more than once.")
        seen_names.add(name)

        for key in ("index", "type"):
            v = layer.get(key)
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 65535:
                errors.append(f"{label}: GDS {key} must be an integer 0-65535.")
        if not _is_number(layer.get("z")):
            errors.append(f"{label}: z must be a number.")
        if not _is_number(layer.get("height")) or layer["height"] <= 0:
            errors.append(f"{label}: height must be a number above 0.")

        mat = layer.get("material")
        if not mat:
            warnings.append(f"{label} has no material; Blender will use a plain white one.")
        elif mat not in project["materials"]:
            errors.append(f"{label} uses unknown material {mat!r}.")

        gds_key = (layer.get("index"), layer.get("type"))
        if gds_key in seen_gds:
            warnings.append(f"{label} and {seen_gds[gds_key]!r} both extrude GDS layer "
                            f"{gds_key[0]}/{gds_key[1]}.")
        seen_gds.setdefault(gds_key, name)
    return errors, warnings


def project_to_yaml(project):
    """Return (layers_yaml, colors_yaml) for a validated project."""
    included = sorted((l for l in project["layers"] if l.get("include")),
                      key=lambda l: (l["z"], l["index"], l["type"]))

    stack = project.get("stack", {})
    meta = {k: stack[k] for k in ("name", "description", "def_color") if stack.get(k)}
    sections = [_dump({STACK_META_KEY: meta})] if meta else []
    for layer in included:
        entry = {"index": layer["index"], "type": layer["type"],
                 "z": _round(layer["z"], 6), "height": _round(layer["height"], 6)}
        entry.update(layer.get("extra") or {})
        sections.append(_dump({layer["name"].strip(): entry}))
    layers_yaml = "\n".join(sections)

    scheme = project.get("scheme", {})
    head = {k: scheme[k] for k in ("name", "description") if scheme.get(k)}
    materials = project["materials"]
    if project.get("share_materials"):
        used = []
        for layer in included:
            if layer.get("material") and layer["material"] not in used:
                used.append(layer["material"])
        body = {
            "materials": {m: _material_out(materials[m]) for m in used},
            "layers": {l["name"].strip(): l["material"] for l in included if l.get("material")},
        }
    else:
        body = {"layers": {
            l["name"].strip(): _material_out(materials[l["material"]]) if l.get("material") else {}
            for l in included}}
    colors_yaml = _dump(head) + "\n" + _blank_lines_between_entries(_dump(body))
    return layers_yaml, colors_yaml


def _blank_lines_between_entries(text):
    """Blank line before each top-level key and each "  Name:" block, as in the
    add-on's files. One-line "  Name: Material" pairs stay together."""
    out = []
    for line in text.splitlines():
        top_level = not line.startswith(" ")
        block_entry = line.startswith("  ") and not line.startswith("   ") and line.endswith(":")
        if out and (top_level or block_entry) and not out[-1].endswith(":"):
            out.append("")
        out.append(line)
    return "\n".join(out) + "\n"


def yaml_to_project(layers_text, colors_text):
    """Build a project from existing YAML files. Returns (project, warnings)."""
    warnings = []
    stack_data = yaml.safe_load(layers_text or "") or {}
    colors_data = yaml.safe_load(colors_text or "") or {}
    if not isinstance(stack_data, dict) or not isinstance(colors_data, dict):
        raise ValueError("YAML files must contain a mapping at the top level.")

    meta = stack_data.pop(STACK_META_KEY, None) or {}
    layers = []
    for name, data in stack_data.items():
        if not isinstance(data, dict) or not all(k in data for k in STACK_KEYS):
            warnings.append(f"Skipped stack entry {name!r}: needs index, type, z and height.")
            continue
        layers.append({
            "name": str(name),
            "index": data["index"], "type": data["type"],
            "z": data["z"], "height": data["height"],
            "material": None, "include": True,
            "extra": {k: v for k, v in data.items() if k not in STACK_KEYS},
        })

    materials, assignments = colors_to_materials(colors_data)
    by_name = {l["name"]: l for l in layers}
    for name, mat in assignments.items():
        layer = by_name.get(name)
        if layer is None:
            warnings.append(f"Colors file has {name!r}, which isn't in the layer stack.")
        elif mat not in materials:
            warnings.append(f"Layer {name!r} refers to missing material {mat!r}.")
        else:
            layer["material"] = mat

    project = {
        "stack": {k: meta.get(k, "") for k in ("name", "description", "def_color")},
        "scheme": {"name": colors_data.get("name", colors_data.get("Name", "")),
                   "description": colors_data.get("description", "")},
        "share_materials": "materials" in colors_data,
        "materials": materials,
        "layers": layers,
    }
    return project, warnings


def colors_to_materials(colors_data):
    """
    Materials in a parsed colors file: its "materials:" section plus one per
    inline layer entry. Inline entries with identical settings become one
    material, named after the first such layer.
    Returns (materials, {layer name: material name}).
    """
    materials = {str(k): dict(v) for k, v in (colors_data.get("materials") or {}).items()
                 if isinstance(v, dict)}
    assignments = {}
    for name, cfg in (colors_data.get("layers") or {}).items():
        name = str(name)
        if isinstance(cfg, str):
            assignments[name] = cfg
        elif isinstance(cfg, dict):
            match = next((m for m, props in materials.items() if props == cfg), None)
            if match is None:
                match = _unique(name, materials)
                materials[match] = dict(cfg)
            assignments[name] = match
    return materials, assignments


def materials_to_yaml(materials, header=""):
    """A {name: settings} mapping as YAML, e.g. for the user presets file."""
    body = {name: _material_out(props) for name, props in materials.items()}
    return header + (_blank_lines_between_entries(_dump(body)) if body else "")


def _unique(name, taken):
    candidate, n = name, 2
    while candidate in taken:
        candidate, n = f"{name}_{n}", n + 1
    return candidate
