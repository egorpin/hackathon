"""Building shape DTOs and authoritative capsule movement resolution."""
import math
from functools import lru_cache

from app.world.geometry import add, cross, dot, move_on_surface, scale, surface_distance, unit
from app.world.terrain import terrain_height

PLAYER_HEIGHT = .6
STEP_HEIGHT = .3
COLLISION_EPSILON = 1e-6
GROUND_EPSILON = 1e-5
SUBSTEP_DISTANCE = .05

# Local X/Z extents and vertical bounds are based on the shipped model bounds.
# These are intentionally simple boxes and cylinders: every narrow support or
# frame member is represented without turning the whole model into one cuboid.
_PROFILES = {
    "dome_base": (
        ("foundation", "box", 0, 0, .95, .95, 0, 0, .12),
        ("concrete_base", "box", 0, 0, .5, .5, 0, .12, .235),
        ("dome_lower", "cylinder", 0, 0, 0, 0, .48, .2275, .43),
        ("dome_middle", "cylinder", 0, 0, 0, 0, .38, .43, .59),
        ("dome_crown", "cylinder", 0, 0, 0, 0, .25, .59, .7475),
        ("entry_door", "box", 0, .4345, .18, .1175, 0, .1225, .5725),
    ),
    "warehouse": (
        ("foundation", "box", 0, 0, .95, .95, 0, 0, .12),
        ("wall_x_pos", "box", .70, 0, .10, .70, 0, .12, .82),
        ("wall_x_neg", "box", -.70, 0, .10, .70, 0, .12, .82),
        ("wall_z_pos", "box", 0, .70, .60, .10, 0, .12, .82),
        ("wall_z_neg", "box", 0, -.70, .60, .10, 0, .12, .82),
        ("roof", "box", 0, 0, .80, .80, 0, .82, .94085),
    ),
    "oxygen_generator": (
        ("foundation", "box", 0, 0, .95, .95, 0, 0, .12),
        ("housing", "box", -.12, 0, .34, .325, 0, .182, .832),
        ("tank", "cylinder", .37, -.035, 0, 0, .125, .207, .827),
        ("tank_cap", "cylinder", .37, -.035, 0, 0, .09, .807, .887),
        ("pipe", "box", .105, -.035, .265, .045, 0, .906, .996),
        ("feet", "box", -.12, 0, .365, .335, 0, .12, .21),
    ),
    "drill": (
        ("leg_xp_zp", "cylinder", .63, .53, 0, 0, .08, 0, .815),
        ("leg_xp_zn", "cylinder", .63, -.53, 0, 0, .08, 0, .815),
        ("leg_xn_zp", "cylinder", -.63, .53, 0, 0, .08, 0, .815),
        ("leg_xn_zn", "cylinder", -.63, -.53, 0, 0, .08, 0, .815),
        ("body", "box", .089, 0, .616, .434, 0, .49, 1.51),
        ("bit", "cylinder", 0, 0, 0, 0, .2, .02, .59),
    ),
    "solar_panel": (
        ("foundation", "box", 0, 0, 1.20, .95, 0, 0, .12),
        ("base", "box", 0, 0, .60, .375, 0, .12, .42),
        ("mast", "cylinder", 0, 0, 0, 0, .08, .415, 1.065),
        ("panel_low", "box", 0, .20, 1.05, .10, 0, .736, 1.10),
        ("panel_mid", "box", 0, 0, 1.05, .11, 0, 1.10, 1.50),
        ("panel_high", "box", 0, -.20, 1.05, .10, 0, 1.50, 1.9044),
    ),
    "wind_turbine": (
        ("foundation", "box", 0, .08, 1.13765, .95, 0, 0, .12),
        ("base", "box", 0, 0, .775, .625, 0, .12, .48),
        ("mast_lower", "cylinder", 0, 0, 0, 0, .19, .35, 1.35),
        ("mast_upper", "cylinder", 0, 0, 0, 0, .19, 1.35, 2.47),
        ("nacelle", "box", 0, 0, .35, .525, 0, 2.63, 3.11),
        ("rotor", "box", 0, .655, .99, .195, 0, 2.259, 3.97),
    ),
}


@lru_cache(maxsize=4096)
def _terrain_frame(position, planet_radius, seed):
    """Match the client's terrain-normal frame and local X/Z orientation."""
    radial = unit(position)
    reference = (0., 1., 0.) if abs(radial[1]) < .9 else (1., 0., 0.)
    tangent = unit(cross(reference, radial))
    bitangent = unit(cross(radial, tangent))

    def sample(u, v):
        point = unit(add(add(radial, scale(tangent, u)), scale(bitangent, v)))
        return scale(point, planet_radius + terrain_height(point, seed))

    du = add(sample(.003, 0), scale(sample(-.003, 0), -1))
    dv = add(sample(0, .003), scale(sample(0, -.003), -1))
    normal = unit(cross(du, dv))
    if dot(normal, radial) < 0:
        normal = scale(normal, -1)

    # Quaternion rotation from local +Y to terrain normal, matching
    # THREE.Quaternion.setFromUnitVectors(upAxis, normal).
    qv = cross((0., 1., 0.), normal)
    qw = 1. + normal[1]
    qlength = math.sqrt(dot(qv, qv) + qw * qw)
    if qlength < 1e-12:
        axis_x, axis_z = (-1., 0., 0.), (0., 0., 1.)
    else:
        qv, qw = scale(qv, 1. / qlength), qw / qlength

        def rotate(value):
            return add(value, scale(cross(qv, add(cross(qv, value), scale(value, qw))), 2.))

        axis_x = unit(rotate((1., 0., 0.)))
        axis_z = unit(rotate((0., 0., 1.)))
    return radial, normal, axis_x, axis_z


def _building_type(building):
    return building if isinstance(building, str) else building.building_type


def collision_shapes(building, center, planet_radius, seed):
    """Build JSON-native terrain-aligned box/cylinder band DTOs."""
    radial, normal, axis_x, axis_z = _terrain_frame(tuple(center), planet_radius, seed)
    base_radius = planet_radius + terrain_height(center, seed)
    base = scale(radial, base_radius)
    height_scale = dot(normal, radial)
    result = []
    for sid, kind, offset_x, offset_z, half_x, half_z, radius, bottom, top in _PROFILES.get(_building_type(building), ()):
        mid_height = (bottom + top) / 2
        shape_center = add(add(add(base, scale(axis_x, offset_x)), scale(axis_z, offset_z)),
                           scale(normal, mid_height))
        item = {"id": sid, "kind": kind, "center": shape_center,
                "axis_x": axis_x, "axis_z": axis_z,
                "bottom": base_radius + bottom * height_scale,
                "top": base_radius + top * height_scale}
        if kind == "box":
            item["half_x"], item["half_z"] = half_x, half_z
        else:
            item["radius"] = radius
        result.append(item)
    return result


def collision_footprints(building, center, planet_radius, seed, max_height=.9):
    """Return ground-level shape DTOs for spawn/build clearance checks."""
    ground = planet_radius + terrain_height(center, seed)
    return [shape for shape in collision_shapes(building, center, planet_radius, seed)
            if shape["bottom"] <= ground + .45 and shape["top"] <= ground + max_height]


def footprint_radius(shape):
    """Conservative circle radius for legacy spawn candidate samplers."""
    if shape.get("kind", "cylinder") == "box":
        return math.hypot(shape["half_x"], shape["half_z"])
    return shape["radius"]


def _axes(shape):
    if shape.get("axis_x") is not None and shape.get("axis_z") is not None:
        return shape["axis_x"], shape["axis_z"]
    # Backward-compatible tangent frame for simple test/client fixtures.
    normal = unit(shape["center"])
    reference = (0., 1., 0.) if abs(normal[1]) < .9 else (1., 0., 0.)
    axis_x = unit(cross(reference, normal))
    return axis_x, unit(cross(normal, axis_x))


def _local_delta(shape, point, planet_radius):
    center_direction, point_direction = unit(shape["center"]), unit(point)
    delta = scale(add(point_direction, scale(center_direction, -1.)), planet_radius)
    axis_x, axis_z = _axes(shape)
    return dot(delta, axis_x), dot(delta, axis_z)


def footprint_distance(shape, point, planet_radius):
    """Signed horizontal distance to a shape footprint; negative is inside."""
    kind = shape.get("kind", "cylinder")
    if kind == "cylinder" and shape.get("axis_x") is None:
        return surface_distance(shape["center"], point, planet_radius) - shape["radius"]
    x, z = _local_delta(shape, point, planet_radius)
    if kind == "box":
        qx, qz = abs(x) - shape["half_x"], abs(z) - shape["half_z"]
        return math.hypot(max(qx, 0.), max(qz, 0.)) + min(max(qx, qz), 0.)
    return math.hypot(x, z) - shape["radius"]


def footprint_normal(shape, point, planet_radius):
    """Outward horizontal footprint normal in world coordinates."""
    axis_x, axis_z = _axes(shape)
    x, z = _local_delta(shape, point, planet_radius)
    if shape.get("kind", "cylinder") == "box":
        closest_x = max(-shape["half_x"], min(shape["half_x"], x))
        closest_z = max(-shape["half_z"], min(shape["half_z"], z))
        nx, nz = x - closest_x, z - closest_z
        if nx * nx + nz * nz < 1e-12:
            if shape["half_x"] - abs(x) <= shape["half_z"] - abs(z):
                nx, nz = (1. if x >= 0 else -1.), 0.
            else:
                nx, nz = 0., (1. if z >= 0 else -1.)
    else:
        length = math.hypot(x, z)
        nx, nz = ((x / length, z / length) if length > 1e-12 else (1., 0.))
    normal = add(scale(axis_x, nx), scale(axis_z, nz))
    return unit(add(normal, scale(unit(point), -dot(normal, unit(point)))))


def _overlap(shape, point, feet, planet_radius, player_radius, player_height):
    return (footprint_distance(shape, point, planet_radius) < player_radius - COLLISION_EPSILON
            and feet < shape["top"] - COLLISION_EPSILON
            and feet + player_height > shape["bottom"] + COLLISION_EPSILON)


def _has_head_clearance(shapes, point, feet, planet_radius, player_radius, player_height):
    head = feet + player_height
    for shape in shapes:
        if (footprint_distance(shape, point, planet_radius) < player_radius - COLLISION_EPSILON
                and head > shape["bottom"] + COLLISION_EPSILON
                and feet < shape["top"] - COLLISION_EPSILON):
            return False
    return True


def resolve_player_motion(position, altitude, vertical_speed, move, distance,
                          dt_seconds, planet_radius, ground_radius, shapes, *,
                          grounded, support_building_id=None,
                          support_surface_id=None, player_radius=.2,
                          player_height=PLAYER_HEIGHT, step_height=STEP_HEIGHT,
                          gravity=5.5):
    """Resolve vertical and horizontal capsule motion against radial bands."""
    shapes = sorted(shapes, key=lambda shape: (shape["building_id"], shape["surface_id"]))
    support = next((shape for shape in shapes
                    if shape["building_id"] == support_building_id
                    and shape["surface_id"] == support_surface_id), None)
    if support is None:
        support_building_id = support_surface_id = None
    else:
        feet = ground_radius(position) + altitude
        if (abs(feet - support["top"]) > .04
                or footprint_distance(support, position, planet_radius) >= player_radius - COLLISION_EPSILON
                or feet + player_height <= support["bottom"] + COLLISION_EPSILON):
            support = None
            support_building_id = support_surface_id = None

    grounded = bool(grounded and (altitude <= GROUND_EPSILON or support is not None))
    old_altitude, old_vertical_speed = altitude, vertical_speed
    if grounded and old_vertical_speed <= 0:
        vertical_speed = 0.
        if support is not None:
            altitude = max(0., support["top"] - ground_radius(position))
    else:
        vertical_speed = old_vertical_speed - gravity * dt_seconds
        altitude = max(0., old_altitude + vertical_speed * dt_seconds)
        if altitude == 0.:
            vertical_speed = 0.
            support_building_id = support_surface_id = None

    old_feet = ground_radius(position) + old_altitude
    new_feet = ground_radius(position) + altitude
    if old_vertical_speed > 0 and new_feet > old_feet:
        ceilings = [shape for shape in shapes
                    if footprint_distance(shape, position, planet_radius) < player_radius
                    and old_feet + player_height <= shape["bottom"] + COLLISION_EPSILON
                    and new_feet + player_height > shape["bottom"]]
        if ceilings:
            ceiling = min(ceilings, key=lambda item: (item["bottom"], item["building_id"], item["surface_id"]))
            altitude = max(0., ceiling["bottom"] - player_height - ground_radius(position))
            vertical_speed = 0.

    start_feet = old_feet
    descent = old_vertical_speed <= 0 and not (grounded and old_vertical_speed <= 0)
    steps = max(1, math.ceil(max(0., distance) / SUBSTEP_DISTANCE))
    subdistance = max(0., distance) / steps
    current = tuple(position)

    for _ in range(steps):
        candidate = move_on_surface(current, move, subdistance, planet_radius)
        candidate = scale(unit(candidate), ground_radius(candidate))
        if grounded and old_vertical_speed <= 0 and support is not None:
            if footprint_distance(support, candidate, planet_radius) < player_radius - COLLISION_EPSILON:
                altitude = max(0., support["top"] - ground_radius(candidate))
            else:
                support_building_id = support_surface_id = None
                support = None
        feet = ground_radius(candidate) + altitude
        if descent:
            crossed = [shape for shape in shapes
                       if footprint_distance(shape, candidate, planet_radius) < player_radius
                       and start_feet >= shape["top"] - COLLISION_EPSILON
                       and feet <= shape["top"] + COLLISION_EPSILON
                       and shape["bottom"] < shape["top"]]
            if crossed:
                landing = max(crossed, key=lambda item: (item["top"], item["building_id"], item["surface_id"]))
                altitude = max(0., landing["top"] - ground_radius(candidate))
                vertical_speed = 0.
                support_building_id, support_surface_id = landing["building_id"], landing["surface_id"]
                feet = landing["top"]
        collisions = [shape for shape in shapes if _overlap(
            shape, candidate, feet, planet_radius, player_radius, player_height)]
        if not collisions:
            current, start_feet = candidate, feet
            continue

        if grounded and old_vertical_speed <= 0:
            steps_up = sorted((shape for shape in collisions
                               if -COLLISION_EPSILON <= shape["top"] - start_feet <= step_height + COLLISION_EPSILON),
                              key=lambda item: (item["top"], item["building_id"], item["surface_id"]))
            for shape in steps_up:
                if _has_head_clearance(shapes, candidate, shape["top"], planet_radius, player_radius, player_height):
                    altitude = max(0., shape["top"] - ground_radius(candidate))
                    vertical_speed = 0.
                    support_building_id, support_surface_id = shape["building_id"], shape["surface_id"]
                    current, start_feet = candidate, shape["top"]
                    collisions = []
                    break
        if not collisions:
            continue

        blocker = None
        current_feet = ground_radius(current) + altitude
        for shape in collisions:
            start_gap = footprint_distance(shape, current, planet_radius)
            end_gap = footprint_distance(shape, candidate, planet_radius)
            already_penetrating = _overlap(shape, current, current_feet, planet_radius, player_radius, player_height)
            if not already_penetrating or end_gap <= start_gap + COLLISION_EPSILON:
                blocker = shape
                break
        if blocker is None:
            current, start_feet = candidate, feet
            continue

        desired = add(move, scale(unit(current), -dot(move, unit(current))))
        wall_normal = footprint_normal(blocker, current, planet_radius)
        slide = add(desired, scale(wall_normal, -dot(desired, wall_normal)))
        if dot(slide, slide) > 1e-12:
            slid = move_on_surface(current, slide, subdistance, planet_radius)
            slid = scale(unit(slid), ground_radius(slid))
            slide_feet = ground_radius(slid) + altitude
            if not any(_overlap(shape, slid, slide_feet, planet_radius, player_radius, player_height)
                       for shape in shapes):
                current, start_feet = slid, slide_feet

    if support_building_id is not None:
        support_shape = next((shape for shape in shapes
                              if shape["building_id"] == support_building_id
                              and shape["surface_id"] == support_surface_id), None)
        if support_shape is None or footprint_distance(support_shape, current, planet_radius) >= player_radius:
            support_building_id = support_surface_id = None
    current = scale(unit(current), ground_radius(current) + altitude)
    return current, altitude, vertical_speed, support_building_id, support_surface_id
