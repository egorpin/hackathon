"""Hand-built chamfered low-poly props, Z up, front -Y."""
import math
import json
from pathlib import Path
import build_simple_energy_models as base

base.OUT = base.ROOT / 'assets/models/energy-v2'
Old = base.Obj

class Model(Old):
    def box(self, name, center, size, material='white'):
        x,y,z=center
        a,b,c=[v/2 for v in size]
        bevel=min(a,b,c)*.24
        ring=[(-a+bevel,-b),(a-bevel,-b),(a,-b+bevel),(a,b-bevel),
              (a-bevel,b),(-a+bevel,b),(-a,b-bevel),(-a,-b+bevel)]
        start=len(self.vertices)+1
        for h in (-c,c):
            self.vertices.extend((x+u,y+v,z+h) for u,v in ring)
        self.faces.append((material,tuple(start+i for i in reversed(range(8)))))
        self.faces.append((material,tuple(start+8+i for i in range(8))))
        for i in range(8):
            j=(i+1)%8
            self.faces.append((material,(start+i,start+j,start+8+j,start+8+i)))

    def cylinder(self,*args,**kwargs):
        first=len(self.faces)
        super().cylinder(*args,**kwargs)
        axis=kwargs.get('axis',args[4] if len(args)>4 else 'z')
        if axis=='y':
            self.faces[first:]=[(m,tuple(reversed(f))) for m,f in self.faces[first:]]

    def blade(self, angle_deg, center=(0,-.63,2.75), material='white'):
        first=len(self.faces)
        super().blade(angle_deg,center,material)
        self.faces[first:]=[(m,tuple(reversed(f))) for m,f in self.faces[first:]]

    def save(self):
        if self.name=='solar-panel':
            for i in range(1,6):
                self.box('cell_divider',(-.95+i*1.9/6,-.057,1.2),(.012,.012,1.05),'white')
            for j in range(1,4):
                self.box('cell_divider',(0,-.057,.675+j*1.05/4),(1.9,.012,.012),'white')
            # Tilt the complete panel and frame as one assembly.
            a=math.radians(-22)
            for i,(x,y,z) in enumerate(self.vertices):
                if i>=32:
                    dz=z-1.2
                    self.vertices[i]=(x,y*math.cos(a)-dz*math.sin(a),1.2+y*math.sin(a)+dz*math.cos(a))
            for x in (-.48,.48):
                self.box('foot',(x,0,.07),(.25,1.0,.14),'gray')
            self.box('battery_indicator',(0,-.39,.18),(.48,.03,.06),'blue')
        elif self.name=='wind-turbine':
            for x in (-.65,.65):
                for y in (-.5,.5):
                    self.box('foot',(x,y,.08),(.40,.38,.16),'gray')
            self.box('access_hatch',(0,-.205,.65),(.26,.04,.43),'orange')
            self.box('tower_band',(0,0,1.7),(.41,.41,.18),'orange')
            self.cylinder('hub_cap',(0,-.79,2.75),.18,.12,'y','orange',10)
            for y in (.12,.27,.42):
                self.box('vent',(.358,y,2.75),(.025,.06,.26),'gray')
        else:
            self.cylinder('neck',(0,0,1.56),.16,.16,'z','gray',10)
            for x in (-.25,.25):
                self.cylinder('knee',(x,-.22,.49),.12,.09,'y','gray',10)
            for x in (-.62,.62):
                self.box('wrist',(x,0,.73),(.19,.22,.15),'gray')
                for dx in (-.09,.09):
                    self.box('gripper',(x+dx,-.02,.61),(.09,.22,.20),'gray')
            self.box('antenna',(0,.08,2.25),(.055,.055,.27),'gray')
            self.box('antenna_tip',(0,.08,2.4),(.12,.12,.10),'orange')
            self.box('belt',(0,0,.82),(.94,.58,.12),'gray')
        super().save()
        print(self.name, len(self.vertices),'vertices',sum(len(f)-2 for _,f in self.faces),'triangles')

def track_part(method):
    def wrapped(self,*args,**kwargs):
        start=len(self.faces)
        method(self,*args,**kwargs)
        if not hasattr(self,'parts'): self.parts=[]
        name=str(args[0]) if method.__name__!='blade' else 'blade'
        self.parts.append((name,start,len(self.faces)))
    return wrapped

for method in ('box','cylinder','blade'):
    setattr(Model,method,track_part(getattr(Model,method)))
original_save=Model.save
def save_parts(self):
    original_save(self)
    parts=[]
    for name,start,end in self.parts:
        parts.append({'name':name,'faces':self.faces[start:end]})
    (base.OUT/(self.name+'.parts.json')).write_text(json.dumps({'vertices':self.vertices,'parts':parts}),encoding='utf-8')
Model.save=save_parts
base.Obj=Model
base.write_materials()
base.solar_panel()
base.wind_turbine()
base.robot_minion()
