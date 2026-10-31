"""Prepare an imported astronaut GLB as a simple animated Blender asset.

Run with Blender's bundled Python, for example:
  blender -b --python rig_astronaut.py -- input.glb output.glb

This is intentionally a bounded first pass. Region cuts are based on normalized
bounding-box coordinates and must be visually reviewed on the generated mesh.
It does not fabricate an output if the mesh/region checks fail.
"""
import bpy
import math
import sys
from mathutils import Vector


def args():
    tail = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(tail) != 2:
        raise SystemExit("usage: blender -b --python rig_astronaut.py -- input.glb output.glb")
    return tail


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def world_bounds(objects):
    pts = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    if not pts:
        raise RuntimeError("Input GLB has no mesh geometry")
    return (Vector(tuple(min(p[i] for p in pts) for i in range(3))),
            Vector(tuple(max(p[i] for p in pts) for i in range(3))))


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.actions,):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)


def create_rig(lo, hi):
    center = (lo + hi) * 0.5
    h = hi.y - lo.y
    if h <= 1e-5:
        raise RuntimeError("Degenerate astronaut height")
    # Fractions from bottom; proportions are only used to seed joint positions.
    y = lambda f: lo.y + h * f
    bpy.ops.object.armature_add(enter_editmode=True, location=center)
    arm = bpy.context.object
    arm.name = "AstronautRig"
    arm.data.name = "AstronautSkeleton"
    eb = arm.data.edit_bones
    root = eb["Bone"]
    root.name = "Root"
    root.head = (center.x, y(0.04), center.z)
    root.tail = (center.x, y(0.30), center.z)

    def bone(name, head, tail, parent, connected=False):
        b = eb.new(name)
        b.head, b.tail = head, tail
        b.parent, b.use_connect = parent, connected
        return b

    spine = bone("Spine", (center.x,y(.30),center.z), (center.x,y(.70),center.z), root)
    head = bone("Head", (center.x,y(.70),center.z), (center.x,y(.94),center.z), spine)
    width = hi.x - lo.x
    if width < h * .2:
        raise RuntimeError("Input proportions are too narrow for automatic arm segmentation")
    shoulder = max(width * .22, h * .10)
    elbow = max(width * .34, shoulder * 1.45)
    wrist = max(width * .43, elbow * 1.28)
    extent = max(width * .50, wrist * 1.15)
    arm_y = y(.66)
    for side, sign in (("Left",1), ("Right",-1)):
        x = lambda d: center.x + sign*d
        upper = bone(side+"Arm", (x(shoulder),arm_y,center.z), (x(elbow),arm_y,center.z), spine)
        fore = bone(side+"Forearm", (x(elbow),arm_y,center.z), (x(wrist),arm_y,center.z), upper, True)
        bone(side+"Hand", (x(wrist),arm_y,center.z), (x(extent),arm_y,center.z), fore, True)
        hip_x = center.x + sign * width * .12
        leg = bone(side+"Thigh", (hip_x,y(.43),center.z), (hip_x,y(.24),center.z), root)
        shin = bone(side+"Shin", (hip_x,y(.24),center.z), (hip_x,y(.08),center.z), leg, True)
        bone(side+"Foot", (hip_x,y(.08),center.z), (hip_x,y(.04),center.z-h*.07), shin, True)
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.show_in_front = True
    arm.data.display_type = "STICK"
    return arm, (lo, hi, center, h, shoulder, elbow, wrist)


def region_weights(obj, arm, bounds):
    lo, hi, c, h, shoulder, elbow, wrist = bounds
    w, d = hi.x-lo.x, hi.z-lo.z
    verts = obj.data.vertices
    groups = {n: obj.vertex_groups.new(name=n) for n in arm.data.bones.keys()}
    # Work in mesh-local coordinates. Imported GLB objects generally have identity
    # transforms after applying their node transforms, but world transform is used.
    coords = [obj.matrix_world @ v.co for v in verts]
    half = max(w/2, 1e-6)
    for v, p in zip(verts, coords):
        yn = (p.y-lo.y)/h
        xn = abs(p.x-c.x)/half
        side = "Left" if p.x >= c.x else "Right"
        # Astronaut-facing side is +Z, per this pipeline's Three.js convention.
        # Y bands reserve helmet, torso, legs and boots; X bands split glove/forearm.
        if yn >= .75:
            targets = [("Head",1.0)]
        elif yn >= .42 and xn < .26:
            targets = [("Spine",1.0)]
        elif yn < .42 and xn < .20:
            targets = [("Root",1.0)]
        elif yn < .12 and xn < .38:
            targets = [(side+"Foot",1.0)]
        elif yn < .43 and xn < .38:
            targets = [(side+("Thigh" if yn > .25 else "Shin"),1.0)]
        elif xn >= .22 and yn >= .43:
            if xn >= .84:
                targets = [(side+"Hand",1.0)]
            elif xn >= .62:
                targets = [(side+"Forearm",1.0)]
            else:
                targets = [(side+"Arm",1.0)]
        else:
            targets = [("Spine",1.0)]
        for name, weight in targets:
            groups[name].add([v.index], weight, "REPLACE")
    # Keep distinct named mesh nodes for first-person hand/arm extraction. Each
    # node retains original materials; only faces are assigned by centroid region.
    # Vertex groups above drive animation on the complete source mesh.
    return groups


def add_clips(arm, bounds):
    _, _, center, h, _, _, _ = bounds
    root = arm.pose.bones["Root"]
    spine = arm.pose.bones["Spine"]
    limbs = [arm.pose.bones[n] for n in arm.pose.bones.keys() if n.endswith(("Arm","Forearm","Hand","Thigh","Shin","Foot"))]
    specs = {
        "Idle": (24, 0.0, 0.0),
        "Walk": (24, 0.055, 0.10),
        "Run": (18, 0.11, 0.20),
        "Jump": (24, 0.18, 0.0),
    }
    for name, (frames, stride, bob) in specs.items():
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True); bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode="POSE")
        for pb in arm.pose.bones:
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = (0,0,0); pb.location = (0,0,0)
        for f in (1, frames//2+1, frames+1):
            t = (f-1)/frames * math.tau
            root.location.y = (bob * (1-math.cos(t)) * .5) if name == "Jump" else (bob * math.sin(t*2) if name in ("Walk","Run") else .008*math.sin(t))
            root.keyframe_insert(data_path="location", frame=f, group="Root")
            for pb in limbs:
                side = 1 if pb.name.startswith("Left") else -1
                amp = stride if pb.name.endswith(("Thigh","Arm")) else stride*.48
                phase = t if pb.name.endswith(("Thigh","Shin","Foot")) else t+math.pi
                angle = amp * math.sin(phase) * side
                if name == "Jump":
                    angle *= math.cos(t)
                pb.rotation_euler.x = angle
                pb.keyframe_insert(data_path="rotation_euler", frame=f, group=pb.name)
            spine.rotation_euler.z = .025*math.sin(t) if name in ("Walk","Run") else 0
            spine.keyframe_insert(data_path="rotation_euler", frame=f, group="Spine")
        bpy.ops.object.mode_set(mode="OBJECT")
        action = arm.animation_data.action
        action.name = name
        action.use_fake_user = True
        for fc in action.fcurves:
            for key in fc.keyframe_points:
                key.interpolation = "BEZIER"
        # GLTF exporter exports one active action per animation; preserve all as NLA.
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 1, action)
        arm.animation_data.action = None
    bpy.context.scene.frame_end = 24


def main():
    source, target = args()
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = mesh_objects()
    if not meshes:
        raise RuntimeError("Imported GLB contained no meshes")
    lo, hi = world_bounds(meshes)
    # Normalize to feet Y=0 and unit height; runtime currently owns 2/3 scaling.
    height = hi.y-lo.y
    if height <= 1e-5:
        raise RuntimeError("Imported mesh has zero height")
    for obj in meshes:
        obj.location.y -= lo.y
        obj.scale /= height
        obj.location /= height
        obj.name = "AstronautBody" if len(meshes)==1 else "AstronautPart_"+obj.name
        for poly in obj.data.polygons:
            poly.use_smooth = False
    lo, hi = world_bounds(meshes)
    arm, bounds = create_rig(lo, hi)
    for obj in meshes:
        region_weights(obj, arm, bounds)
        mod = obj.modifiers.new("AstronautSkin", "ARMATURE")
        mod.object = arm
        obj.parent = arm
        obj.matrix_parent_inverse = arm.matrix_world.inverted()
    add_clips(arm, bounds)
    # Scene coordinates: feet at Y=0, upright Y, character front +Z.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes: obj.select_set(True)
    arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=target, export_format="GLB", use_selection=True,
                              export_animations=True, export_nla_strips=True,
                              export_current_frame=False, export_apply=True)
    print("EXPORTED", target, "height=1u; animations=Idle,Walk,Run,Jump")
    print("REVIEW REQUIRED: inspect source proportions, weights, hand nodes, and animation deformation")


if __name__ == "__main__":
    main()
