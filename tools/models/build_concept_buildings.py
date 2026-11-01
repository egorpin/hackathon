"""New hand-authored buildings from the supplied white/orange concepts.

Y-up, front +Z. No texture images or UV attributes are emitted.
"""
import math
import struct
from materialize import DIR, append, save

MATERIALS = [
    {'name':'Shell','pbrMetallicRoughness':{'baseColorFactor':[.84,.82,.78,1],'metallicFactor':.08,'roughnessFactor':.82}},
    {'name':'Dark','pbrMetallicRoughness':{'baseColorFactor':[.055,.06,.065,1],'metallicFactor':.15,'roughnessFactor':.72}},
    {'name':'Accent','pbrMetallicRoughness':{'baseColorFactor':[1,.22,.015,1],'metallicFactor':.05,'roughnessFactor':.7}},
]

class Builder:
    def __init__(self,name):
        self.name=name;self.parts=[]

    def add(self,name,vertices,faces,material):
        pos=[];normal=[]
        for face in faces:
            for j in range(1,len(face)-1):
                tri=[vertices[i] for i in (face[0],face[j],face[j+1])]
                a=[tri[1][k]-tri[0][k] for k in range(3)]
                b=[tri[2][k]-tri[0][k] for k in range(3)]
                n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
                length=math.sqrt(sum(v*v for v in n))
                if length<1e-12:continue
                for p in tri:pos.extend(p);normal.extend(v/length for v in n)
        self.parts.append((name,pos,normal,material))

    def box(self,name,c,size,material=0,bevel=.015):
        x,y,z=c;a,b,d=[v/2 for v in size];e=min(bevel,a*.35,b*.35,d*.35)
        ring=[(-a+e,-d),(a-e,-d),(a,-d+e),(a,d-e),(a-e,d),(-a+e,d),(-a,d-e),(-a,-d+e)]
        vertices=[]
        for h,shrink in [(-b,e),(-b+e,0),(b-e,0),(b,e)]:
            for u,v in ring:
                vertices.append((x+u*(a-shrink)/a,y+h,z+v*(d-shrink)/d))
        faces=[tuple(range(8)),tuple(reversed(range(24,32)))]
        for r in range(3):
            for i in range(8):faces.append((r*8+i,(r+1)*8+i,(r+1)*8+(i+1)%8,r*8+(i+1)%8))
        self.add(name,vertices,faces,material)

    def cylinder(self,name,c,r,h,material=0,sides=12,axis='y',bevel=.01):
        vertices=[];e=min(bevel,h*.2,r*.2)
        for height,radius in [(-h/2,r-e),(-h/2+e,r),(h/2-e,r),(h/2,r-e)]:
            for i in range(sides):
                a=2*math.pi*i/sides;p=(radius*math.cos(a),height,radius*math.sin(a))
                if axis=='x':p=(p[1],p[2],p[0])
                if axis=='z':p=(p[2],p[0],p[1])
                vertices.append(tuple(c[k]+p[k] for k in range(3)))
        faces=[tuple(range(sides)),tuple(reversed(range(3*sides,4*sides)))]
        for r in range(3):
            for i in range(sides):faces.append((r*sides+i,(r+1)*sides+i,(r+1)*sides+(i+1)%sides,r*sides+(i+1)%sides))
        self.add(name,vertices,faces,material)

    def export(self):
        g={'asset':{'version':'2.0','generator':'Mars Colony concept geometry'},'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'materials':MATERIALS}
        b=bytearray()
        for name,pos,norm,material in self.parts:
            # Share triangle corners inside each flat face without smoothing
            # away the faceted normals or introducing texture coordinates.
            lookup={};indices=[];unique_pos=[];unique_norm=[]
            for offset in range(0,len(pos),3):
                key=tuple(pos[offset:offset+3]+norm[offset:offset+3])
                if key not in lookup:
                    lookup[key]=len(unique_pos)//3
                    unique_pos.extend(pos[offset:offset+3]);unique_norm.extend(norm[offset:offset+3])
                indices.append(lookup[key])
            pos,norm=unique_pos,unique_norm
            pi=append(g,b,struct.pack('<'+'f'*len(pos),*pos),'VEC3',5126,len(pos)//3)
            g['accessors'][pi].update(min=[min(pos[k::3]) for k in range(3)],max=[max(pos[k::3]) for k in range(3)])
            ni=append(g,b,struct.pack('<'+'f'*len(norm),*norm),'VEC3',5126,len(norm)//3)
            ii=append(g,b,struct.pack('<'+'H'*len(indices),*indices),'SCALAR',5123,len(indices))
            g['scenes'][0]['nodes'].append(len(g['nodes']));g['nodes'].append({'name':name,'mesh':len(g['meshes'])})
            g['meshes'].append({'name':name,'primitives':[{'attributes':{'POSITION':pi,'NORMAL':ni},'indices':ii,'material':material}]})
        save(DIR/(self.name+'.glb'),g,b)
        print(self.name,len(b),'geometry bytes',sum(len(p[1])//9 for p in self.parts),'triangles')

def dome():
    m=Builder('dome_base')
    # Faceted hemispherical shell, with a dark twelve-sided foundation ring.
    m.cylinder('Foundation',(0,-.245,0),.5,.115,1,sides=16)
    v=[];faces=[];sides=16
    for level in range(6):
        angle=level*math.pi/10
        for i in range(sides):
            a=2*math.pi*i/sides
            v.append((.48*math.cos(angle)*math.cos(a),-.195+.52*math.sin(angle),.48*math.cos(angle)*math.sin(a)))
    for r in range(5):
        for i in range(sides):faces.append((r*sides+i,(r+1)*sides+i,(r+1)*sides+(i+1)%sides,r*sides+(i+1)%sides))
    m.add('FacetedDome',v,faces,0)
    m.box('EntryFrame',(0,-.075,.407),(.36,.45,.18),2,.035)
    m.box('DoorSeal',(0,-.08,.505),(.275,.44,.065),1,.025)
    m.box('Door',(0,-.09,.543),(.215,.355,.018),0,.012)
    m.box('DoorHandle',(.075,-.12,.558),(.016,.07,.018),1,.004)
    m.export()

def oxygen():
    m=Builder('oxygen_generator')
    m.box('Housing',(-.12,-.04,0),(.68,.65,.65),0,.045)
    m.box('Foundation',(-.12,-.382,0),(.73,.09,.67),1,.02)
    m.box('ServicePanel',(-.23,-.025,.337),(.24,.31,.035),1,.025)
    m.box('AccentPanel',(.065,-.025,.34),(.15,.43,.045),2,.018)
    m.box('LeftBumper',(-.48,-.04,0),(.055,.56,.51),1,.018)
    m.cylinder('Tank',(.37,-.03,-.035),.125,.62,0,12)
    m.cylinder('TankBand',(.37,-.03,-.035),.128,.125,2,12,bevel=.002)
    m.cylinder('TankFoot',(.37,-.375,-.035),.13,.08,1,12)
    m.cylinder('TankCap',(.37,.30,-.035),.09,.08,1,12)
    m.cylinder('PipeUp',(.37,.365,-.035),.045,.09,1,8)
    m.cylinder('PipeAcross',(.105,.404,-.035),.045,.53,1,8,axis='x')
    m.cylinder('PipeDown',(-.16,.35,-.035),.045,.11,1,8)
    m.box('TopMount',(-.16,.292,-.035),(.24,.025,.22),1,.008)
    m.export()

if __name__=='__main__':
    dome();oxygen()
