"""Structural checks for the imported astronaut GLB (no third-party packages)."""
import json
import math
import struct
import sys
from pathlib import Path


COMPONENT = {5121: ('B', 1), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
WIDTH = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def main(path: Path) -> None:
    data = path.read_bytes()
    magic, version, total = struct.unpack_from('<4sII', data)
    assert magic == b'glTF' and version == 2 and total == len(data), 'invalid GLB header'
    offset, document, binary = 12, None, None
    while offset < len(data):
        size, kind = struct.unpack_from('<I4s', data, offset)
        chunk = data[offset + 8:offset + 8 + size]
        if kind == b'JSON': document = json.loads(chunk)
        elif kind == b'BIN\x00': binary = chunk
        offset += 8 + size
    assert document is not None and binary is not None, 'GLB requires JSON and BIN chunks'
    assert document.get('skins'), 'no skin/skeleton in imported model'
    animations = {a['name'].lower() for a in document.get('animations', [])}
    for state in ('idle', 'walk', 'run', 'jump'):
        assert any(state in name for name in animations), f'missing {state} animation; found {sorted(animations)}'
    names = [n.get('name', '') for n in document.get('nodes', [])]
    assert any('arm' in name.lower() or 'hand' in name.lower() for name in names), 'no arm/hand named nodes'

    accessors = document['accessors']
    views = document['bufferViews']

    def read_accessor(index):
        accessor = accessors[index]
        view = views[accessor['bufferView']]
        fmt, component_size = COMPONENT[accessor['componentType']]
        width = WIDTH[accessor['type']]
        stride = view.get('byteStride', component_size * width)
        start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
        for row in range(accessor['count']):
            yield struct.unpack_from('<' + fmt * width, binary, start + row * stride)

    skin_primitive_count = 0
    position_lows, position_highs = [math.inf] * 3, [-math.inf] * 3
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            attrs = primitive.get('attributes', {})
            if 'POSITION' in attrs:
                for point in read_accessor(attrs['POSITION']):
                    for axis, value in enumerate(point):
                        position_lows[axis] = min(position_lows[axis], value)
                        position_highs[axis] = max(position_highs[axis], value)
            if 'JOINTS_0' in attrs or 'WEIGHTS_0' in attrs:
                assert 'JOINTS_0' in attrs and 'WEIGHTS_0' in attrs, 'skinning attributes must be paired'
                joints, weights = list(read_accessor(attrs['JOINTS_0'])), list(read_accessor(attrs['WEIGHTS_0']))
                assert len(joints) == len(weights), 'joint and weight counts differ'
                for row, (joint_row, weight_row) in enumerate(zip(joints, weights)):
                    assert all(math.isfinite(w) and w >= 0 for w in weight_row), f'invalid weights at vertex {row}'
                    total_weight = sum(weight_row)
                    assert abs(total_weight - 1.0) <= 0.02, f'vertex {row} weights sum to {total_weight:.4f}'
                    assert all(0 <= j < max(len(s['joints']) for s in document['skins']) for j in joint_row), 'joint index outside skeleton'
                skin_primitive_count += 1
    assert skin_primitive_count, 'no mesh has JOINTS_0 and WEIGHTS_0'
    dimensions = [hi - lo for lo, hi in zip(position_lows, position_highs)]
    assert all(math.isfinite(d) for d in dimensions), 'no mesh positions found'
    # Source files may encode vertical orientation or scale on their root node.
    assert 1.4 <= max(dimensions) <= 2.2, f'raw model extent {dimensions} is not approximately 1.8 m'
    print(f'OK: skins={len(document["skins"])} skinned_primitives={skin_primitive_count} animations={sorted(animations)} extent={dimensions}')


if __name__ == '__main__':
    main(Path(sys.argv[1]))
