"""Blender: source.glb landmarks.json output.glb. User landmarks are authoritative."""
import bpy
import bmesh
import json
import math
import sys
from mathutils import Vector, Quaternion

source, landmark_file, output = sys.argv[sys.argv.index('--')+1:]
raw = json.load(open(landmark_file, encoding='utf-8'))['points']
# User labels are authoritative. Geometric signs never rename their joints.
def point(name):
    p = raw[name]
    assert p['front'] and p['side'], name
    return Vector((p['x'], -p['z'], p['y']))

def side_at(x):
    return min(('Left','Right'), key=lambda side:abs(x-point(side+'Shoulder').x))

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=source)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
assert len(meshes) == 1
body = meshes[0]
coords = [body.matrix_world @ v.co for v in body.data.vertices]
lo = Vector(tuple(min(p[i] for p in coords) for i in range(3)))
hi = Vector(tuple(max(p[i] for p in coords) for i in range(3)))
factor = 1.8 / (hi.z-lo.z)
for v, p in zip(body.data.vertices, coords):
    v.co = Vector(((p.x-(lo.x+hi.x)/2)*factor, p.y*factor, (p.z-lo.z)*factor))
body.matrix_world.identity()
body.data.update()
for material in body.data.materials:
    material.name = 'AstronautSuit'

bpy.ops.object.armature_add(enter_editmode=True, location=(0,0,0))
rig = bpy.context.object
rig.name = 'AstronautRig'
eb = rig.data.edit_bones
eb.remove(eb['Bone'])
def bone(name, start, end, parent=None):
    b = eb.new(name)
    b.head, b.tail = start, end
    if parent: b.parent = eb[parent]
    return b
bone('Root', point('Hips'), point('Spine'))
bone('Spine', point('Spine'), point('Neck'), 'Root')
bone('Neck', point('Neck'), point('Head'), 'Spine')
bone('Head', point('Head'), point('Head')+Vector((0,0,.22)), 'Neck')
for side in ('Left','Right'):
    shoulder, elbow, wrist = [point(side+n) for n in ('Shoulder','Elbow','Wrist')]
    hand_tip = wrist+(wrist-elbow).normalized()*.12
    bone(side+'Arm', shoulder, elbow, 'Spine')
    bone(side+'Forearm', elbow, wrist, side+'Arm')
    bone(side+'Hand', wrist, hand_tip, side+'Forearm')
    hip, knee, ankle = [point(side+n) for n in ('Hip','Knee','Ankle')]
    bone(side+'Thigh', hip, knee, 'Root')
    bone(side+'Shin', knee, ankle, side+'Thigh')
    bone(side+'Foot', ankle, ankle+Vector((0,-.15,-.06)), side+'Shin')
bpy.ops.object.mode_set(mode='OBJECT')
rig.show_in_front = True

def smooth(a,b,x):
    t=max(0.,min(1.,(x-a)/(b-a)))
    return t*t*(3-2*t)
def weights(p):
    side=side_at(p.x)
    shoulder,elbow,wrist=[point(side+n) for n in ('Shoulder','Elbow','Wrist')]
    ax=abs(p.x)
    if ax>abs(shoulder.x)-.07 and p.z>shoulder.z-.22 and p.z<point('Neck').z+.12:
        arm=smooth(abs(shoulder.x)-.07,abs(shoulder.x)+.055,ax)
        fore=smooth(abs(elbow.x)-.045,abs(elbow.x)+.045,ax)
        hand=smooth(abs(wrist.x)-.035,abs(wrist.x)+.035,ax)
        return {'Spine':1-arm,side+'Arm':arm*(1-fore),side+'Forearm':arm*fore*(1-hand),side+'Hand':arm*fore*hand}
    hip,knee,ankle=[point(side+n) for n in ('Hip','Knee','Ankle')]
    if p.z<hip.z+.065:
        thigh=1-smooth(hip.z-.055,hip.z+.065,p.z)
        shin=1-smooth(knee.z-.045,knee.z+.045,p.z)
        foot=1-smooth(ankle.z-.04,ankle.z+.04,p.z)
        return {'Root':1-thigh,side+'Thigh':thigh*(1-shin),side+'Shin':thigh*shin*(1-foot),side+'Foot':thigh*shin*foot}
    if p.z>point('Neck').z-.025:
        head=smooth(point('Neck').z-.025,point('Neck').z+.06,p.z)
        return {'Spine':1-head,'Neck':head}
    chest=smooth(point('Hips').z+.08,point('Spine').z-.04,p.z)
    return {'Root':1-chest,'Spine':chest}

# Assign identical weights before splitting so seam vertices deform identically.
groups={b.name:body.vertex_groups.new(name=b.name) for b in rig.data.bones}
for vertex in body.data.vertices:
    values={n:w for n,w in weights(vertex.co).items() if w>1e-8}
    total=sum(values.values())
    assert total>0
    for name,value in values.items():groups[name].add([vertex.index],value/total,'REPLACE')

parts=[]
for name in ('Body','LeftArmMesh','RightArmMesh'):
    obj=body.copy();obj.data=body.data.copy();obj.name='AstronautSuit' if name=='Body' else name
    bpy.context.collection.objects.link(obj)
    bm=bmesh.new();bm.from_mesh(obj.data)
    remove=[]
    for face in bm.faces:
        p=face.calc_center_median();side=side_at(p.x);s=point(side+'Shoulder')
        arm_face=abs(p.x)>abs(s.x)+.015 and s.z-.22<p.z<point('Neck').z+.12
        target=side+'ArmMesh' if arm_face else 'Body'
        if target!=name:remove.append(face)
    bmesh.ops.delete(bm,geom=remove,context='FACES');bm.to_mesh(obj.data);bm.free()
    obj.parent=rig
    mod=obj.modifiers.new('Skin','ARMATURE');mod.object=rig
    parts.append(obj)
bpy.data.objects.remove(body,do_unlink=True)
assert sum(len(p.data.polygons) for p in parts)==1000

def pose(name,frame,rotations=(),translation=None):
    pb=rig.pose.bones[name]
    rest=pb.bone.matrix_local.to_quaternion()
    q=Quaternion()
    for axis,angle in rotations:q=Quaternion(axis,angle)@q
    pb.rotation_mode='QUATERNION';pb.rotation_quaternion=rest.inverted()@q@rest
    pb.keyframe_insert('rotation_quaternion',frame=frame,group=name)
    if translation is not None:
        pb.location=rest.inverted()@Vector(translation)
        pb.keyframe_insert('location',frame=frame,group=name)

bpy.context.scene.render.fps=30
for name,frames in [('Idle',60),('Walk',32),('Run',24),('Jump',40)]:
    rig.animation_data_create();action=bpy.data.actions.new(name);rig.animation_data.action=action
    # Dense keys avoid spline overshoot at the fully tucked jump pose.
    for f in range(frames+1):
        phase=f/frames;t=phase*math.tau
        tuck=smooth(.08,.38,phase)*(1-smooth(.68,.94,phase)) if name=='Jump' else 0
        bob=.003*math.sin(t) if name=='Idle' else 0
        pose('Root',f+1,translation=(0,0,bob)) # server owns jump altitude
        pose('Spine',f+1,[((1,0,0),-.09*tuck)])
        pose('Neck',f+1);pose('Head',f+1)
        for side in ('Left','Right'):
            sign=1 if point(side+'Shoulder').x>0 else -1
            stride=(.36 if name=='Walk' else .58 if name=='Run' else 0)*math.sin(t)*sign
            # User-confirmed front is glTF -Z (Blender +Y).
            thigh=2.1*tuck+stride
            knee=-(math.pi/2)*tuck+max(0,-math.sin(t)*sign)*(.55 if name=='Run' else .32 if name=='Walk' else 0)
            pose(side+'Thigh',f+1,[((1,0,0),thigh)])
            pose(side+'Shin',f+1,[((1,0,0),knee)])
            pose(side+'Foot',f+1,[((1,0,0),.25*tuck)])
            drop=1.34-.35*tuck
            swing=-stride*.65
            pose(side+'Arm',f+1,[((0,1,0),sign*drop),((1,0,0),swing)])
            # Bending toward the model's front uses a mirrored Z rotation in rest space.
            pose(side+'Forearm',f+1,[((0,0,1),-sign*(.12+.65*tuck))])
            pose(side+'Hand',f+1)
    for fc in action.fcurves:
        for key in fc.keyframe_points:key.interpolation='LINEAR'
    track=rig.animation_data.nla_tracks.new();track.name=name
    strip=track.strips.new(name,1,action);strip.extrapolation='NOTHING'
    rig.animation_data.action=None

bpy.ops.object.select_all(action='DESELECT')
for obj in parts:obj.select_set(True)
rig.select_set(True);bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=output,export_format='GLB',use_selection=True,export_animations=True,
                          export_nla_strips=True,export_skins=True,export_yup=True)
# Retain the editable rig and landmarks for future corrections.
bpy.ops.wm.save_as_mainfile(filepath=output.replace('.glb','.blend'))
print('LANDMARK_RIG',len(rig.data.bones),'bones',sum(len(p.data.polygons) for p in parts),'faces',output)

