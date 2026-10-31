"""Dual of a subdivided icosahedron; all distances are in metres.

Vertex insertion order is part of map version v1. No random seed or external
geometry dependency is needed. The twelve original vertices become pentagons.
"""
from dataclasses import dataclass
from itertools import combinations
import math
import hashlib

Vec3 = tuple[float, float, float]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def scale(v, factor):
    return tuple(x * factor for x in v)


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(v):
    length = math.sqrt(dot(v, v))
    if not math.isfinite(length) or length < 1e-12:
        raise ValueError("Expected a finite, nonzero vector")
    return scale(v, 1 / length)


def angle(a, b):
    return math.acos(max(-1.0, min(1.0, dot(unit(a), unit(b)))))


def surface_distance(a, b, radius):
    return radius * angle(a, b)


def arc_distance(point, start, end, radius):
    """Minimum distance to the short great-circle arc, including its ends."""
    a, b, p = unit(start), unit(end), unit(point)
    extent = angle(a, b)
    if extent < 1e-10:
        return radius * angle(p, a)
    tangent = unit(add(b, scale(a, -dot(a, b))))
    along = math.atan2(dot(p, tangent), dot(p, a))
    if 0 <= along <= extent:
        closest = add(scale(a, math.cos(along)), scale(tangent, math.sin(along)))
        return radius * angle(p, closest)
    return radius * min(angle(p, a), angle(p, b))


def move_on_surface(position, direction, distance, radius, obstacles=()):
    """Project intent to the tangent plane, advance, and sweep against discs.

    Obstacles are (surface centre, combined collision radius) pairs. A blocked
    move stays in place. This has no special Y axis and works at both poles.
    """
    normal = unit(position)
    tangent = add(direction, scale(normal, -dot(direction, normal)))
    magnitude = math.sqrt(dot(tangent, tangent))
    if magnitude < 1e-12:
        return tuple(position)
    candidate = scale(unit(add(scale(normal, radius), scale(unit(tangent), distance * min(1, magnitude)))), radius)
    if any(arc_distance(center, position, candidate, radius) < size for center, size in obstacles):
        return tuple(position)
    return candidate


@dataclass(frozen=True)
class Cell:
    cell_id: str
    center: Vec3
    vertices: tuple[Vec3, ...]
    neighbors: tuple[str, ...]
    chunk_id: str
    terrain: str = "ground"
    buildable: bool = True
    resource: str | None = None


@dataclass(frozen=True)
class Planet:
    version: str
    radius: float
    cells: dict[str, Cell]
    chunks: dict[str, tuple[str, ...]]
    landing_sites: tuple[str, ...]


def generate_planet(subdivisions=3, radius=30.0, chunk_cells=16):
    if type(subdivisions) is not int or not 0 <= subdivisions <= 4:
        raise ValueError("subdivisions must be 0..4")
    if type(chunk_cells) is not int or not 2 <= chunk_cells <= 64:
        raise ValueError("chunk_cells must be 2..64")
    if isinstance(radius, bool) or not math.isfinite(radius) or radius <= 0:
        raise ValueError("radius must be finite and positive")
    phi = (1 + math.sqrt(5)) / 2
    vertices = [unit(v) for v in (
        (-1, phi, 0), (1, phi, 0), (-1, -phi, 0), (1, -phi, 0),
        (0, -1, phi), (0, 1, phi), (0, -1, -phi), (0, 1, -phi),
        (phi, 0, -1), (phi, 0, 1), (-phi, 0, -1), (-phi, 0, 1),
    )]
    edge = min(angle(a, b) for a, b in combinations(vertices, 2))
    faces = [face for face in combinations(range(12), 3)
             if all(abs(angle(vertices[a], vertices[b]) - edge) < 1e-8 for a, b in combinations(face, 2))]
    for _ in range(subdivisions):
        midpoints = {}

        def midpoint(a, b):
            key = tuple(sorted((a, b)))
            if key not in midpoints:
                midpoints[key] = len(vertices)
                vertices.append(unit(add(vertices[a], vertices[b])))
            return midpoints[key]

        refined = []
        for a, b, c in faces:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            refined.extend(((a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)))
        faces = refined
    centers = [scale(unit(add(add(vertices[a], vertices[b]), vertices[c])), radius) for a, b, c in faces]
    incident = [[] for _ in vertices]
    neighbors = [set() for _ in vertices]
    for index, face in enumerate(faces):
        for a in face:
            incident[a].append(index)
            neighbors[a].update(b for b in face if a != b)
    # Each chunk grows through adjacency; cells and chunks have different IDs.
    remaining = set(range(len(vertices)))
    chunks, assignment = {}, {}
    while remaining:
        pending, group = [min(remaining)], []
        while pending and len(group) < chunk_cells:
            current = pending.pop(0)
            if current not in remaining:
                continue
            remaining.remove(current)
            group.append(current)
            pending.extend(sorted(neighbors[current] & remaining))
        chunk_id = f"chunk-{len(chunks):04d}"
        chunks[chunk_id] = tuple(f"cell-{i:04d}" for i in group)
        assignment.update((i, chunk_id) for i in group)
    sites = [0]
    while len(sites) < 4:
        sites.append(max((i for i in range(12) if i not in sites),
                         key=lambda i: (min(angle(vertices[i], vertices[j]) for j in sites), -i)))
    # Stable deposits, independent of Python hash randomization and chunking.
    resources = ("iron", "water", "sulfur")
    deposits = {}
    for i in range(len(vertices)):
        value = int.from_bytes(hashlib.sha256(f"resources-v1:{i}".encode()).digest()[:4], "big")
        if i not in sites and value % 5 == 0:
            deposits[i] = resources[(value // 5) % len(resources)]
    # Each landing site has all three resources within its immediate neighborhood.
    for site in sites:
        for index, neighbor in enumerate(sorted(neighbors[site] - set(sites))[:3]):
            deposits[neighbor] = resources[index]
    cells = {}
    for i, normal in enumerate(vertices):
        axis = (1, 0, 0) if abs(normal[0]) < .9 else (0, 1, 0)
        east = unit(cross(axis, normal))
        north = cross(normal, east)
        ordered = sorted(incident[i], key=lambda f: math.atan2(dot(centers[f], north), dot(centers[f], east)))
        cell_id = f"cell-{i:04d}"
        cells[cell_id] = Cell(cell_id, scale(normal, radius), tuple(centers[f] for f in ordered),
                              tuple(f"cell-{j:04d}" for j in sorted(neighbors[i])), assignment[i],
                              "landing" if i in sites else "ground", i not in sites, deposits.get(i))
    version = f"icosphere-v1-s{subdivisions}-r{radius:.17g}-c{chunk_cells}-resources-v1"
    return Planet(version, radius, cells, chunks, tuple(f"cell-{i:04d}" for i in sites))
