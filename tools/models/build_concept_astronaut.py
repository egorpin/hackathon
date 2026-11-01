"""New hand-authored faceted suit, retaining the game's skeleton and clips.

Requires numpy and Pillow (materialize helper). Original rig is read from git,
so rebuilding does not repeatedly transform the generated asset.
"""
import json, math, struct, subprocess
from pathlib import Path
import numpy as np
from materialize import DIR, COLORS, accessor, append, save

source = subprocess.check_output(['git', 'show', '5b9570b:client/public/assets/models/astronaut.glb'])
n = struct.unpack_from('<I', source, 12)[0]
g = json.loads(source[20:20+n]); oldbin = bytearray(source[28+n:])
skin = g['skins'][0]
names = {g['nodes'][node]['name']:i for i,node in enumerate(skin['joints'])}
rest = {g['nodes'][node]['name']:np.linalg.inv(np.array(mat).reshape(4,4).T)[:3,3]
        for node,mat in zip(skin['joints'],accessor(g,oldbin,skin['inverseBindMatrices']))}

# Retain only skeleton and animation buffers from the prior asset.
live = {skin['inverseBindMatrices']}
for clip in g['animations']:
    for s in clip['samplers']: live.update((s['input'],s['output']))
b=bytearray(); oldacc=g['accessors']; oldviews=g['bufferViews']; mapping={}
g['accessors']=[];g['bufferViews']=[]
for i in sorted(live):
    a=oldacc[i].copy();v=oldviews[a['bufferView']].copy();start=v.get('byteOffset',0)
    b.extend(b'\0'*((-len(b))%4));v['byteOffset']=len(b);b.extend(oldbin[start:start+v['byteLength']])
    a['bufferView']=len(g['bufferViews']);g['bufferViews'].append(v);mapping[i]=len(g['accessors']);g['accessors'].append(a)
skin['inverseBindMatrices']=mapping[skin['inverseBindMatrices']]
for clip in g['animations']:
    for s in clip['samplers']:
        for key in ('input','output'):s[key]=mapping[s[key]]
for key in ('textures','images','samplers'):g.pop(key,None)
g['materials']=[{'name':name,'doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':[*color,1],
                 'metallicFactor':.08,'roughnessFactor':.78}} for name,color in COLORS[:3]]
g['meshes']=[{'name':name,'primitives':[]} for name in ('AstronautSuit','LeftArmMesh','RightArmMesh')]
parts={}

def triangle(points, mat, bone, mesh=0):
    a,c,d=[np.asarray(p,dtype=float) for p in points]
    normal=np.cross(c-a,d-a);length=np.linalg.norm(normal)
    if length<1e-10:return
    normal/=length
    group=parts.setdefault((mesh,mat), {'p':[],'n':[],'j':[],'w':[]})
    for p in (a,c,d):
        group['p'].extend(p);group['n'].extend(normal)
        group['j'].extend([names[bone],0,0,0]);group['w'].extend([1,0,0,0])

def sphere(center, scale, mat, bone, mesh=0, rings=6, segments=12):
    center=np.array(center);scale=np.array(scale)
    def p(i,j):
        lat=math.pi*i/rings;lon=2*math.pi*j/segments
        return center+scale*np.array([math.sin(lat)*math.cos(lon),math.cos(lat),math.sin(lat)*math.sin(lon)])
    for i in range(rings):
        for j in range(segments):
            a,c,d,e=p(i,j),p(i+1,j),p(i+1,j+1),p(i,j+1)
            triangle((a,c,d),mat,bone,mesh);triangle((a,d,e),mat,bone,mesh)

def tube(start,end,radius,mat,bone,mesh=0, end_radius=None):
    start=np.array(start);end=np.array(end);axis=end-start;axis/=np.linalg.norm(axis)
    ref=np.array([0,0,1.]);u=np.cross(axis,ref);u/=np.linalg.norm(u);v=np.cross(axis,u)
    rings=[]
    for t,r in [(0,radius*.8),(.13,radius),(.87,end_radius or radius),(1,(end_radius or radius)*.8)]:
        rings.append([start+(end-start)*t+(u*math.cos(j*math.pi/4)+v*math.sin(j*math.pi/4))*r for j in range(8)])
    for i in range(3):
        for j in range(8):
            k=(j+1)%8;triangle((rings[i][j],rings[i+1][j],rings[i+1][k]),mat,bone,mesh);triangle((rings[i][j],rings[i+1][k],rings[i][k]),mat,bone,mesh)
    for j in range(8):
        triangle((start,rings[0][(j+1)%8],rings[0][j]),mat,bone,mesh)
        triangle((end,rings[-1][j],rings[-1][(j+1)%8]),mat,bone,mesh)

def box(center,size,mat,bone,mesh=0):
    # Beveled silhouette from eight-sided rings, aligned vertically.
    x,y,z=center;w,h,d=np.array(size)/2;bevel=min(w,d)*.24
    ring=[(-w+bevel,-d),(w-bevel,-d),(w,-d+bevel),(w,d-bevel),(w-bevel,d),(-w+bevel,d),(-w,d-bevel),(-w,-d+bevel)]
    levels=[[(x+a*f,y+t,z+c*f) for a,c in ring] for t,f in [(-h,.85),(-h*.75,1),(h*.75,1),(h,.85)]]
    for i in range(3):
        for j in range(8):
            k=(j+1)%8;triangle((levels[i][j],levels[i][k],levels[i+1][k]),mat,bone,mesh);triangle((levels[i][j],levels[i+1][k],levels[i+1][j]),mat,bone,mesh)
    for j in range(1,7):triangle((levels[0][0],levels[0][j+1],levels[0][j]),mat,bone,mesh);triangle((levels[-1][0],levels[-1][j],levels[-1][j+1]),mat,bone,mesh)

# White rounded pressure suit, dark life-support backpack and flat orange panels.
sphere((0,1.0,0),(.285,.30,.195),0,'Spine',rings=5)
sphere((0,.79,0),(.235,.18,.18),0,'Root',rings=4)
box((0,1.035,-.21),(.51,.48,.15),1,'Spine')
box((0,1.09,.192),(.22,.185,.035),2,'Spine')
sphere((0,1.49,0),(.315,.33,.28),0,'Head')
# Flattened dark visor shell in front of white helmet rim.
sphere((0,1.50,.207),(.263,.266,.105),1,'Head',rings=6)
for sign in (-1,1):box((sign*.306,1.49,0),(.045,.15,.17),2,'Head')

for mesh,side in enumerate(('Left','Right'),1):
    shoulder,elbow,wrist=[rest[side+n] for n in ('Arm','Forearm','Hand')]
    tube(shoulder,elbow,.105,0,side+'Arm',mesh,end_radius=.09)
    tube(elbow,wrist,.093,0,side+'Forearm',mesh,end_radius=.08)
    a=elbow+(wrist-elbow)*.48;c=elbow+(wrist-elbow)*.78
    tube(a,c,.096,2,side+'Forearm',mesh)
    direction=(wrist-elbow)/np.linalg.norm(wrist-elbow)
    sphere(wrist+direction*.075,(.12,.085,.085),1,side+'Hand',mesh,rings=4,segments=8)
    hip,knee,ankle=[rest[side+n] for n in ('Thigh','Shin','Foot')]
    tube(hip,knee,.13,0,side+'Thigh',end_radius=.115)
    tube(knee,ankle,.115,0,side+'Shin',end_radius=.1)
    box(knee+np.array([0,-.005,.11]),(.18,.16,.045),2,side+'Shin')
    box((ankle[0],.095,ankle[2]+.06),(.23,.18,.34),1,side+'Foot')

for (mesh,mat),data in parts.items():
    attrs={};count=len(data['p'])//3
    for key,field,typ,fmt,comp in [('POSITION','p','VEC3','f',5126),('NORMAL','n','VEC3','f',5126),('JOINTS_0','j','VEC4','H',5123),('WEIGHTS_0','w','VEC4','f',5126)]:
        vals=data[field];idx=append(g,b,struct.pack('<'+fmt*len(vals),*vals),typ,comp,count);attrs[key]=idx
        if key=='POSITION':g['accessors'][idx].update(min=[min(vals[k::3]) for k in range(3)],max=[max(vals[k::3]) for k in range(3)])
    g['meshes'][mesh]['primitives'].append({'attributes':attrs,'material':mat})
save(DIR/'astronaut.glb',g,b)
print('New astronaut:',len(b),'buffer bytes;',sum(len(p['p'])//9 for p in parts.values()),'triangles; clips:',[a['name'] for a in g['animations']])
