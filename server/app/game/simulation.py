"""Fixed-step simulation; no I/O, clocks, network calls or agent inference."""
import math

from app.world.geometry import move_on_surface, surface_distance
from .commands import authorize
from .state import (BUILDING_CAPACITY, BUILDING_RADIUS, INPUT_TIMEOUT_TICKS,
                    MOUNTAIN_RADIUS, OXYGEN_GOAL, OXYGEN_PER_ORE, PLAYER_RADIUS,
                    PRODUCTION_TICKS, REACH, RECIPES, SPEED, TICK_SECONDS,
                    INVENTORY_CAPACITY, STORAGE_CAPACITY, STARTING_ORE)


def step(world, dt_seconds, planet):
    """Advance a caller-owned draft. Call within UnitOfWork.transaction().

    Events are internal dirty-object hints, not messages safe to broadcast.
    The backend accumulator schedules exactly 20 steps per simulated second.
    """
    if type(dt_seconds) not in (int, float) or not math.isfinite(dt_seconds) or abs(dt_seconds - TICK_SECONDS) > 1e-9:
        raise ValueError("step requires the fixed 0.05 second interval")
    if world.stage != "running":
        return []
    events = []
    obstacles = [(planet.cells[b.cell_id].center, BUILDING_RADIUS + PLAYER_RADIUS) for b in world.buildings.values()]
    obstacles += [(planet.cells[cell].center, MOUNTAIN_RADIUS + PLAYER_RADIUS) for cell in world.mountains]
    for player in world.players.values():
        if player.position is None or world.tick - player.input_tick >= INPUT_TIMEOUT_TICKS:
            continue
        position = move_on_surface(player.position, player.move, SPEED * dt_seconds, planet.radius, obstacles)
        if position != player.position:
            player.position = position
            events.append({"type": "player.moved", "user_id": player.user_id})
    for building in world.buildings.values():
        if building.building_type == "warehouse":
            continue
        building.production_ticks += 1
        if building.production_ticks < PRODUCTION_TICKS:
            continue
        building.production_ticks = 0
        if building.building_type == "drill" and building.stock["ore"] < BUILDING_CAPACITY:
            building.stock["ore"] += 1
            events.append({"type": "building.updated", "building_id": building.building_id})
        elif building.building_type == "oxygen_generator" and building.stock["ore"] > 0:
            building.stock["ore"] -= 1
            world.team_oxygen[building.team_id] += OXYGEN_PER_ORE
            events.append({"type": "team.progress", "team_id": building.team_id})
    world.tick += 1
    world.revision += 1
    return events


def snapshot(context, unit_of_work, view_radius=12.0):
    """Backend-only interest radius; camera coordinates are never an argument.

    Public positions and building geometry may be seen across teams. Inventories,
    building stock, warehouse resources and progress are filtered separately.
    """
    state, planet = unit_of_work.state, unit_of_work.planet
    player = authorize(context, state)

    def visible(position):
        return player.position is not None and position is not None and surface_distance(player.position, position, planet.radius) <= view_radius

    players = [{"user_id": p.user_id, "team_id": p.team_id, "position": p.position}
               for p in state.players.values() if p.user_id == player.user_id or visible(p.position)]
    buildings = []
    for building in state.buildings.values():
        if not visible(planet.cells[building.cell_id].center):
            continue
        item = {"building_id": building.building_id, "cell_id": building.cell_id,
                "building_type": building.building_type, "team_id": building.team_id}
        if building.team_id == player.team_id:
            item["stock"] = building.stock if building.building_type != "warehouse" else state.team_storage[player.team_id]
        buildings.append(item)
    return {"type": "world.snapshot", "tick": state.tick, "revision": state.revision,
            "payload": {"stage": state.stage, "map_version": planet.version,
                        "players": players, "buildings": buildings, "inventory": player.inventory,
                        "last_input_seq": player.seq, "team_storage": state.team_storage[player.team_id],
                        "oxygen": state.team_oxygen[player.team_id], "oxygen_goal": OXYGEN_GOAL,
                        "landing_sites": planet.landing_sites, "landing_claims": state.landing_claims,
                        "mountains": state.mountains,
                        "config": {"radius": planet.radius, "tick_seconds": TICK_SECONDS, "speed": SPEED,
                                   "interaction_distance": REACH, "view_radius": view_radius,
                                   "building_radius": BUILDING_RADIUS, "player_radius": PLAYER_RADIUS,
                                   "mountain_radius": MOUNTAIN_RADIUS, "recipes": dict(RECIPES),
                                   "inventory_capacity": INVENTORY_CAPACITY, "building_capacity": BUILDING_CAPACITY,
                                   "storage_capacity": STORAGE_CAPACITY, "starting_ore": STARTING_ORE,
                                   "production_ticks": PRODUCTION_TICKS, "oxygen_per_ore": OXYGEN_PER_ORE}}}
