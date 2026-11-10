#!/usr/bin/env python3
"""Build the fixed browser model catalog and wall/footprint rasters. No pip needed."""
from __future__ import annotations

import argparse
import base64
import json
import math
import statistics
import struct
from collections import deque
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def product(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]


def transform(m, v):
    return tuple(sum(m[r * 4 + c] * v[c] for c in range(3)) + m[r * 4 + 3] for r in range(3))


def matrix(node):
    if "matrix" in node:
        v = node["matrix"]
        return [v[c * 4 + r] for r in range(4) for c in range(4)]
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    rotation = [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w), 0,
                2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w), 0,
                2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y), 0, 0, 0, 0, 1]
    scale = node.get("scale", [1, 1, 1])
    translation = node.get("translation", [0, 0, 0])
    for r in range(3):
        for c in range(3):
            rotation[r * 4 + c] *= scale[c]
        rotation[r * 4 + 3] = translation[r]
    return rotation


class Model:
    def __init__(self, path):
        self.path = path
        self.binary = None
        if path.suffix.lower() == ".glb":
            raw = path.read_bytes()
            magic, version, length = struct.unpack_from("<4sII", raw)
            if magic != b"glTF" or version != 2 or length != len(raw):
                raise ValueError(f"Invalid GLB: {path}")
            offset = 12
            while offset < len(raw):
                size, kind = struct.unpack_from("<II", raw, offset)
                data = raw[offset+8:offset+8+size]
                if kind == 0x4E4F534A:
                    self.doc = json.loads(data)
                elif kind == 0x004E4942:
                    self.binary = data
                offset += 8 + size
        else:
            self.doc = json.loads(path.read_text(encoding="utf-8"))
        self.buffers = {}
        self.accessors = {}

    def accessor(self, index):
        if index in self.accessors:
            return self.accessors[index]
        a = self.doc["accessors"][index]
        if "sparse" in a or "bufferView" not in a or a.get("normalized"):
            raise ValueError("Export standard, unquantized GLB positions for maps")
        view = self.doc["bufferViews"][a["bufferView"]]
        if "EXT_meshopt_compression" in view.get("extensions", {}):
            raise ValueError("Export uncompressed geometry for maps")
        bi = view["buffer"]
        if bi not in self.buffers:
            uri = self.doc["buffers"][bi].get("uri")
            if uri and uri.startswith("data:"):
                self.buffers[bi] = base64.b64decode(uri.split(",", 1)[1])
            elif uri:
                if urlsplit(uri).scheme or urlsplit(uri).netloc:
                    raise ValueError("Keep model buffers next to the glTF file")
                self.buffers[bi] = (self.path.parent / unquote(uri)).read_bytes()
            else:
                self.buffers[bi] = self.binary
        fmt = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}[a["componentType"]]
        dims = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        size = struct.calcsize("<" + fmt * dims)
        stride = view.get("byteStride", size)
        offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        result = [struct.unpack_from("<" + fmt * dims, self.buffers[bi], offset + i * stride) for i in range(a["count"])]
        self.accessors[index] = result
        return result

    def primitives(self):
        doc = self.doc

        def visit(index, parent):
            node = doc["nodes"][index]
            m = product(parent, matrix(node))
            if "mesh" in node:
                for p in doc["meshes"][node["mesh"]]["primitives"]:
                    if p.get("mode", 4) != 4:
                        continue
                    if "KHR_draco_mesh_compression" in p.get("extensions", {}):
                        raise ValueError("Export uncompressed geometry for map preparation")
                    yield p, m
            for child in node.get("children", []):
                yield from visit(child, m)
        for index in doc["scenes"][doc.get("scene", 0)].get("nodes", []):
            yield from visit(index, IDENTITY)

    def bounds(self):
        lo, hi = [math.inf] * 3, [-math.inf] * 3
        for p, m in self.primitives():
            a = self.doc["accessors"][p["attributes"]["POSITION"]]
            if "min" in a and "max" in a:
                points = [(x, y, z) for x in (a["min"][0], a["max"][0])
                          for y in (a["min"][1], a["max"][1]) for z in (a["min"][2], a["max"][2])]
            else:
                points = self.accessor(p["attributes"]["POSITION"])
            for point in points:
                v = transform(m, point)
                for k in range(3):
                    lo[k], hi[k] = min(lo[k], v[k]), max(hi[k], v[k])
        if not all(math.isfinite(v) for v in lo + hi):
            raise ValueError("Model has no bounded triangles")
        return [lo, hi]

    def triangles(self):
        for p, m in self.primitives():
            positions = self.accessor(p["attributes"]["POSITION"])
            indices = [v[0] for v in self.accessor(p["indices"])] if "indices" in p else range(len(positions))
            for i in range(0, len(indices)-2, 3):
                yield tuple(transform(m, positions[indices[i+j]]) for j in range(3))


def rle(values):
    result = []
    for v in values:
        if result and result[-2] == v:
            result[-1] += 1
        else:
            result.extend([int(v), 1])
    return result


def prepare_floor(models, bounds, sensors, resolution):
    height = statistics.median(s["position"]["z"] for s in sensors) - 0.04
    low, high = bounds
    step = max(0.045, max(high[0]-low[0], high[2]-low[2]) / resolution)
    ox, oz = low[0]-step, low[2]-step
    cols = math.ceil((high[0]-ox)/step)+2
    rows = math.ceil((high[2]-oz)/step)+2
    domain, walls = bytearray(cols*rows), bytearray(cols*rows)

    def cell(x, z):
        return ((x-ox)/step, (z-oz)/step)

    def triangle(tri):
        points = [cell(v[0], v[2]) for v in tri]
        for r in range(max(0, math.ceil(min(v[1] for v in points))), min(rows-1, math.floor(max(v[1] for v in points)))+1):
            hits = []
            for a, b in ((0, 1), (1, 2), (2, 0)):
                x1, z1 = points[a]
                x2, z2 = points[b]
                if (z1 <= r < z2) or (z2 <= r < z1):
                    hits.append(x1+(r-z1)/(z2-z1)*(x2-x1))
            if len(hits) >= 2:
                for c in range(max(0, math.ceil(min(hits))), min(cols-1, math.floor(max(hits)))+1):
                    domain[r*cols+c] = 1

    def segment(a, b):
        x1, z1 = cell(a[0], a[2])
        x2, z2 = cell(b[0], b[2])
        count = math.ceil(max(abs(x2-x1), abs(z2-z1))*2)+1
        for i in range(count+1):
            c = round(x1+(x2-x1)*i/count)
            r = round(z1+(z2-z1)*i/count)
            if 0 <= c < cols and 0 <= r < rows:
                walls[r*cols+c] = 1

    for model in models:
        for tri in model.triangles():
            a, b, c = tri
            u, v = [b[k]-a[k] for k in range(3)], [c[k]-a[k] for k in range(3)]
            normal = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]]
            if max(p[1] for p in tri) <= height and normal[1]**2 > 0.75*sum(n*n for n in normal):
                triangle(tri)
            if not min(p[1] for p in tri) < height <= max(p[1] for p in tri):
                continue
            hits = []
            for i, j in ((0, 1), (1, 2), (2, 0)):
                a, b = tri[i], tri[j]
                if (a[1] < height) != (b[1] < height):
                    t = (height-a[1])/(b[1]-a[1])
                    hits.append(tuple(a[k]+t*(b[k]-a[k]) for k in range(3)))
            if len(hits) == 2:
                segment(*hits)
    if not any(domain):
        # Closed wall-only plans: flood the exterior and keep the enclosed area.
        outside = bytearray(cols*rows)
        todo = deque([0])
        while todo:
            i = todo.popleft()
            if outside[i] or walls[i]:
                continue
            outside[i] = 1
            r, c = divmod(i, cols)
            for rr, cc in ((r-1,c),(r+1,c),(r,c-1),(r,c+1)):
                if 0 <= rr < rows and 0 <= cc < cols:
                    todo.append(rr*cols+cc)
        domain = bytearray(0 if v else 1 for v in outside)
    if not any(domain):
        raise ValueError("No floor slab or closed wall outline; a floor footprint is required")
    return {"schema_version": 1, "cols": cols, "rows": rows, "step": step,
            "origin": [ox, oz], "height": height, "render_height": height,
            "domain_rle": rle(domain), "walls_rle": rle(walls)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--resolution", type=int, default=192)
    args = parser.parse_args(argv)
    if not 32 <= args.resolution <= 384:
        parser.error("--resolution must be between 32 and 384")
    root = args.root.resolve()
    sensors = json.loads((root/"data/sensors.json").read_text(encoding="utf-8"))["sensors"]
    buildings, keys = [], set()
    for building in sorted((root/"models/all").iterdir()):
        if not building.is_dir():
            continue
        floors = []
        for floor in sorted(building.iterdir()):
            if not floor.is_dir():
                continue
            paths = sorted(p for p in floor.iterdir() if p.suffix.lower() in (".glb", ".gltf"))
            if not paths:
                continue
            for path in paths:
                if path.stat().st_size > 100*1024*1024:
                    raise ValueError(f"GitHub blocks files over 100 MiB: {path}. Optimize or split the GLB first.")
            models = [Model(p) for p in paths]
            boxes = [m.bounds() for m in models]
            bounds = [[min(b[0][k] for b in boxes) for k in range(3)],
                      [max(b[1][k] for b in boxes) for k in range(3)]]
            entry = {"id": floor.name, "files": [p.relative_to(root).as_posix() for p in paths], "bounds": bounds}
            sites = [s for s in sensors if s["building"] == building.name and s["floor"] == floor.name]
            if sites:
                raster = prepare_floor(models, bounds, sites, args.resolution)
                target = root/"data/maps"/building.name/(floor.name+".json")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(raster, separators=(",", ":")), encoding="utf-8")
                entry["map"] = target.relative_to(root).as_posix()
            floors.append(entry)
            keys.add((building.name, floor.name))
            print(f"Prepared {building.name}/{floor.name}")
        if floors:
            buildings.append({"id": building.name, "floors": floors})
    if not buildings:
        raise ValueError("No floor models found under models/all/BUILDING/FLOOR/")
    for s in sensors:
        if (s["building"], s["floor"]) not in keys:
            raise ValueError(f"Sensor {s['id']} references a missing floor")
    (root/"models/manifest.json").write_text(json.dumps({"schema_version": 1, "buildings": buildings}, indent=2), encoding="utf-8")
    print("Ready: upload models/, data/maps/, data/sensors.json, and models/manifest.json.")


if __name__ == "__main__":
    main()
