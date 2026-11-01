"""Reference-inspired four-wheel rover, without manipulator."""
import struct, math
from build_energy_v2 import Model
from materialize import DIR, COLORS, append, save
m=Model('Rover')
m.box('Chassis',(0,0,.62),(1.35,1.55,.5),'Shell')
m.box('Lower',(0,0,.35),(1.05,1.25,.25),'Dark')
m.box('AccentPlate',(0,0,.9),(.7,.6,.08),'Accent')
m.box('CameraMast',(0,0,1.23),(.16,.18,.65),'Dark')
m.box('Camera',(0,-.03,1.64),(.82,.36,.34),'Shell')
for x in (-.43,.43):m.box('CameraCap',(x,-.03,1.64),(.06,.32,.24),'Accent')
for x in (-.21,.21):m.cylinder('Lens',(x,-.24,1.64),.13,.1,axis='y',material='Dark')
wheel_groups=[]
for x in (-.78,.78):
    for y in (-.53,.53):
        m.box('Suspension',(x*.8,y,.48),(.35,.16,.24),'Dark')
        start=len(m.faces)
        m.cylinder('Wheel',(x,y,.32),.32,.25,axis='x',material='Dark',sides=12)
        m.cylinder('Hub',(x+math.copysign(.14,x),y,.32),.14,.04,axis='x',material='Accent',sides=12)
        wheel_groups.append((start,len(m.faces),(x,.32,-y)))
g={'asset':{'version':'2.0'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'name':'RoverNoArm','children':[1,2,3,4,5]}],'meshes':[], 'materials':[{'name':n,'doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':[*c,1],'roughnessFactor':.8,'metallicFactor':.1}} for n,c in COLORS]}
b=bytearray()
wheel_faces={i for start,end,_ in wheel_groups for i in range(start,end)}
groups=[('Chassis',(0,0,0),[f for i,f in enumerate(m.faces) if i not in wheel_faces])]
groups += [(f'Wheel_{i}',center,m.faces[start:end]) for i,(start,end,center) in enumerate(wheel_groups)]
for part,center,faces in groups:
 g['nodes'].append({'name':part,'mesh':len(g['meshes']),'translation':list(center)})
 g['meshes'].append({'primitives':[]})
 for mi,(name,_) in enumerate(COLORS):
    pos=[];norm=[]
    for mat,face in faces:
        if mat!=name:continue
        for j in range(1,len(face)-1):
            tri=[m.vertices[i-1] for i in (face[0],face[j],face[j+1])]
            tri=[(x-center[0],z-center[1],-y-center[2]) for x,y,z in tri]
            a=[tri[1][k]-tri[0][k] for k in range(3)];c=[tri[2][k]-tri[0][k] for k in range(3)]
            n=[a[1]*c[2]-a[2]*c[1],a[2]*c[0]-a[0]*c[2],a[0]*c[1]-a[1]*c[0]];length=math.sqrt(sum(v*v for v in n)) or 1
            for p in tri:pos.extend(p);norm.extend(v/length for v in n)
    if not pos:continue
    pi=append(g,b,struct.pack('<'+'f'*len(pos),*pos),'VEC3',5126,len(pos)//3)
    g['accessors'][pi].update(min=[min(pos[k::3]) for k in range(3)],max=[max(pos[k::3]) for k in range(3)])
    ni=append(g,b,struct.pack('<'+'f'*len(norm),*norm),'VEC3',5126,len(norm)//3)
    g['meshes'][-1]['primitives'].append({'attributes':{'POSITION':pi,'NORMAL':ni},'material':mi})
save(DIR/'rover.glb',g,b)
print('Rover without arm:',(DIR/'rover.glb').stat().st_size)
