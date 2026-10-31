"""Inspect a generated GLB and optionally add explicit mechanical pivots.

Run with Blender, for example:
  blender --background --python mechanical_postprocess.py -- input.glb copy.glb report.json [parts.json]

The optional parts file is a reviewed mapping of pivot names to exact object
names, e.g. {"DrillBit": ["ConeMesh"], "Wheel_FL": ["WheelFrontLeft"]}.
No geometry is inferred or renamed. The source file is never overwritten.
"""
import json
import os
import sys

import bpy


def args_after_separator():
    args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(args) not in (3, 4):
        raise SystemExit("expected input.glb output.glb inspection.json [parts.json]")
    return args


def inspect_objects():
    result = []
    for obj in sorted(bpy.context.scene.objects, key=lambda item: item.name):
        if obj.type not in {"MESH", "EMPTY", "ARMATURE"}:
            continue
        result.append({
            "name": obj.name,
            "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "dimensions": [round(float(v), 5) for v in obj.dimensions],
            "world_position": [round(float(v), 5) for v in obj.matrix_world.translation],
        })
    return result


def add_reviewed_pivots(mapping):
    by_name = {obj.name: obj for obj in bpy.context.scene.objects}
    missing = []
    for pivot_name, names in mapping.items():
        objects = [by_name[name] for name in names if name in by_name]
        missing.extend(name for name in names if name not in by_name)
        if not objects:
            continue
        # Pivot at the first explicitly reviewed part's origin. Keep every
        # object's world transform unchanged while inserting the hierarchy.
        pivot = bpy.data.objects.new(pivot_name, None)
        bpy.context.scene.collection.objects.link(pivot)
        pivot.empty_display_type = "PLAIN_AXES"
        pivot.matrix_world = objects[0].matrix_world.copy()
        for obj in objects:
            world = obj.matrix_world.copy()
            obj.parent = pivot
            obj.matrix_world = world
        pivot["mechanical_role"] = pivot_name
    if missing:
        raise ValueError("mapping refers to absent object names: " + ", ".join(missing))


def main():
    source, output, report, *mapping_path = args_after_separator()
    if os.path.abspath(source) == os.path.abspath(output):
        raise SystemExit("output path must differ from source path")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)
    objects = inspect_objects()
    mapping = {}
    if mapping_path:
        with open(mapping_path[0], encoding="utf-8") as stream:
            mapping = json.load(stream)
        add_reviewed_pivots(mapping)
    with open(report, "w", encoding="utf-8") as stream:
        json.dump({"source": os.path.abspath(source), "objects": objects,
                   "reviewed_pivots": mapping}, stream, indent=2)
    bpy.ops.export_scene.gltf(filepath=output, export_format="GLB")


if __name__ == "__main__":
    main()
