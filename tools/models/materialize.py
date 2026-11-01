"""Convert textured GLBs into a small face-material palette; retain rig/clips."""
import io, json, math, struct
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / 'client/public/assets/models'
COLORS = [('Shell', (.82,.80,.76)), ('Dark', (.055,.06,.065)),
          ('Accent', (1,.22,.015)), ('SolarCells', (.025,.065,.13))]

def load(path):
    b=path.read_bytes(); n=struct.unpack_from('<I',b,12)[0]
    return json.loads(b[20:20+n]), bytearray(b[28+n:])

def save(path,g,b):
    g['buffers']=[{'byteLength':len(b)}]
    j=json.dumps(g,separators=(',',':')).encode(); j+=b' '*((-len(j))%4)
    b+=b'\0'*((-len(b))%4)
    path.write_bytes(struct.pack('<III',0x46546c67,2,28+len(j)+len(b))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(b),0x004e4942)+b)

def accessor(g,b,i):
    a=g['accessors'][i]; v=g['bufferViews'][a['bufferView']]
    fmt={5126:'f',5125:'I',5123:'H',5121:'B'}[a['componentType']]
    count={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4,'MAT4':16}[a['type']]
    size=struct.calcsize(fmt)*count; start=v.get('byteOffset',0)+a.get('byteOffset',0)
    return [struct.unpack_from('<'+fmt*count,b,start+k*v.get('byteStride',size)) for k in range(a['count'])]

def append(g,b,data,typ,component,count):
    b.extend(b'\0'*((-len(b))%4)); start=len(b); b.extend(data)
    g.setdefault('bufferViews',[]).append({'buffer':0,'byteOffset':start,'byteLength':len(data)})
    a={'bufferView':len(g['bufferViews'])-1,'componentType':component,'count':count,'type':typ}
    g.setdefault('accessors',[]).append(a); return len(g['accessors'])-1

def classify(rgb):
    r,g,b=rgb
    if r>g*1.3 and r>b*1.5 and r>70: return 2
    if b>r*1.25 and b>g*1.08: return 3
    return 0 if max(rgb)>115 else 1

def convert(path):
    before=path.stat().st_size; g,b=load(path); images=[]
    for im in g.get('images',[]):
        v=g['bufferViews'][im['bufferView']]; start=v.get('byteOffset',0)
        images.append(Image.open(io.BytesIO(b[start:start+v['byteLength']])).convert('RGB'))
    original=g.get('materials',[])
    for mesh in g['meshes']:
        out=[]
        for p in mesh['primitives']:
            m=original[p.get('material',0)]; pbr=m.get('pbrMetallicRoughness',{})
            texture=pbr.get('baseColorTexture'); uv=accessor(g,b,p['attributes']['TEXCOORD_0']) if texture else None
            im=images[g['textures'][texture['index']]['source']] if texture else None
            indices=[v[0] for v in accessor(g,b,p['indices'])] if 'indices' in p else list(range(g['accessors'][p['attributes']['POSITION']]['count']))
            groups={}
            for k in range(0,len(indices),3):
                tri=indices[k:k+3]
                if im:
                    u=sum(uv[i][0] for i in tri)/3; v=sum(uv[i][1] for i in tri)/3
                    rgb=im.getpixel((min(im.width-1,max(0,int(u*im.width))),min(im.height-1,max(0,int(v*im.height)))))
                else:
                    rgb=tuple(round(c**(1/2.2)*255) for c in pbr.get('baseColorFactor',[1,1,1,1])[:3])
                groups.setdefault(classify(rgb),[]).extend(tri)
            attrs={k:v for k,v in p['attributes'].items() if not k.startswith(('TEXCOORD','COLOR'))}
            for mat,idx in groups.items():
                q=dict(p,attributes=attrs.copy(),material=mat)
                q['indices']=append(g,b,struct.pack('<'+'I'*len(idx),*idx),'SCALAR',5125,len(idx)); out.append(q)
        mesh['primitives']=out
    g['materials']=[{'name':n,'doubleSided':True,'pbrMetallicRoughness':{'baseColorFactor':[*c,1],'metallicFactor':.1,'roughnessFactor':.8}} for n,c in COLORS]
    for k in ('images','textures','samplers'):g.pop(k,None)
    # Compact all live accessor buffers, dropping embedded images and UVs.
    used=set()
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            used.update(p['attributes'].values());used.add(p['indices'])
            for target in p.get('targets',[]):used.update(target.values())
    for skin in g.get('skins',[]):
        if 'inverseBindMatrices' in skin:used.add(skin['inverseBindMatrices'])
    for animation in g.get('animations',[]):
        for s in animation['samplers']:used.update((s['input'],s['output']))
    old=g['accessors']; views=g['bufferViews']; mapping={}; new=bytearray();g['accessors']=[];g['bufferViews']=[]
    for i in sorted(used):
        a=old[i].copy();v=views[a['bufferView']].copy();start=v.get('byteOffset',0)
        new.extend(b'\0'*((-len(new))%4));v['byteOffset']=len(new);new.extend(b[start:start+v['byteLength']]);a['bufferView']=len(g['bufferViews']);g['bufferViews'].append(v);mapping[i]=len(g['accessors']);g['accessors'].append(a)
    for mesh in g['meshes']:
        for p in mesh['primitives']:
            p['attributes']={k:mapping[v] for k,v in p['attributes'].items()};p['indices']=mapping[p['indices']]
            for target in p.get('targets',[]):
                for k in target:target[k]=mapping[target[k]]
    for skin in g.get('skins',[]):
        if 'inverseBindMatrices' in skin:skin['inverseBindMatrices']=mapping[skin['inverseBindMatrices']]
    for animation in g.get('animations',[]):
        for s in animation['samplers']:
            for k in ('input','output'):s[k]=mapping[s[k]]
    save(path,g,new);print(path.stem,before,'->',path.stat().st_size)

if __name__=='__main__':
    for name in json.loads((DIR/'manifest.json').read_text())['approved']:convert(DIR/f'{name}.glb')
