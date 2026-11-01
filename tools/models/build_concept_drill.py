"""Hand-model the four-legged drill concept with explicit animation pivots."""
import math
import struct
from materialize import append, save, DIR

g={'asset':{'version':'2.0','generator':'Hand-authored concept drill'},'scene':0,
   'scenes':[{'nodes':[0]}], 'nodes':[{'name':'DrillAssembly','children':[]}],
   'meshes':[], 'materials':[
       {'name':name,'pbrMetallicRoughness':{'baseColorFactor':color+[1], 'roughnessFactor':.78,'metallicFactor':.12}}
       for name,color in [('Shell',[.86,.83,.77]),('Dark',[.065,.07,.073]),('Accent',[1,.22,.015])]]}
binary=bytearray()

def mesh(name,faces,parent=0):
    groups={}
    for mat,polygon in faces:
        for i in range(1,len(polygon)-1):
            tri=[polygon[0],polygon[i],polygon[i+1]]
            u=[tri[1][k]-tri[0][k] for k in range(3)];v=[tri[2][k]-tri[0][k] for k in range(3)]
            n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            length=math.sqrt(sum(x*x for x in n))
            if length<1e-9:continue
            pos,norm=groups.setdefault(mat,([],[]))
            for p in tri:pos.extend(p);norm.extend(x/length for x in n)
    primitives=[]
    for mat,(pos,norm) in groups.items():
        p=append(g,binary,struct.pack('<'+'f'*len(pos),*pos),'VEC3',5126,len(pos)//3)
        g['accessors'][p].update(min=[min(pos[i::3]) for i in range(3)],max=[max(pos[i::3]) for i in range(3)])
        n=append(g,binary,struct.pack('<'+'f'*len(norm),*norm),'VEC3',5126,len(norm)//3)
        primitives.append({'attributes':{'POSITION':p,'NORMAL':n},'material':mat})
    node=len(g['nodes']);g['nodes'].append({'name':name,'mesh':len(g['meshes'])})
    g['meshes'].append({'primitives':primitives});g['nodes'][parent].setdefault('children',[]).append(node)

def loft(rings,mat=0,sides=8,phase=math.pi/8,sector=None):
    # Each ring is (y, x radius, z radius, x offset, z offset).
    vertices=[[(x+rx*math.cos(phase+i*2*math.pi/sides),y,z+rz*math.sin(phase+i*2*math.pi/sides)) for i in range(sides)] for y,rx,rz,x,z in rings]
    faces=[(mat,vertices[0]),(mat,list(reversed(vertices[-1])))]
    for a,b in zip(vertices,vertices[1:]):
        for i in range(sides):
            j=(i+1)%sides;faces.append((sector(i) if sector else mat,[a[i],b[i],b[j],a[j]]))
    return faces

def box(center,size,mat):
    x,y,z=center;w,h,d=[s/2 for s in size]
    p=[(x+dx*w,y+dy*h,z+dz*d) for dx,dy,dz in [(-1,-1,-1),(1,-1,-1),(1,-1,1),(-1,-1,1),(-1,1,-1),(1,1,-1),(1,1,1),(-1,1,1)]]
    return [(mat,[p[i] for i in ids]) for ids in [(0,1,2,3),(7,6,5,4),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]]

body=loft([(.58,.49,.40,0,0),(.64,.57,.47,0,0),(.78,.57,.47,0,0)],1)
body+=loft([(.77,.56,.46,0,0),(.99,.39,.34,0,0),(1.06,.29,.27,0,0)],0,sector=lambda i:2 if i in (1,3,5,7) else 0)
body+=box((0,.88,-.39),(.42,.22,.065),2)
body+=loft([(1.04,.28,.27,0,0),(1.1,.28,.27,0,0)],1)
body+=loft([(1.1,.24,.23,0,0),(1.13,.28,.27,0,0),(1.43,.28,.27,0,0),(1.49,.22,.21,0,0)],0,sector=lambda i:2 if i%2==0 else 0)
body+=loft([(1.49,.21,.2,0,0),(1.51,.19,.18,0,0)],2)
body+=loft([(.69,.19,.24,.48,.10),(.74,.23,.28,.48,.10),(1.02,.23,.28,.48,.10),(1.08,.18,.22,.48,.10)],0)
body+=box((.685,.88,.10),(.04,.22,.30),2)
mesh('DrillBody',body)

legs=[]
for x in (-1,1):
    for z in (-1,1):
        # Splayed struts are a sheared rectangular prism between two rings.
        legs+=loft([(.08,.10,.09,x*.70,z*.57),(.75,.10,.09,x*.44,z*.33)],0,4,math.pi/4)
        legs+=box((x*.70,.035,z*.57),(.27,.07,.23),1)
        legs+=box((x*.46,.74,z*.35),(.18,.15,.16),2)
mesh('SupportLegs',legs)
bit=loft([(.43,.16,.16,0,0),(.57,.16,.16,0,0),(.59,.20,.20,0,0)],1)
bit+=loft([(.02,.001,.001,0,0),(.37,.20,.20,0,0),(.43,.12,.12,0,0)],1,6,math.pi/6)
mesh('DrillBit',bit)
save(DIR/'drill.glb',g,binary)
print('Drill:',len(binary),'geometry bytes;',len(g['nodes']),'nodes')
