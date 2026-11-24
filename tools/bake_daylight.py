"""Build Stratum's daylight textures and static geometry using Blender Cycles."""
import argparse
import hashlib
import json
import math
import os
import struct
import sys
import tempfile
from collections import defaultdict
from pathlib import Path
from urllib.parse import unquote, urlsplit

import bpy
import numpy as np
from mathutils import Vector


UV_NAME = "Stratum Daylight"
DAYLIGHT_ATTRIBUTE = "_STRATUM_DAYLIGHT"
MAX_BLENDER_UVS = 8
CHUNK = 16 * 1024 * 1024
# Store linear white-diffuse radiance up to four in an sRGB PNG. The viewer
# decodes sRGB and restores this scale before its usual tone mapping.
RANGE = 4.0


def select(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def check_source(path):
    if path.suffix.lower() == ".glb":
        with path.open("rb") as stream:
            magic, version, length, size, kind = struct.unpack("<4s4I", stream.read(20))
            if magic != b"glTF" or version != 2 or kind != 0x4E4F534A or length != path.stat().st_size:
                raise ValueError(f"{path} is not a complete glTF 2.0 GLB")
            doc = json.loads(stream.read(size))
    else:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
    if doc.get("asset", {}).get("version") != "2.0":
        raise ValueError(f"Expected glTF 2.0: {path}")
    for entry in doc.get("buffers", []) + doc.get("images", []):
        uri = entry.get("uri")
        if uri and not uri.startswith("data:"):
            resource = urlsplit(uri)
            if resource.scheme or resource.netloc or not (path.parent / unquote(resource.path)).is_file():
                raise ValueError(f"Missing local buffer or texture for {path.name}: {uri}")


def import_meshes(paths, ratio=1.0):
    geometry = []
    for path in paths:
        check_source(path)
        before = set(bpy.data.objects)
        print(f"Importing {path}", flush=True)
        if bpy.ops.import_scene.gltf(filepath=str(path)) != {"FINISHED"}:
            raise ValueError(f"Could not import {path}")
        imported = set(bpy.data.objects) - before
        bpy.context.view_layer.update()
        meshes = sorted((o for o in imported if o.type == "MESH" and len(o.data.polygons)), key=lambda o: o.name)
        if not meshes:
            raise ValueError(f"No mesh faces in {path}")
        # Keep site coordinates even when the source uses transformed parents.
        world = {o: o.matrix_world.copy() for o in meshes}
        for obj in meshes:
            obj.parent = None
            obj.matrix_world = world[obj]
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            if ratio < 1:
                select([obj])
                decimate = obj.modifiers.new("Landscape budget", "DECIMATE")
                decimate.ratio = ratio
                decimate.delimit = {"UV", "MATERIAL", "SEAM"}
                bpy.ops.object.modifier_apply(modifier=decimate.name)
        for obj in imported.difference(meshes):
            bpy.data.objects.remove(obj, do_unlink=True)
        geometry.extend(meshes)
    return geometry


def split_landscape_mesh(obj, budget):
    mesh = obj.data
    count = len(mesh.polygons)
    if count <= budget:
        return [obj]
    # Split complete faces at spatial medians. Blender's native separation
    # preserves corner UVs, vertex colours, custom normals and node transforms.
    centers = np.empty((count, 3), dtype=np.float32)
    mesh.polygons.foreach_get("center", centers.ravel())
    centers = centers @ np.asarray(obj.matrix_world.to_3x3(), dtype=np.float32).T
    labels = np.empty(count, dtype=np.int32)
    page_count = math.ceil(count / budget)

    def partition(indices, first, pages):
        if pages == 1:
            labels[indices] = first
            return
        coords = centers[indices]
        axis = int(np.argmax(np.ptp(coords, axis=0)))
        left = pages // 2
        cut = len(indices) * left // pages
        order = indices[np.argpartition(coords[:, axis], cut)]
        partition(order[:cut], first, left)
        partition(order[cut:], first + left, pages - left)

    partition(np.arange(count), 0, page_count)
    saved = np.empty(count, dtype=np.int32)
    mesh.polygons.foreach_get("material_index", saved)
    attr = mesh.attributes.new("stratum_saved_material", "INT", "FACE")
    name = attr.name
    attr.data.foreach_set("value", saved)
    old_slots = [slot.material for slot in obj.material_slots]
    mesh.materials.clear()
    temporary = [bpy.data.materials.new("Stratum spatial partition") for _ in range(page_count)]
    for mat in temporary:
        mesh.materials.append(mat)
    mesh.polygons.foreach_set("material_index", labels)
    select([obj])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="MATERIAL")
    bpy.ops.object.mode_set(mode="OBJECT")
    parts = sorted(bpy.context.selected_objects, key=lambda item: item.name)
    for part in parts:
        data = part.data
        saved = np.empty(len(data.polygons), dtype=np.int32)
        data.attributes[name].data.foreach_get("value", saved)
        data.materials.clear()
        for mat in old_slots:
            data.materials.append(mat)
        data.polygons.foreach_set("material_index", saved)
        data.attributes.remove(data.attributes[name])
        data.update()
    for mat in temporary:
        bpy.data.materials.remove(mat)
    bpy.context.view_layer.update()
    return parts


def batches(objects, budget):
    batch, count = [], 0
    for obj in objects:
        faces = len(obj.data.polygons)
        if batch and count + faces > budget:
            yield batch
            batch, count = [], 0
        batch.append(obj)
        count += faces
    if batch:
        yield batch


def landscape_pages(objects, face_budget=90000, cell=24):
    # Join nearby props to reduce draw calls while keeping frustum culling.
    bins = defaultdict(list)
    for source in objects:
        for obj in split_landscape_mesh(source, face_budget):
            center = obj.matrix_world @ (sum((Vector(v) for v in obj.bound_box), Vector()) / 8)
            bins[(math.floor(center.x / cell), math.floor(center.y / cell))].append(obj)
    merged = []
    for cell_id in sorted(bins):
        for group in batches(bins[cell_id], face_budget):
            if len(group) > 1:
                select(group)
                bpy.ops.object.join()
            merged.append(group[0])
    return list(batches(merged, face_budget))


def read_uvs(layer):
    values = np.empty((len(layer.uv), 2), dtype=np.float32)
    layer.uv.foreach_get("vector", values.ravel())
    return values


def store_vectors(mesh, name, coords):
    attribute = mesh.attributes.new(name, "FLOAT_VECTOR", "CORNER")
    if attribute.name != name:
        raise ValueError(f"Mesh {mesh.name} already contains an attribute named {name!r}")
    values = np.zeros((len(coords), 3), dtype=np.float32)
    values[:, :2] = coords
    attribute.data.foreach_set("vector", values.ravel())


def make_uvs(meshes, size):
    channel = max(1, max(len(o.data.uv_layers) for o in meshes))
    borrowed = {}
    for obj in meshes:
        layers = obj.data.uv_layers
        if layers.get(UV_NAME):
            raise ValueError(f"{obj.name} already has a UV set named {UV_NAME}. Use the source export.")
        if not len(layers):
            layers.new(name="UVMap", do_init=False)
        original = next(layer.name for layer in layers if layer.active_render)
        if len(layers) == MAX_BLENDER_UVS:
            # Smart UV Project requires a real UV layer. Temporarily reuse a
            # non-render layer, and restore it before exporting the visual mesh.
            layer = next(layer for layer in reversed(list(layers)) if not layer.active_render)
            borrowed[obj] = (layer.name, read_uvs(layer))
            layer.name = UV_NAME
        else:
            if channel < MAX_BLENDER_UVS:
                while len(layers) < channel:
                    layers.new(name=f"UVMap{len(layers)}", do_init=False)
            layers.new(name=UV_NAME, do_init=False)
        layers.active_index = layers.find(UV_NAME)
        layers[original].active_render = True
    select(meshes)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    result = bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=min(0.015, 3 / size),
                                     margin_method="FRACTION", correct_aspect=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    if result != {"FINISHED"}:
        raise ValueError("Blender could not unwrap the daylight UV layer")
    if channel == MAX_BLENDER_UVS:
        for obj in meshes:
            mesh = obj.data
            layer = mesh.uv_layers[UV_NAME]
            coords = read_uvs(layer)
            coords[:, 1] = 1 - coords[:, 1]  # glTF image origin
            store_vectors(mesh, DAYLIGHT_ATTRIBUTE, coords)
            if obj in borrowed:
                name, original = borrowed[obj]
                layer = mesh.uv_layers[UV_NAME]
                layer.name = name
                layer.uv.foreach_set("vector", original.ravel())
            else:
                mesh.uv_layers.remove(mesh.uv_layers[UV_NAME])
    return channel, borrowed


def restore_bake_layers(meshes, borrowed):
    for obj in meshes:
        mesh = obj.data
        values = np.empty((len(mesh.loops), 3), dtype=np.float32)
        mesh.attributes[DAYLIGHT_ATTRIBUTE].data.foreach_get("vector", values.ravel())
        values[:, 1] = 1 - values[:, 1]
        mesh.attributes.remove(mesh.attributes[DAYLIGHT_ATTRIBUTE])
        if obj in borrowed:
            name, original = borrowed[obj]
            mesh.uv_layers[name].name = UV_NAME
            # Cycles can still sample the original named coordinates in the
            # material, including the alpha cutout used to cast leaf shadows.
            store_vectors(mesh, name, original)
        else:
            mesh.uv_layers.new(name=UV_NAME, do_init=False)
        mesh.uv_layers[UV_NAME].uv.foreach_set("vector", np.ascontiguousarray(values[:, :2]).ravel())
        mesh.update()


def write_geometry(unit, stage):
    target = stage / unit["directory"]
    target.mkdir()
    meshes = unit["objects"]
    print(f"Preparing daylight UVs for {unit['name']} ({sum(len(obj.data.polygons) for obj in meshes):,} faces)", flush=True)
    channel, borrowed = make_uvs(meshes, unit["size"])
    # The exporter must see the authored mapping as active. The bake below
    # names its secondary UV explicitly.
    for obj in meshes:
        layers = obj.data.uv_layers
        layers.active_index = next(i for i, layer in enumerate(layers) if layer.active_render)
    select(meshes)
    model = target / "model.glb"
    bpy.ops.export_scene.gltf(filepath=str(model), use_selection=True, export_animations=False,
                              export_skins=False, export_morph=False, export_cameras=False,
                              export_lights=False, export_yup=True, export_texcoords=True,
                              export_attributes=(channel == MAX_BLENDER_UVS))
    with model.open("rb") as fp:
        if fp.read(4) != b"glTF":
            raise ValueError(f"Invalid export for {unit['name']}")
        fp.seek(12)
        length, kind = struct.unpack("<II", fp.read(8))
        doc = json.loads(fp.read(length))
    key = DAYLIGHT_ATTRIBUTE if channel == MAX_BLENDER_UVS else f"TEXCOORD_{channel}"
    for mesh in doc["meshes"]:
        for prim in mesh["primitives"]:
            if prim.get("mode", 4) == 4 and key not in prim["attributes"]:
                raise ValueError(f"Blender omitted {key} on {unit['name']}")
    if channel == MAX_BLENDER_UVS:
        restore_bake_layers(meshes, borrowed)
    files = [model]
    length = model.stat().st_size
    if length > CHUNK:
        files = []
        with model.open("rb") as fp:
            while block := fp.read(CHUNK):
                part = target / f"mesh-{len(files):03d}.bin"
                part.write_bytes(block)
                files.append(part)
        model.unlink()
    return {"uv": channel, "bytes": length, "files": [p.relative_to(stage).as_posix() for p in files],
            "maps": {}}


def setup_daylight(samples, use_gpu):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    if use_gpu:
        preferences = bpy.context.preferences.addons["cycles"].preferences
        for backend in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                preferences.compute_device_type = backend
                preferences.refresh_devices()
            except (TypeError, RuntimeError):
                continue
            devices = [d for d in preferences.devices if d.type == backend]
            if devices:
                for device in preferences.devices:
                    device.use = device in devices
                scene.cycles.device = "GPU"
                print("Cycles GPU:", ", ".join(d.name for d in devices), flush=True)
                break
        else:
            print("No compatible Cycles GPU detected. Using CPU.", flush=True)
    scene.cycles.samples = samples
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 3
    scene.cycles.transparent_max_bounces = 12
    scene.cycles.use_denoising = False
    world = bpy.data.worlds.new("Blue daylight")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.73, 0.83, 1.0, 1)
    bg.inputs["Strength"].default_value = 0.68
    sun = bpy.data.lights.new("Afternoon sun", "SUN")
    sun.color = (1.0, 0.86, 0.70)
    sun.energy = 3.2
    sun.angle = math.radians(3)
    lamp = bpy.data.objects.new(sun.name, sun)
    scene.collection.objects.link(lamp)
    lamp.rotation_euler = Vector((0.70, 0.52, -0.88)).to_track_quat("-Z", "Y").to_euler()


def connect_input(tree, source, target):
    if source.is_linked:
        tree.links.new(source.links[0].from_socket, target)
    else:
        target.default_value = source.default_value


def bake_material(material, proxies):
    if material in proxies:
        return proxies[material]
    proxy = material.copy() if material else bpy.data.materials.new("Neutral receiver")
    proxy.use_nodes = True
    tree = proxy.node_tree
    output = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output), None)
    if output is None:
        output = tree.nodes.new("ShaderNodeOutputMaterial")
    # glTF imports with an implicit primary UV for ordinary images. Keep
    # alpha cards and normal maps on that UV while Cycles writes a second UV.
    implicit = [n for n in tree.nodes if n.type == "TEX_IMAGE" and not n.inputs["Vector"].is_linked]
    if implicit:
        primary = tree.nodes.new("ShaderNodeUVMap")
        primary.uv_map = "UVMap"
        for node in implicit:
            tree.links.new(primary.outputs["UV"], node.inputs["Vector"])
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    diffuse = tree.nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.inputs["Color"].default_value = (0.75, 0.75, 0.75, 1)
    shader = diffuse.outputs[0]
    if not bsdf:
        # Blender's glTF unlit importer uses an emission node behind a
        # camera-ray switch, optionally wrapped by a texture-driven alpha mix.
        emission = next((n for n in tree.nodes if n.type == "EMISSION"), None)
        if emission:
            connect_input(tree, emission.inputs["Color"], diffuse.inputs["Color"])
            link = output.inputs["Surface"].links
            outer = link[0].from_node if link else None
            if outer and outer.type == "MIX_SHADER" and outer.inputs[1].is_linked:
                fac = outer.inputs[0]
                camera_switch = fac.is_linked and fac.links[0].from_node.type == "LIGHT_PATH"
                if not camera_switch and outer.inputs[1].links[0].from_node.type == "BSDF_TRANSPARENT":
                    tree.links.new(shader, outer.inputs[2])
                    shader = outer.outputs[0]
    if bsdf:
        # Keep albedo for indirect bounces and the authored normal / cutout
        # silhouette for light transport. The DIFFUSE bake omits the receiver's
        # albedo, which the viewer will sample at its original resolution.
        connect_input(tree, bsdf.inputs["Base Color"], diffuse.inputs["Color"])
        if bsdf.inputs["Normal"].is_linked:
            connect_input(tree, bsdf.inputs["Normal"], diffuse.inputs["Normal"])
        alpha = bsdf.inputs["Alpha"]
        transmission = bsdf.inputs.get("Transmission Weight")
        if alpha.is_linked or alpha.default_value < 1 or (transmission and (transmission.is_linked or transmission.default_value > 0)):
            mix = tree.nodes.new("ShaderNodeMixShader")
            tree.links.new(tree.nodes.new("ShaderNodeBsdfTransparent").outputs[0], mix.inputs[1])
            tree.links.new(shader, mix.inputs[2])
            connect_input(tree, alpha, mix.inputs[0])
            if transmission and (transmission.is_linked or transmission.default_value > 0):
                opaque = tree.nodes.new("ShaderNodeMath")
                opaque.operation = "SUBTRACT"
                opaque.inputs[0].default_value = 1
                connect_input(tree, transmission, opaque.inputs[1])
                product = tree.nodes.new("ShaderNodeMath")
                product.operation = "MULTIPLY"
                connect_input(tree, alpha, product.inputs[0])
                tree.links.new(opaque.outputs[0], product.inputs[1])
                tree.links.new(product.outputs[0], mix.inputs[0])
            shader = mix.outputs[0]
    tree.links.new(shader, output.inputs["Surface"])
    image_node = tree.nodes.new("ShaderNodeTexImage")
    tree.nodes.active = image_node
    proxies[material] = (proxy, image_node)
    return proxy, image_node


def install_receivers(units):
    proxies = {}
    for unit in units:
        nodes = set()
        for obj in unit["objects"]:
            if not obj.material_slots:
                obj.data.materials.append(None)
            for slot in obj.material_slots:
                proxy, node = bake_material(slot.material, proxies)
                slot.material = proxy
                nodes.add(node)
        unit["targets"] = nodes


def save_png(image, path):
    scene = bpy.context.scene
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0
    scene.view_settings.gamma = 1
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    image.save_render(str(path), scene=scene)


def sky_reflections(stage):
    # Six roughness bands of a fixed sky. The viewer samples these directly
    # when a window or metal facade reflects the sky as the camera moves.
    w, h, levels = 256, 128, 6
    lat = (np.arange(h)[:, None] + 0.5) * math.pi / h
    lon = ((np.arange(w)[None, :] + 0.5) / w - 0.5) * (2 * math.pi)
    x, y, z = np.sin(lat) * np.cos(lon), np.cos(lat), np.sin(lat) * np.sin(lon)
    sun = np.array([-0.70, 0.88, 0.52])
    sun /= np.linalg.norm(sun)
    alignment = x * sun[0] + y * sun[1] + z * sun[2]
    bands = []
    for band in range(levels):
        rough = band / (levels - 1)
        horizon = (0.5 + 0.5 * np.tanh(y / (0.055 + 0.8 * rough ** 2)))[..., None]
        zenith = np.maximum(y, 0)[..., None] * (1 - 0.6 * rough)
        sky = (1 - zenith) * [0.89, 1.01, 1.10] + zenith * [0.38, 0.58, 0.92]
        ambient = (1 - horizon) * [0.19, 0.20, 0.17] + horizon * sky
        width = 0.0017 + 0.23 * rough ** 4
        highlight = (0.012 / width) * np.exp((alignment - 1) / width)
        bands.append(ambient + highlight[..., None] * [1.0, 0.86, 0.70])
    colors = np.concatenate(bands, axis=0)[::-1]
    rgba = np.ones((levels * h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(colors / 8, 0, 1)
    image = bpy.data.images.new("Sky reflections", w, levels * h, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "Linear Rec.709"
    image.pixels.foreach_set(rgba.ravel())
    image.update()
    save_png(image, stage / "sky.png")
    bpy.data.images.remove(image)
    return "sky.png"


def bake(unit, label, stage):
    size = unit["size"]
    print(f"Baking {unit['name']} / {label} at {size}px", flush=True)
    image = bpy.data.images.new("Daylight target", size, size, alpha=False, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    for node in unit["targets"]:
        node.image = image
        node.id_data.nodes.active = node
    select(unit["objects"])
    result = bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, uv_layer=UV_NAME,
                                 target="IMAGE_TEXTURES", margin=2, margin_type="EXTEND", use_clear=True)
    if result != {"FINISHED"}:
        raise RuntimeError(f"Bake failed for {unit['name']}")
    values = np.empty(size * size * 4, dtype=np.float32)
    image.pixels.foreach_get(values)
    pixels = values.reshape((-1, 4))
    pixels[:, :3] = np.clip(pixels[:, :3] / RANGE, 0, 1)
    pixels[:, 3] = 1
    # Float linear buffer -> Standard sRGB PNG, bypassing Filmic/AgX/exposure.
    image.colorspace_settings.name = "Linear Rec.709"
    image.pixels.foreach_set(values)
    image.update()
    path = stage / unit["directory"] / f"{label}.png"
    save_png(image, path)
    for node in unit["targets"]:
        node.image = None
    bpy.data.images.remove(image)
    unit["asset"]["maps"][label] = path.relative_to(stage).as_posix()


def gltfs(folder):
    return sorted(p for p in folder.rglob("*") if p.is_file() and p.suffix.lower() in {".glb", ".gltf"})


def options():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--surroundings", type=Path, help="One .glb/.gltf, including files outside the repository")
    parser.add_argument("--floor-size", type=int, default=1024)
    parser.add_argument("--landscape-size", type=int, default=512)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--gpu", action="store_true", help="Use an available Cycles GPU for the bake")
    parser.add_argument("--landscape-ratio", type=float, default=1, help="Optional triangle proportion, e.g. 0.5")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    for size in (args.floor_size, args.landscape_size):
        if size not in (64, 128, 256, 512, 1024, 2048, 4096, 8192):
            parser.error("Atlas size must be a power of two from 64 to 8192.")
    if args.samples < 1 or not 0 < args.landscape_ratio <= 1:
        parser.error("Use positive samples and a landscape ratio above zero and at most one.")
    return args


def build(args, stage):
    root = args.root.resolve()
    catalog = json.loads((root / "models/manifest.json").read_text(encoding="utf-8-sig"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    groups = defaultdict(list)
    all_units = []
    result = {"version": 1, "range": RANGE, "floors": {}, "exteriors": {}, "surroundings": None}
    floor_art = root / "campus-source/floors"
    known = {(b["id"], f["id"]) for b in catalog["buildings"] for f in b["floors"]}
    for source in gltfs(floor_art):
        parts = source.relative_to(floor_art).parts
        if len(parts) < 3 or tuple(parts[:2]) not in known:
            raise ValueError(f"{source} must be in an existing building/floor from models/manifest.json")
    exterior_art = root / "campus-source/exteriors"
    building_ids = {b["id"] for b in catalog["buildings"]}
    for source in gltfs(exterior_art):
        parts = source.relative_to(exterior_art).parts
        if len(parts) < 2 or parts[0] not in building_ids:
            raise ValueError(f"{source} must be underneath an existing building ID in campus-source/exteriors/")
    for building in catalog["buildings"]:
        for floor in building["floors"]:
            key = building["id"] + "/" + floor["id"]
            paths = gltfs(floor_art / building["id"] / floor["id"]) or [root / f for f in floor["files"]]
            unit = {"name": key, "directory": f"floor-{len(all_units):03d}", "size": args.floor_size,
                    "objects": import_meshes(paths)}
            unit["asset"] = write_geometry(unit, stage)
            result["floors"][key] = {"sources": floor["files"], "asset": unit["asset"]}
            groups[building["id"]].append(unit)
            all_units.append(unit)
        exterior = gltfs(exterior_art / building["id"])
        if exterior:
            unit = {"name": building["id"] + " exterior", "directory": f"exterior-{len(result['exteriors']):03d}",
                    "size": args.floor_size, "objects": import_meshes(exterior), "exterior": True}
            unit["asset"] = write_geometry(unit, stage)
            result["exteriors"][building["id"]] = unit["asset"]
            groups[building["id"]].append(unit)
            all_units.append(unit)
    candidates = [args.surroundings.resolve()] if args.surroundings else gltfs(root / "campus-source/surroundings")
    if len(candidates) > 1:
        raise ValueError("Provide one campus surroundings scene or specify --surroundings PATH.")
    if candidates:
        path = candidates[0]
        if not path.is_file() or path.suffix.lower() not in {".gltf", ".glb"}:
            raise ValueError(f"Expected a glTF 2.0 .glb or .gltf scene: {path}")
        objects = import_meshes([path], args.landscape_ratio)
        result["surroundings"] = []
        print("Preparing landscape sections", flush=True)
        for i, page in enumerate(landscape_pages(objects)):
            unit = {"name": f"Surroundings {i + 1}", "directory": f"surroundings-{i:03d}",
                    "size": args.landscape_size, "objects": page}
            unit["asset"] = write_geometry(unit, stage)
            result["surroundings"].append(unit["asset"])
            all_units.append(unit)
    if not all_units:
        raise ValueError("No campus geometry found.")
    setup_daylight(args.samples, args.gpu)
    result["sky"] = sky_reflections(stage)
    install_receivers(all_units)

    def visible(units):
        included = {id(u) for u in units}
        for u in all_units:
            for obj in u["objects"]:
                obj.hide_render = id(u) not in included
        bpy.context.view_layer.update()

    visible(all_units)
    for unit in all_units:
        bake(unit, "campus", stage)
    for building_units in groups.values():
        same_as_campus = len(building_units) == len(all_units)
        visible(building_units)
        for unit in building_units:
            maps = unit["asset"]["maps"]
            if same_as_campus:
                maps["building"] = maps["campus"]
            else:
                bake(unit, "building", stage)
        for unit in building_units:
            if unit.get("exterior"):
                continue
            maps = unit["asset"]["maps"]
            if len(building_units) == 1:
                maps["floor"] = maps["building"]
            else:
                visible([unit])
                bake(unit, "floor", stage)
    return result


def main():
    if not bpy.app.background:
        raise RuntimeError("Use Bake-Campus.cmd or run Blender in background mode to bake separate from your open project.")
    args = options()
    models = args.root.resolve() / "models"
    store = models / "lighting"
    store.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".daylight-", dir=store) as temp:
        temp = Path(temp)
        stage = temp / "assets"
        stage.mkdir()
        index = build(args, stage)
        digest = hashlib.sha256()
        for file in sorted(stage.rglob("*")):
            if file.is_file():
                digest.update(file.relative_to(stage).as_posix().encode() + b"\0")
                with file.open("rb") as fp:
                    while block := fp.read(1024 * 1024):
                        digest.update(block)
        revision = digest.hexdigest()[:16]
        destination = store / revision
        if not destination.exists():
            stage.rename(destination)
        index["base"] = f"models/lighting/{revision}/"
        manifest = temp / "lighting.json"
        manifest.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
        os.replace(manifest, models / "lighting.json")
    print(f"Ready: {models / 'lighting.json'} and {destination}", flush=True)


if __name__ == "__main__":
    main()
