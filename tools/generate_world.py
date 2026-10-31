"""Export the vendored Goldberg generator as server-owned cell/chunk JSON."""
import argparse
from collections import Counter, defaultdict, deque
import json
from pathlib import Path
import numpy as np
from scipy.spatial import SphericalVoronoi
from vendor.goldberg_hexgrid import generate_goldberg_hex_sphere

ROOT = Path(__file__).resolve().parents[1]

def geometry(m, n, radius):
    _, positions, _ = generate_goldberg_hex_sphere(m=m, n=n)
    centers = np.array([[p.x, p.y, p.z] for p in positions])
    dual = SphericalVoronoi(centers)
    dual.sort_vertices_of_regions()
    vertices = dual.vertices * radius
    faces = []
    for i, region in enumerate(dual.regions):
        region = [int(v) for v in region]
        a, b, c = vertices[region[:3]]
        if np.dot(np.cross(b-a, c-a), centers[i]) < 0:
            region.reverse()
        # Canonical cycle, independent of scipy's starting vertex.
        first = min(range(len(region)), key=lambda k: tuple(np.round(vertices[region[k]], 8)))
        faces.append(region[first:] + region[:first])
    edges = defaultdict(list)
    for i, face in enumerate(faces):
        for a, b in zip(face, face[1:] + face[:1]):
            edges[tuple(sorted((a,b)))].append(i)
    counts = Counter(map(len, faces))
    if counts.get(5) != 12 or set(counts) - {5, 6}:
        raise ValueError(f"Unsupported topology for ({m},{n}): {dict(counts)}")
    if any(len(owners) != 2 for owners in edges.values()):
        raise ValueError("Mesh is not a closed two-manifold")
    if len(vertices) - len(edges) + len(faces) != 2:
        raise ValueError("Euler characteristic must be 2")
    neighbors = [[] for _ in faces]
    for owners in edges.values():
        a,b = owners
        neighbors[a].append(b)
        neighbors[b].append(a)
    return centers * radius, vertices, faces, [sorted(v) for v in neighbors]

def compact(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)

def build_world(m=12, n=0, radius=100, occupied=1):
    centers, vertices, faces, neighbors = geometry(m,n,radius)
    pentagons = [i for i, face in enumerate(faces) if len(face)==5]
    # Four well-separated candidates, stable for a fixed mesh version.
    sites = [max(pentagons, key=lambda i: centers[i][1])]
    while len(sites)<4:
        sites.append(min((i for i in pentagons if i not in sites),
                         key=lambda i: max(np.dot(centers[i],centers[j]) for j in sites)))
    ids = [f"gp-{m}-{n}-{i:05d}" for i in range(len(faces))]
    cells=[]
    for i, face in enumerate(faces):
        slot = sites.index(i) if i in sites else None
        surface = "landing" if slot is not None and slot<occupied else "mountain" if slot is not None else "regolith"
        cells.append(dict(cell_id=ids[i], center=np.round(centers[i],8).tolist(),
                          vertices=np.round(vertices[face],8).tolist(),
                          neighbors=[ids[j] for j in neighbors[i]], surface=surface,
                          buildable=surface!="mountain", landing_slot=slot,
                          occupied=slot is not None and slot<occupied))
    # Small connected chunks; stable BFS order and chunk IDs.
    remaining=set(range(len(cells))); chunks=[]
    while remaining:
        seed=min(remaining); queue=deque([seed]); chosen=[]
        while queue and len(chosen)<8:
            i=queue.popleft()
            if i not in remaining: continue
            remaining.remove(i); chosen.append(i)
            queue.extend(j for j in neighbors[i] if j in remaining)
        chunks.append(dict(chunk_id=f"gp-{m}-{n}-chunk-{len(chunks):04d}",cells=[cells[i] for i in chosen],rocks=[]))
    # Coarse independent display shell. No gameplay IDs, neighbors or full map.
    _, shell_vertices, shell_faces, _ = geometry(3,0,radius*.998)
    shell=dict(radius=radius*.998,detail=2,
               vertices=np.round(shell_vertices,5).tolist(),faces=shell_faces)
    spawn=centers[sites[0]]
    up=spawn/radius; heading=np.array([0.,0.,-1.]);heading-=up*np.dot(heading,up);heading/=np.linalg.norm(heading)
    state=dict(self_id="local",team_id="fixture-team",last_input_seq=0,
               world=dict(radius=radius,move_speed=5,view_radius=30,build_distance=8,
                          total_bytes=0,total_chunks=len(chunks),shell=shell),
               players=[dict(player_id="local",position=spawn.tolist(),heading=heading.tolist())],
               buildings=[])
    # Fixed point for numeric denominator width. Chunk records are the exported representation.
    chunk_bytes=sum(len(compact(c).encode()) for c in chunks)
    for _ in range(8):
        state["world"]["total_bytes"]=chunk_bytes+len(compact(state).encode())
    return dict(state=state,chunks=chunks,summary=dict(cells=len(cells),pentagons=12,
                hexagons=len(cells)-12,landing_sites=[ids[i] for i in sites],
                occupied=occupied,m=m,n=n))

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--m",type=int,default=12);parser.add_argument("--n",type=int,default=0)
    parser.add_argument("--occupied",type=int,choices=range(1,5),default=1)
    parser.add_argument("--output",type=Path,default=ROOT/"world"/"generated"/"goldberg.json")
    args=parser.parse_args()
    if args.m<1 or args.n<0 or args.m+args.n>32: parser.error("Require m>=1, n>=0, m+n<=32")
    world=build_world(args.m,args.n,occupied=args.occupied)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(compact(world),encoding="utf-8")
    print(json.dumps(world["summary"]))
if __name__=="__main__":main()
