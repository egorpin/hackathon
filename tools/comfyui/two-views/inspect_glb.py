import json,struct,sys
from pathlib import Path
for raw in sys.argv[1:]:
 p=Path(raw);b=p.read_bytes()
 if len(b)<20 or b[:4]!=b'glTF': raise SystemExit(f'{p}: invalid GLB signature')
 version,total=struct.unpack_from('<II',b,4)
 if version!=2 or total!=len(b): raise SystemExit(f'{p}: invalid GLB v{version} length {total}!={len(b)}')
 jlen,jtype=struct.unpack_from('<II',b,12)
 if jtype!=0x4E4F534A or 20+jlen>len(b): raise SystemExit(f'{p}: missing JSON chunk')
 g=json.loads(b[20:20+jlen].decode('utf-8').rstrip('\x00 \t\r\n'))
 pos=[a for a in g.get('accessors',[]) if a.get('type')=='VEC3' and a.get('componentType')==5126]
 tri=sum((a.get('count',0)//3) for a in g.get('accessors',[]) if a.get('type')=='SCALAR' and a.get('componentType') in (5121,5123,5125))
 print(json.dumps({'file':str(p),'bytes':len(b),'version':version,'scene_nodes':len(g.get('nodes',[])),'meshes':len(g.get('meshes',[])),'positions':sum(a.get('count',0) for a in pos),'index_accessors':sum(1 for a in g.get('accessors',[]) if a.get('type')=='SCALAR' and a.get('componentType') in (5121,5123,5125)),'materials':len(g.get('materials',[])),'images':len(g.get('images',[]))},ensure_ascii=False))
