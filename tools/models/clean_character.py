"""Clean the astronaut's texture without changing geometry, skin or animations."""
import io
import json
import struct
import sys
from pathlib import Path
from collections import Counter
from PIL import Image, ImageFilter, ImageDraw

source, target = map(Path, sys.argv[1:3])
raw = source.read_bytes()
size = struct.unpack_from('<I', raw, 12)[0]
g = json.loads(raw[20:20+size])
binary = raw[28+size:]
old_views = g['bufferViews']
def data(index):
    view = old_views[index]
    offset = view.get('byteOffset', 0)
    return binary[offset:offset+view['byteLength']]

material = g['materials'][0]
texture = material['pbrMetallicRoughness']['baseColorTexture']['index']
image_index = g['textures'][texture]['source']
image = Image.open(io.BytesIO(data(g['images'][image_index]['bufferView']))).convert('RGB')
image.thumbnail((1024,1024), Image.Resampling.LANCZOS)
labels = Image.new('L',image.size)
labels.putdata([2 if r > g*1.35 and r > b*1.5 and r > 90 else 1 if (r+g+b)/3 > 110 else 0
                for r,g,b in image.get_flattened_data()])
labels = labels.filter(ImageFilter.ModeFilter(9))
pixels = list(labels.get_flattened_data())
width,height = labels.size
seen = bytearray(len(pixels))
for start in range(len(pixels)):
    if seen[start]: continue
    color = pixels[start]
    component, boundary = [start], Counter()
    seen[start] = 1
    for index in component:
        x,y = index%width,index//width
        for neighbor in ([index-1] if x else [])+([index+1] if x+1<width else [])+([index-width] if y else [])+([index+width] if y+1<height else []):
            if pixels[neighbor] != color: boundary[pixels[neighbor]] += 1
            elif not seen[neighbor]:
                seen[neighbor] = 1
                component.append(neighbor)
    if len(component)<180 and boundary:
        replacement = boundary.most_common(1)[0][0]
        for index in component: pixels[index] = replacement
# User-confirmed orientation: the face is on -Z, the rear is on +Z.
# Whiten rear torso and helmet UV triangles, preserving the front visor.
def accessor_values(index):
    accessor = g['accessors'][index]
    view = old_views[accessor['bufferView']]
    count = {'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[accessor['type']]
    code = {5126:'f',5123:'H',5125:'I',5121:'B'}[accessor['componentType']]
    fmt = '<'+code*count
    stride = view.get('byteStride',struct.calcsize(fmt))
    payload = data(accessor['bufferView'])
    offset = accessor.get('byteOffset',0)
    return [struct.unpack_from(fmt,payload,offset+i*stride) for i in range(accessor['count'])]
mask = Image.new('L',labels.size)
draw = ImageDraw.Draw(mask)
for mesh in g['meshes']:
    for primitive in mesh['primitives']:
        attributes = primitive['attributes']
        positions = accessor_values(attributes['POSITION'])
        uvs = accessor_values(attributes['TEXCOORD_0'])
        indices = [v[0] for v in accessor_values(primitive['indices'])]
        for i in range(0,len(indices),3):
            triangle = indices[i:i+3]
            center = [sum(positions[v][axis] for v in triangle)/3 for axis in range(3)]
            if abs(center[0]) < .34 and .65 < center[1] < 1.82 and center[2] > .04:
                draw.polygon([(uvs[v][0]*width,uvs[v][1]*height) for v in triangle],fill=255)
mask = mask.filter(ImageFilter.MaxFilter(3))
pixels = [1 if selected and color == 0 else color for color,selected in zip(pixels,mask.get_flattened_data())]
clean = Image.new('P',labels.size)
clean.putpalette([28,30,32,245,245,245,245,78,24]+[0]*759)
clean.putdata(pixels)
encoded_image = io.BytesIO()
clean.save(encoded_image,'PNG',optimize=True)

# Keep every non-image buffer byte-for-byte, including all animation and skin data.
image_views = {image['bufferView'] for image in g['images']}
views, packed, mapping = [], bytearray(), {}
def append(payload, template=None):
    packed.extend(b'\0' * (-len(packed)%4))
    view = dict(template or {})
    view.update(buffer=0,byteOffset=len(packed),byteLength=len(payload))
    views.append(view)
    packed.extend(payload)
    return len(views)-1
for index,view in enumerate(old_views):
    if index not in image_views: mapping[index] = append(data(index),view)
for accessor in g['accessors']:
    if 'bufferView' in accessor: accessor['bufferView'] = mapping[accessor['bufferView']]
    if 'sparse' in accessor:
        for key in ('indices','values'):
            item = accessor['sparse'][key]
            item['bufferView'] = mapping[item['bufferView']]
g['images'] = [{'bufferView':append(encoded_image.getvalue()),'mimeType':'image/png','name':'SuitClean1024'}]
g['textures'] = [{'source':0}]
for material in g['materials']:
    material.pop('normalTexture',None)
    material.pop('emissiveTexture',None)
    material.pop('emissiveFactor',None)
    material.pop('occlusionTexture',None)
    material['pbrMetallicRoughness'] = {'baseColorTexture':{'index':0},'metallicFactor':0,'roughnessFactor':0.9}
g['bufferViews'] = views
g['buffers'] = [{'byteLength':len(packed)}]
encoded = json.dumps(g,separators=(',',':')).encode()
encoded += b' ' * (-len(encoded)%4)
packed.extend(b'\0' * (-len(packed)%4))
result = struct.pack('<4sII',b'glTF',2,28+len(encoded)+len(packed))
result += struct.pack('<II',len(encoded),0x4E4F534A)+encoded
result += struct.pack('<II',len(packed),0x004E4942)+packed
target.write_bytes(result)
print(json.dumps({'before':len(raw),'after':len(result),'clips':[a['name'] for a in g['animations']],'skins':len(g['skins'])}))
