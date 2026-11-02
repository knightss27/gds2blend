"""
Load a GDS file with gdstk and draw one mask image per (layer, datatype).

The browser tints and stacks these masks itself, so changing a color never
touches the GDS again; only a new file or a new preview size does.
"""
import hashlib
import io
import math
from collections import OrderedDict, defaultdict

import gdstk
import numpy as np
from PIL import Image, ImageDraw

# Polygons with more points than this get flagged in the UI. The Blender
# import chokes on huge polygons (see the note in build_gds_scene.py).
MAX_VERTICES_WARNING = 1000

MAX_MASK_SIZE = 8192

# Detail images (zoomed-in views) are capped at this many pixels per side
MAX_REGION_SIZE = 4096
REGION_CACHE = 64

# Cropping makes the add-on merge each layer's shapes (see crop_stats). Above
# this many shapes in the crop, merging them here takes too long to preview.
MAX_MERGE_POLYGONS = 3000


class GdsDoc:
    def __init__(self, path, name):
        with open(path, "rb") as f:
            self.id = hashlib.sha1(f.read()).hexdigest()[:12]
        self.name = name
        lib = gdstk.read_gds(path)

        # KLayout writes a "$$$CONTEXT_INFO$$$" cell for its own metadata;
        # it holds no geometry and the importer ignores it too
        tops = [c for c in lib.top_level() if not c.name.startswith("$$$")]
        if not tops:
            raise ValueError("no top-level cell found")
        self.top_cells = [c.name for c in tops]
        self.unit = lib.unit

        # Flatten the hierarchy once and keep each layer's points around
        self.polygons = defaultdict(list)
        for cell in tops:
            for poly in cell.get_polygons():
                self.polygons[(poly.layer, poly.datatype)].append(poly.points)

        all_pts = [p for polys in self.polygons.values() for p in polys]
        if not all_pts:
            raise ValueError("the layout has no polygons")
        lo = np.min([p.min(axis=0) for p in all_pts], axis=0)
        hi = np.max([p.max(axis=0) for p in all_pts], axis=0)
        self.bbox = (float(lo[0]), float(lo[1]), float(hi[0]), float(hi[1]))
        self._masks = {}
        self._regions = OrderedDict()
        self._boxes = {}

    def summary(self):
        layers = []
        for (layer, datatype), polys in sorted(self.polygons.items()):
            sizes = [len(p) for p in polys]
            boxes = self.boxes(layer, datatype)
            layers.append({
                "layer": layer,
                "datatype": datatype,
                "bbox": [float(boxes[:, 0].min()), float(boxes[:, 1].min()),
                         float(boxes[:, 2].max()), float(boxes[:, 3].max())],
                "polygons": len(polys),
                "vertices": int(sum(sizes)),
                "max_vertices": int(max(sizes)),
                "vertex_warning": max(sizes) > MAX_VERTICES_WARNING,
            })
        return {
            "id": self.id,
            "name": self.name,
            "top_cells": self.top_cells,
            "unit": self.unit,
            "bbox": self.bbox,
            "layers": layers,
        }

    def mask_shape(self, size):
        """Pixel width/height of a mask whose long side is `size` pixels."""
        x0, y0, x1, y1 = self.bbox
        scale = size / max(x1 - x0, y1 - y0)
        return (max(1, math.ceil((x1 - x0) * scale)),
                max(1, math.ceil((y1 - y0) * scale)), scale)

    def mask_png(self, layer, datatype, size):
        """Grayscale+alpha PNG: white where the layer has shapes, clear elsewhere."""
        key = (layer, datatype, size)
        if key in self._masks:
            return self._masks[key]
        polys = self.polygons.get((layer, datatype))
        if polys is None:
            raise KeyError(f"layer {layer}/{datatype} not in {self.name}")

        w, h, scale = self.mask_shape(size)
        x0, _, _, y1 = self.bbox
        alpha = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(alpha)
        offset = np.array([x0, y1])
        flip = np.array([scale, -scale])  # GDS y points up, image y points down
        for pts in polys:
            xy = ((pts - offset) * flip).ravel().tolist()
            # The 1 px outline keeps waveguides narrower than a pixel visible
            draw.polygon(xy, fill=255, outline=255)

        self._masks[key] = _to_png(alpha)
        return self._masks[key]

    def boxes(self, layer, datatype):
        """Bounding box of every polygon on a layer, as an (n, 4) array of
        x0, y0, x1, y1. Lets region drawing and crop stats skip far-off shapes."""
        key = (layer, datatype)
        if key not in self._boxes:
            polys = self.polygons[key]
            sizes = np.fromiter((len(p) for p in polys), int, len(polys))
            starts = np.concatenate(([0], np.cumsum(sizes)[:-1]))
            pts = np.concatenate(polys)
            self._boxes[key] = np.hstack((np.minimum.reduceat(pts, starts),
                                          np.maximum.reduceat(pts, starts)))
        return self._boxes[key]

    def touching(self, layer, datatype, x0, y0, x1, y1):
        """Indices of the polygons whose bounding box overlaps the rectangle."""
        b = self.boxes(layer, datatype)
        return np.nonzero((b[:, 2] >= x0) & (b[:, 0] <= x1) & (b[:, 3] >= y0) & (b[:, 1] <= y1))[0]

    def region_png(self, layer, datatype, x0, y1, upp, w, h):
        """Like mask_png, for a w x h pixel window whose top-left corner is at
        (x0, y1) in layout units, with `upp` layout units per pixel."""
        key = (layer, datatype, x0, y1, upp, w, h)
        if key in self._regions:
            self._regions.move_to_end(key)
            return self._regions[key]
        polys = self.polygons.get((layer, datatype))
        if polys is None:
            raise KeyError(f"layer {layer}/{datatype} not in {self.name}")

        alpha = Image.new("L", (w, h), 0)
        draw = ImageDraw.Draw(alpha)
        offset = np.array([x0, y1])
        flip = np.array([1 / upp, -1 / upp])
        for i in self.touching(layer, datatype, x0, y1 - h * upp, x0 + w * upp, y1):
            draw.polygon(((polys[i] - offset) * flip).ravel().tolist(), fill=255, outline=255)

        self._regions[key] = _to_png(alpha)
        while len(self._regions) > REGION_CACHE:
            self._regions.popitem(last=False)
        return self._regions[key]

    def crop_stats(self, x, y, w, h):
        """Shape and vertex counts per layer inside a crop, as the add-on will
        import them.

        The add-on crops with a KLayout boolean AND, which merges touching
        shapes on a layer into one polygon, so counts here come from the same
        merge. When too many shapes touch the crop to merge quickly, the counts
        are for the shapes as drawn and `merged` is False."""
        rect = gdstk.rectangle((x, y), (x + w, y + h))
        layers = []
        for (layer, datatype), polys in sorted(self.polygons.items()):
            idx = self.touching(layer, datatype, x, y, x + w, y + h)
            entry = {"layer": layer, "datatype": datatype, "polygons": 0,
                     "vertices": 0, "max_vertices": 0, "merged": True}
            if len(idx) > MAX_MERGE_POLYGONS:
                # Shapes partly outside the crop are counted whole
                sizes = [len(polys[i]) for i in idx]
                entry.update(polygons=len(idx), vertices=int(sum(sizes)),
                             max_vertices=int(max(sizes)), merged=False)
            elif len(idx):
                clipped = gdstk.boolean([gdstk.Polygon(polys[i]) for i in idx], rect, "and")
                sizes = [len(p.points) for p in clipped]
                if sizes:
                    entry.update(polygons=len(sizes), vertices=int(sum(sizes)),
                                 max_vertices=int(max(sizes)))
            entry["vertex_warning"] = entry["max_vertices"] > MAX_VERTICES_WARNING
            layers.append(entry)
        return layers


def _to_png(alpha):
    """White image with `alpha` as its alpha channel, as PNG bytes."""
    img = Image.merge("LA", (Image.new("L", alpha.size, 255), alpha))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False)
    return buf.getvalue()
