"""Rig the supplied low-poly astronaut GLB and export glTF animations.

Run with Blender 4.5:
  blender -b --python tools/astronaut/rig_astronaut.py -- input.glb output.glb

The imported glTF is converted by Blender to its Z-up coordinates. This script
normalizes the feet to Z=0 and height to 1.8 units, builds a light skeletal rig,
keeps the original PBR maps/vertex colors, and splits the six arm regions into
separately named skinned mesh nodes for first-person use.
"""
import bpy
import bmesh
import math
import sys
from mathutils import Quaternion, Vector


def args():
    tail = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(tail) != 2:
        raise SystemExit("usage: blender -b --python rig_astronaut.py -- input.glb output.glb")
    return tail


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.actions):
        if block.users == 0:
            bpy.data.actions.remove(block)


def imported_meshes():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def bounds(objects):
    # Read the actual mesh coordinates; Object.bound_box can remain cached after
    # edit-mode/data API vertex changes until Blender evaluates the depsgraph.
    points = [o.matrix_world @ v.co for o in objects for v in o.data.vertices]
    if not points:
        raise RuntimeError("The GLB contains no mesh geometry")
    return (Vector(tuple(min(p[i] for p in points) for i in range(3))),
            Vector(tuple(max(p[i] for p in points) for i in range(3))))


def normalize_mesh(obj, lo, height):
    # Bake imported node transforms and normalize in the coordinate system Blender
    # uses after glTF's Y-up -> Blender Z-up conversion.
    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        v.co = Vector(((p.x - (lo.x + (bounds([obj])[1].x - lo.x) * .5)) / height * 1.8,
                       p.y / height * 1.8,
                       (p.z - lo.z) / height * 1.8))
    obj.matrix_world.identity()
    obj.location = (0, 0, 0)
    obj.rotation_euler = (0, 0, 0)
    obj.scale = (1, 1, 1)
    obj.data.update()


def create_rig(lo, hi):
    center = (lo + hi) * .5
    height = hi.z - lo.z
    width = hi.x - lo.x
    if height < 1e-5 or width < height * .35:
        raise RuntimeError(f"Unexpected model dimensions: width={width:.4f}, height={height:.4f}")
    z = lambda f: lo.z + height * f
    bpy.ops.object.armature_add(enter_editmode=True, location=(0, 0, 0))
    arm = bpy.context.object
    arm.name = "AstronautRig"
    arm.data.name = "AstronautSkeleton"
    eb = arm.data.edit_bones
    eb.remove(eb["Bone"])

    def bone(name, head, tail, parent=None, connected=False):
        b = eb.new(name)
        b.head, b.tail = head, tail
        if parent:
            b.parent = parent
            b.use_connect = connected
        return b

    root = bone("Root", (center.x, center.y, z(.035)), (center.x, center.y, z(.30)))
    spine = bone("Spine", (center.x, center.y, z(.30)), (center.x, center.y, z(.72)), root, True)
    bone("Head", (center.x, center.y, z(.72)), (center.x, center.y, z(.95)), spine, True)
    # Character faces Blender -Y. Subject-left is +X; subject-right is -X.
    shoulder, elbow, wrist, hand_tip = width*.235, width*.355, width*.435, width*.495
    arm_z = z(.665)
    for side, sign in (("Left", 1), ("Right", -1)):
        x = lambda d: center.x + sign*d
        upper = bone(side+"Arm", (x(shoulder),center.y,arm_z), (x(elbow),center.y,arm_z), spine)
        fore = bone(side+"Forearm", (x(elbow),center.y,arm_z), (x(wrist),center.y,arm_z), upper, True)
        bone(side+"Hand", (x(wrist),center.y,arm_z), (x(hand_tip),center.y,arm_z), fore, True)
        hip_x = center.x + sign*width*.105
        thigh = bone(side+"Thigh", (hip_x,center.y,z(.47)), (hip_x,center.y,z(.255)), root)
        shin = bone(side+"Shin", (hip_x,center.y,z(.255)), (hip_x,center.y,z(.075)), thigh, True)
        bone(side+"Foot", (hip_x,center.y,z(.075)), (hip_x,center.y-.12,z(.025)), shin, True)
    bpy.ops.object.mode_set(mode="OBJECT")
    arm.show_in_front = True
    arm.data.display_type = "STICK"
    return arm, (lo, hi, center, width, height)


def make_arm_parts(obj, arm, bounds_data):
    lo, hi, center, width, height = bounds_data
    # Split faces, not texture/material data. Copies retain the source UV, normal,
    # tangent and color attributes; arm submeshes remain a disjoint partition.
    thresholds = (width*.235, width*.355, width*.435)
    buckets = {"Body": []}
    for side in ("Left", "Right"):
        for part in ("Arm", "Forearm", "Hand"):
            buckets[side+part] = []
    for poly in obj.data.polygons:
        pts = [obj.data.vertices[i].co for i in poly.vertices]
        c = sum(pts, Vector()) / len(pts)
        xn, zn = abs(c.x-center.x), (c.z-lo.z)/height
        # The source has a straight T-pose: arm strips lie in the upper half,
        # outside the torso. Keep shoulder caps with the torso for a clean seam.
        if zn > .50 and xn > thresholds[0]:
            side = "Left" if c.x >= center.x else "Right"
            if xn < thresholds[1]: part = "Arm"
            elif xn < thresholds[2]: part = "Forearm"
            else: part = "Hand"
            buckets[side+part].append(poly.index)
        else:
            buckets["Body"].append(poly.index)

    # Keep a pristine source mesh for the arm partition before trimming the body.
    original = obj.data.copy()
    obj.name = "AstronautSuit"
    # Remove the arm faces from the suit body. The six objects below are the
    # disjoint skinned arm partition, so regular and first-person rendering never
    # has coincident duplicate surfaces.
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bm.faces.index_update()
    body_faces = set(buckets["Body"])
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.index not in body_faces], context='FACES')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    made = [obj]
    for name, keep in buckets.items():
        if name == "Body" or not keep:
            continue
        part_obj = bpy.data.objects.new(name, original.copy())
        bpy.context.collection.objects.link(part_obj)
        part_obj.matrix_world = obj.matrix_world.copy()
        bm = bmesh.new()
        bm.from_mesh(part_obj.data)
        keep_set = set(keep)
        bm.faces.ensure_lookup_table()
        bm.faces.index_update()
        faces = list(bm.faces)
        bmesh.ops.delete(bm, geom=[f for i, f in enumerate(faces) if i not in keep_set], context='FACES')
        bm.to_mesh(part_obj.data)
        bm.free()
        part_obj.data.update()
        made.append(part_obj)
    return made


def weighted_groups(obj, arm, bounds_data):
    lo, hi, center, width, height = bounds_data
    names = list(arm.data.bones.keys())
    groups = {n: obj.vertex_groups.new(name=n) for n in names}
    eps = 1e-6

    def blend(a, b, t):
        t = max(0.0, min(1.0, t))
        return a*(1-t) + b*t

    def smooth(a, b, x):
        t = max(0.0, min(1.0, (x-a)/(b-a)))
        return t*t*(3-2*t)

    for v in obj.data.vertices:
        p = obj.matrix_world @ v.co
        zn = (p.z-lo.z)/height
        dx = p.x-center.x
        side = "Left" if dx >= 0 else "Right"
        ax = abs(dx)
        weights = {}
        if zn > .77:
            weights["Head"] = 1.0
        elif zn < .50 and ax > width*.055:
            # Smooth, ordered Root/Thigh -> Shin -> Foot weights across the
            # actual hip/knee/ankle bands; no inverted or empty shin regions.
            if zn > .42:
                t = smooth(.42,.50,zn)
                weights["Root"], weights[side+"Thigh"] = 1-t,t
            elif zn > .27:
                weights[side+"Thigh"] = 1.0
            elif zn > .12:
                weights[side+"Thigh"] = 1-smooth(.25,.30,zn)
                weights[side+"Shin"] = smooth(.25,.30,zn)
            else:
                weights[side+"Shin"] = 1-smooth(.08,.13,zn)
                weights[side+"Foot"] = smooth(.08,.13,zn)
        elif ax > width*.225 and zn > .47:
            # Continuous weights along shoulder -> elbow -> wrist -> mitten.
            u = ax/width
            if u < .38:
                t = smooth(.20,.25,u)
                weights["Spine"], weights[side+"Arm"] = 1-t,t
            elif u < .435:
                t = smooth(.33,.38,u)
                weights[side+"Arm"], weights[side+"Forearm"] = 1-t,t
            elif u < .48:
                t = smooth(.425,.455,u)
                weights[side+"Forearm"], weights[side+"Hand"] = 1-t,t
            else:
                weights[side+"Hand"] = 1.0
        else:
            weights["Spine"] = 1.0
        weights = {n:w for n,w in weights.items() if w > eps}
        total = sum(weights.values()) or 1.0
        for n,w in weights.items():
            groups[n].add([v.index], w/total, "REPLACE")

    mod = obj.modifiers.new("AstronautSkin", "ARMATURE")
    mod.object = arm
    obj.parent = arm
    obj.matrix_parent_inverse = arm.matrix_world.inverted()


def key_pose(pb, frame, rotations=(), location=None):
    if rotations:
        # Convert model-space axes into the bone's local rest basis. Pose Euler
        # axes follow each bone's length and would twist these horizontal T-pose
        # arm bones instead of lowering them at the shoulder.
        parent_rest = pb.parent.bone.matrix_local.to_3x3().to_quaternion() if pb.parent else Quaternion()
        rest_rel = parent_rest.inverted() @ pb.bone.matrix_local.to_3x3().to_quaternion()
        world_q = Quaternion()
        for axis, angle in rotations:
            if abs(angle) > 1e-9:
                world_q = Quaternion(Vector(axis), angle) @ world_q
        pb.rotation_mode = "QUATERNION"
        pb.rotation_quaternion = rest_rel.inverted() @ (parent_rest.inverted() @ world_q @ parent_rest) @ rest_rel
        pb.keyframe_insert(data_path="rotation_quaternion", frame=frame, group=pb.name)
    if location is not None:
        pb.location = location
        pb.keyframe_insert(data_path="location", frame=frame, group=pb.name)


def add_clips(arm):
    specs = (("Idle", 48), ("Walk", 32), ("Run", 24), ("Jump", 40))
    scene = bpy.context.scene
    for name, frames in specs:
        action = bpy.data.actions.new(name)
        arm.animation_data_create()
        arm.animation_data.action = action
        arm.pose.bones["Root"].rotation_mode = "XYZ"
        # Include a repeated final sample for seamless cyclic gait clips.
        sample_frames = sorted(set([1, frames//4+1, frames//2+1, frames*3//4+1, frames+1]))
        for f in sample_frames:
            t = (f-1)/frames * math.tau
            root = arm.pose.bones["Root"]
            spine = arm.pose.bones["Spine"]
            if name == "Jump":
                # A readable crouch, launch, flight, and landing cycle.
                phase = (f-1)/frames
                if phase < .2: bob = -.035*math.sin(math.pi*phase/.2)
                elif phase < .65: bob = .20*math.sin(math.pi*(phase-.2)/.9)
                else: bob = .035*math.sin(math.pi*(phase-.65)/.35)
            elif name == "Idle":
                bob = .004*math.sin(t)
            else:
                bob = (.018 if name == "Walk" else .035)*math.sin(t*2)
            key_pose(root, f, location=(0,0,bob))
            for side, sign in (("Left",1), ("Right",-1)):
                # Rest T-pose shoulder rotation is ~+/-80 degrees around local Y.
                # Positive X is character-left; mirrored signs lower both arms.
                walk = (0.12 if name == "Walk" else 0.24 if name == "Run" else 0.0)*math.sin(t)*sign
                arm_drop = 1.32 + walk
                if name == "Jump":
                    phase = (f-1)/frames
                    arm_drop = 1.15 - .7*math.sin(math.pi*phase)
                elbow = .18 + (.12*math.sin(t+math.pi) if name in ("Walk","Run") else 0)
                if name == "Jump": elbow = -.35
                key_pose(arm.pose.bones[side+"Arm"], f, [((0,1,0),sign*arm_drop),((1,0,0),walk*.65)])
                key_pose(arm.pose.bones[side+"Forearm"], f, [((0,1,0),sign*elbow)])
                key_pose(arm.pose.bones[side+"Hand"], f)
                stride = 0.0 if name == "Idle" else (.42 if name == "Walk" else .65 if name == "Run" else .10)
                leg = arm.pose.bones[side+"Thigh"]
                shin = arm.pose.bones[side+"Shin"]
                foot = arm.pose.bones[side+"Foot"]
                thigh_angle = stride*math.sin(t+ (math.pi if sign < 0 else 0))
                knee_angle = max(0, -math.sin(t+(math.pi if sign < 0 else 0)))*stride*.7
                if name == "Jump":
                    phase=(f-1)/frames
                    thigh_angle = -.20 if phase < .2 else .22*math.sin(math.pi*phase)
                    knee_angle = .35 if phase < .2 or phase > .8 else .6
                key_pose(leg,f,[((1,0,0),thigh_angle)])
                key_pose(shin,f,[((1,0,0),knee_angle)])
                key_pose(foot,f,[((1,0,0),-knee_angle*.35)])
            torso_y = .02*math.sin(t) if name in ("Walk","Run") else 0
            key_pose(spine, f, [((0,0,1),torso_y)])
        action.use_fake_user = True
        for curve in action.fcurves:
            for key in curve.keyframe_points:
                key.interpolation = "BEZIER"
        if name in ("Walk","Run","Idle"):
            for curve in action.fcurves:
                curve.modifiers.new("CYCLES")
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.action_frame_start = 1
        strip.action_frame_end = frames+1
        strip.extrapolation = "NOTHING"
        arm.animation_data.action = None
    scene.frame_start, scene.frame_end = 1, 49


def main():
    source, target = args()
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = imported_meshes()
    lo, hi = bounds(meshes)
    h = hi.z-lo.z
    if h <= 1e-5:
        raise RuntimeError(f"Source does not appear upright in Blender Z-up coordinates: bounds {lo}, {hi}")
    center_x = (lo.x+hi.x)*.5
    # Transform each imported mesh to one common model space: centered, feet at 0,
    # height 1.8. Preserve the source's -Y facing direction (glTF front +Z).
    for obj in meshes:
        for v in obj.data.vertices:
            p = obj.matrix_world @ v.co
            v.co = Vector(((p.x-center_x)/h*1.8, p.y/h*1.8, (p.z-lo.z)/h*1.8))
        obj.matrix_world.identity()
        obj.data.update()
    all_mesh = meshes[0]
    for extra in meshes[1:]:
        # Current source is a single mesh; fail rather than silently lose content
        # if a later source contains multiple pieces that need distinct handling.
        raise RuntimeError(f"Expected one imported mesh, found {len(meshes)}")
    for mat in all_mesh.data.materials:
        if mat:
            mat.name = "AstronautSuit" if mat.name == "BakeLow_Export_Mat" else "AstronautSuit_"+mat.name
    all_mesh.data.name = "AstronautSuitMesh"
    lo, hi = bounds(meshes)
    arm, rig_bounds = create_rig(lo, hi)
    parts = make_arm_parts(all_mesh, arm, rig_bounds)
    for obj in parts:
        weighted_groups(obj, arm, rig_bounds)
    add_clips(arm)
    # Export the complete partitioned astronaut and its four NLA animation clips.
    bpy.ops.object.select_all(action="DESELECT")
    for obj in parts:
        obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.export_scene.gltf(filepath=target, export_format="GLB", use_selection=True,
                              export_animations=True, export_nla_strips=True,
                              export_current_frame=False, export_apply=True,
                              export_skins=True, export_yup=True)
    print("EXPORTED", target)
    print("MESHES", [(o.name, len(o.data.vertices), len(o.data.polygons)) for o in parts])
    print("BONES", [b.name for b in arm.data.bones])
    print("CLIPS", ["Idle", "Walk", "Run", "Jump"])
    print("BLENDER_BOUNDS", tuple(lo), tuple(hi), "height", hi.z-lo.z)


if __name__ == "__main__":
    main()
