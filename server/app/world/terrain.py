"""Seeded procedural terrain shared with the browser renderer."""
from functools import lru_cache
import math

from .geometry import unit, scale

DEFAULT_TERRAIN_SEED = 0x4D415253  # "MARS"


def seed_from_world_id(world_id):
    """FNV-1a over UTF-16 code units, matching JavaScript's string semantics."""
    value = 2166136261
    encoded = str(world_id).encode("utf-16-le", errors="surrogatepass")
    for index in range(0, len(encoded), 2):
        code_unit = encoded[index] | (encoded[index + 1] << 8)
        value = ((value ^ code_unit) * 16777619) & 0xFFFFFFFF
    return value or DEFAULT_TERRAIN_SEED


@lru_cache(maxsize=128)
def terrain_features(seed=DEFAULT_TERRAIN_SEED):
    """Create a stable shared feature layout from an unsigned 32-bit seed."""
    state = int(seed) & 0xFFFFFFFF
    if state == 0:
        state = DEFAULT_TERRAIN_SEED

    def random():
        nonlocal state
        state ^= (state << 13) & 0xFFFFFFFF
        state ^= state >> 17
        state ^= (state << 5) & 0xFFFFFFFF
        state &= 0xFFFFFFFF
        return state / 4294967296

    centers = []

    def feature():
        while True:
            y = random() * 2 - 1
            angle = random() * math.tau
            radial = math.sqrt(max(0, 1 - y * y))
            point = (radial * math.cos(angle), y, radial * math.sin(angle))
            if all(math.acos(max(-1, min(1, sum(a*b for a, b in zip(point, other))))) >= .5
                   for other in centers):
                centers.append(point)
                return point

    hills = tuple((*feature(), .30 + random() * .10, 1.8 + random() * .6) for _ in range(4))
    craters = tuple((*feature(), .22 + random() * .06, 1.2 + random() * .45, .16 + random() * .08)
                    for _ in range(3))
    return hills, craters


def terrain_height(position, seed=DEFAULT_TERRAIN_SEED):
    x, y, z = unit(position)
    height = .42 * math.sin(8*x+3*z) * math.sin(7*z-2*y) + .22 * math.sin(9*y+2*x)
    height += .18 * (abs(math.sin(22*x+9*z)) * abs(math.sin(18*z-7*y)) - .4)
    hills, craters = terrain_features(seed)
    for cx, cy, cz, width, amplitude in hills:
        d = math.acos(max(-1, min(1, x*cx+y*cy+z*cz))) / width
        height += amplitude * math.exp(-d*d*1.5)
    for cx, cy, cz, width, depth, rim in craters:
        d = math.acos(max(-1, min(1, x*cx+y*cy+z*cz))) / width
        height += -depth * math.exp(-d*d*2) + rim * math.exp(-((d-1)/.4)**2)
    return height


def ground_position(position, radius, altitude=0, seed=DEFAULT_TERRAIN_SEED):
    return scale(unit(position), radius + terrain_height(position, seed) + altitude)
