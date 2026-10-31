import bpy, math, sys
from mathutils import Vector
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
if len(args)!=2: raise SystemExit('usage: blender -b --python render_glb.py -- input.glb output.png')
source,output=args
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
meshes=[o for o in bpy.context.scene.objects if o.type=='MESH']
if not meshes: raise RuntimeError('GLB contains no mesh objects')
# Use imported world-space bounds and center the camera target on the model.
points=[]
for obj in meshes:
    points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
mins=Vector((min(v[i] for v in points) for i in range(3)))
maxs=Vector((max(v[i] for v in points) for i in range(3)))
center=(mins+maxs)*0.5
radius=max((v-center).length for v in points)
if radius<=0: raise RuntimeError('GLB bounds are degenerate')
scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE_NEXT'
scene.render.resolution_x=1024;scene.render.resolution_y=1024;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG';scene.render.film_transparent=False
scene.render.image_settings.color_mode='RGBA'
scene.view_settings.view_transform='Standard';scene.view_settings.look='Medium High Contrast'
scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(1,1,1,1)
scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value=0.35
# Three soft area lights illuminate the candidate without a floor or other props.
def area(name,loc,power,size):
    data=bpy.data.lights.new(name,'AREA');data.energy=power;data.shape='DISK';data.size=size
    obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj);obj.location=Vector(loc)*radius+center
    obj.rotation_euler=(center-obj.location).to_track_quat('-Z','Y').to_euler()
area('Key',(-3,-4,5),1200,4);area('Fill',(4,-1,2),700,3);area('Rim',(0,4,3),1000,3)
data=bpy.data.cameras.new('PreviewCamera');cam=bpy.data.objects.new('PreviewCamera',data);scene.collection.objects.link(cam)
cam.location=center+Vector((3.2,-4.5,2.8))*radius;cam.rotation_euler=(center-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.type='ORTHO';cam.data.ortho_scale=radius*2.65;scene.camera=cam
scene.render.filepath=output
bpy.ops.render.render(write_still=True)
print('PREVIEW_RENDERED',output,'mesh_objects',len(meshes),'bounds',tuple(mins),tuple(maxs))
