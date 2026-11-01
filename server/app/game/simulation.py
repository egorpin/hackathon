"""Fixed-step simulation; no I/O, clocks, network calls or agent inference."""
import math

from app.world.geometry import move_on_surface, surface_distance
from app.world.terrain import ground_position, seed_from_world_id
from .commands import authorize
from .state import (BUILDING_CAPACITY, BUILDING_RADIUS, INPUT_TIMEOUT_TICKS,
                    MOUNTAIN_RADIUS, OXYGEN_GOAL, PLAYER_RADIUS,
                    PRODUCTION_TICKS, REACH, RECIPES, SPEED, TICK_SECONDS,
                    INVENTORY_CAPACITY, STORAGE_CAPACITY, STARTING_ORE, MINABLE_RESOURCES,
                    STARTING_RESOURCES, OXYGEN_PER_CYCLE, storage_capacity)


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
        if player.position is None:
            continue
        active = world.tick - player.input_tick < INPUT_TIMEOUT_TICKS
        if active and player.jump_pending and player.altitude <= 0:
            player.vertical_speed = 3.4
        player.jump_pending = False
        if not active:
            player.jump_held = False
        if player.vertical_speed or player.altitude:
            player.vertical_speed -= 5.5 * dt_seconds
            player.altitude = max(0., player.altitude + player.vertical_speed * dt_seconds)
            if not player.altitude:
                player.vertical_speed = 0.
        move = player.move if active else (0., 0., 0.)
        speed = SPEED * (1.5 if active and player.running else 1)
        position = move_on_surface(player.position, move, speed * dt_seconds, planet.radius, obstacles)
        position = ground_position(position, planet.radius, player.altitude, seed_from_world_id(world.world_id))
        if position != player.position:
            player.position = position
            events.append({"type": "player.moved", "user_id": player.user_id})
    # Stable production order. Drills retain output until a player collects it.
    producers = sorted(world.buildings.values(), key=lambda b: b.building_id)
    ready = []
    for building in producers:
        if building.building_type not in ("drill", "oxygen_generator"):
            continue
        building.production_ticks += 1
        if building.production_ticks >= PRODUCTION_TICKS:
            building.production_ticks = 0
            ready.append(building)
    for building in ready:
        if building.building_type != "drill":
            continue
        resource = planet.cells[building.cell_id].resource
        if resource in MINABLE_RESOURCES and sum(building.stock.values()) < BUILDING_CAPACITY:
            building.stock[resource] += 1
            events.append({"type": "building.updated", "building_id": building.building_id})
    warehouses = [b for b in producers if b.building_type == "warehouse"]
    for building in ready:
        if building.building_type != "oxygen_generator" or world.oxygen_percent >= OXYGEN_GOAL:
            continue
        pool = world.team_storage[building.team_id]
        # A warehouse feeds only adjacent allied cells, and only missing inputs.
        # Manually deposited generator water is always consumed first.
        supplied = any(warehouse.team_id == building.team_id and
                       building.cell_id in planet.cells[warehouse.cell_id].neighbors
                       for warehouse in warehouses)
        if (building.stock.get("water", 0) < 1 and supplied and pool.get("water", 0) >= 1
                and sum(building.stock.values()) < BUILDING_CAPACITY):
            pool["water"] -= 1
            building.stock["water"] = building.stock.get("water", 0) + 1
        if building.stock.get("water", 0) >= 1:
            building.stock["water"] -= 1
            world.oxygen_percent = min(OXYGEN_GOAL, round(world.oxygen_percent + OXYGEN_PER_CYCLE, 6))
            events.append({"type": "building.updated", "building_id": building.building_id})
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

    players = [{"user_id": p.user_id, "team_id": p.team_id,
                "position": ground_position(p.position, planet.radius, p.altitude, seed_from_world_id(state.world_id)) if p.position else None,
                "color": p.color, "heading": p.heading, "altitude": p.altitude,
                "vertical_speed": p.vertical_speed,
                "running": p.running and state.tick-p.input_tick < INPUT_TIMEOUT_TICKS,
                "moving": any(p.move) and state.tick-p.input_tick < INPUT_TIMEOUT_TICKS}
               for p in state.players.values() if p.user_id == player.user_id or visible(p.position)]
    buildings = []
    for building in state.buildings.values():
        if not visible(planet.cells[building.cell_id].center):
            continue
        item = {"building_id": building.building_id, "cell_id": building.cell_id,
                "building_type": building.building_type, "team_id": building.team_id,
                "color": state.players[building.creator_id].color}
        if building.team_id == player.team_id:
            item["stock"] = building.stock if building.building_type != "warehouse" else state.team_storage[player.team_id]
        buildings.append(item)
    return {"type": "world.snapshot", "tick": state.tick, "revision": state.revision,
            "payload": {"stage": state.stage, "map_version": planet.version,
                        "players": players, "buildings": buildings, "inventory": player.inventory,
                        "last_input_seq": player.seq, "team_storage": state.team_storage[player.team_id],
                        "oxygen": state.oxygen_percent, "oxygen_percent": state.oxygen_percent, "oxygen_goal": OXYGEN_GOAL,
                        "landing_sites": planet.landing_sites, "landing_claims": state.landing_claims,
                        "mountains": state.mountains,
                        "config": {"radius": planet.radius, "tick_seconds": TICK_SECONDS, "speed": SPEED,
                                   "interaction_distance": REACH, "view_radius": view_radius,
                                   "building_radius": BUILDING_RADIUS, "player_radius": PLAYER_RADIUS,
                                   "mountain_radius": MOUNTAIN_RADIUS, "recipes": {kind: dict(cost) for kind, cost in RECIPES.items()},
                                   "inventory_capacity": INVENTORY_CAPACITY, "building_capacity": BUILDING_CAPACITY,
                                   "storage_capacity": storage_capacity(state, player.team_id),
                                   "warehouse_capacity": STORAGE_CAPACITY, "starting_resources": dict(STARTING_RESOURCES),
                                   "starting_ore": STARTING_ORE, "oxygen_per_cycle": OXYGEN_PER_CYCLE,
                                   "drill_auto_transfer": False, "warehouse_supply": "neighbors",
                                   "oxygen_inputs": {"water": 1},
                                   "production_ticks": PRODUCTION_TICKS, "oxygen_enabled": True}}}
