"""Render four separated GLB clips as a 4x4 visual review sheet."""
import bpy
import math
import os
import sys
from mathutils import Vector

tail = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(tail) != 2:
    raise SystemExit("usage: blender -b --python render_clips.py -- rigged.glb output_dir")
source, outdir = tail
os.makedirs(outdir, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
scene = bpy.context.scene
armatures = [o for o in scene.objects if o.type == "ARMATURE"]
if len(armatures) != 1:
    raise RuntimeError(f"Expected one rig, found {len(armatures)}")
arm = armatures[0]
arm.animation_data.action = None
tracks = {t.name.lower(): t for t in arm.animation_data.nla_tracks}
required = ("Idle", "Walk", "Run", "Jump")
if any(name.lower() not in tracks for name in required):
    raise RuntimeError(f"Missing clip tracks: {list(tracks)}")

scene.render.engine = "BLENDER_EEVEE_NEXT"
scene.render.resolution_x = 480
scene.render.resolution_y = 480
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = False
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "Medium High Contrast"
scene.world.use_nodes = True
scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (.92,.92,.92,1)
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = .65

def area(name, loc, power, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.shape, data.size = power, "DISK", size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = (Vector((0,0,.9))-obj.location).to_track_quat("-Z","Y").to_euler()

area("Key", (-3,-4,5), 1100, 4)
area("Fill", (4,-1,2), 650, 3)
area("Rim", (0,4,3), 900, 3)
cam_data = bpy.data.cameras.new("ReviewCamera")
cam = bpy.data.objects.new("ReviewCamera", cam_data)
scene.collection.objects.link(cam)
cam.location = (2.8,-4.2,2.55)
cam.rotation_euler = (Vector((0,0,.9))-cam.location).to_track_quat("-Z","Y").to_euler()
cam.data.type = "ORTHO"
cam.data.ortho_scale = 2.45
scene.camera = cam

for track in arm.animation_data.nla_tracks:
    track.mute = True
for clip in required:
    track = tracks[clip.lower()]
    track.mute = False
    strip = track.strips[0]
    first, last = round(strip.frame_start), round(strip.frame_end)-1
    for idx, fraction in enumerate((0, .25, .5, .75)):
        frame = round(first + (last-first)*fraction)
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        path = os.path.join(outdir, f"{clip.lower()}_{idx+1}_{frame:03d}.png")
        scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        print("RENDERED", clip, frame, path)
    track.mute = True

print("TRACKS", [(t.name, t.mute, t.strips[0].frame_start, t.strips[0].frame_end) for t in arm.animation_data.nla_tracks])
