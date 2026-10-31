"""Authoritative commands. Identity is supplied out of band by the backend."""
import hashlib
import json
import math
import uuid

from app.world.geometry import surface_distance
from .state import (BUILDING_CAPACITY, BUILDING_RADIUS, INVENTORY_CAPACITY,
                    PLAYER_RADIUS, REACH, RECIPES, MINABLE_RESOURCES, STORAGE_CAPACITY, Building, Context, UnitOfWork)
from .state import PLAYER_COLORS


class Rejected(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code="INVALID_ARGUMENT"):
    if not condition:
        raise Rejected(code)


def fields(payload, *expected):
    require(isinstance(payload, dict) and set(payload) == set(expected))


def identifier(value):
    require(isinstance(value, str) and 1 <= len(value) <= 128)
    return value


def in_reach(planet, player, position):
    require(player.position is not None and surface_distance(player.position, position, planet.radius) <= REACH,
            "OUT_OF_RANGE")


def authorize(context, state):
    require(isinstance(context, Context) and context.world_id == state.world_id, "UNAUTHORIZED")
    player = state.players.get(context.user_id)
    require(player is not None, "UNAUTHORIZED")
    require(player.team_id == context.team_id, "FORBIDDEN")
    return player


def dispatch(context, kind, payload, state, planet):
    player = authorize(context, state)
    if kind == "landing.select":
        fields(payload, "cell_id")
        cell_id = identifier(payload["cell_id"])
        require(state.stage == "lobby", "ALREADY_STARTED")
        require(cell_id in planet.landing_sites)
        require(state.landing_claims.get(cell_id) in (None, player.user_id), "CELL_OCCUPIED")
        state.landing_claims = {cell: user for cell, user in state.landing_claims.items() if user != player.user_id}
        state.landing_claims[cell_id] = player.user_id
        player.position = planet.cells[cell_id].center
        return {}
    if kind == "world.start":
        fields(payload)
        require(state.stage == "lobby", "ALREADY_STARTED")
        require(set(state.landing_claims.values()) == set(state.players), "LANDING_REQUIRED")
        state.mountains = [cell for cell in planet.landing_sites if cell not in state.landing_claims]
        state.stage = "running"
        return {}
    if kind == "player.color":
        fields(payload, "color")
        color = payload["color"]
        require(isinstance(color, str) and color in PLAYER_COLORS)
        player.color = color
        return {"color": color}
    require(state.stage == "running", "NOT_STARTED")
    if kind == "player.input":
        require(isinstance(payload, dict) and {"seq", "move"} <= set(payload)
                and set(payload) <= {"seq", "move", "heading", "jump", "running"})
        seq, move = payload["seq"], payload["move"]
        require(type(seq) is int and 0 <= seq <= 2**53 - 1)
        require(isinstance(move, (list, tuple)) and len(move) == 3)
        require(all(type(v) in (int, float) and -1 <= v <= 1 and math.isfinite(v) for v in move))
        require(seq > player.seq, "STALE_INPUT")
        jump, running = payload.get("jump", False), payload.get("running", False)
        require(type(jump) is bool and type(running) is bool)
        heading = payload.get("heading", player.heading)
        require(isinstance(heading, (list, tuple)) and len(heading) == 3)
        require(all(type(v) in (int, float) and math.isfinite(v) and -1 <= v <= 1 for v in heading))
        require(sum(v*v for v in heading) > .01)
        player.heading = tuple(heading)
        player.jump_pending = player.jump_pending or (jump and not player.jump_held and player.altitude <= 0)
        player.jump_held, player.running = jump, running
        player.seq, player.move, player.input_tick = seq, tuple(move), state.tick
        return {}
    if kind == "building.place":
        fields(payload, "cell_id", "building_type")
        cell_id, building_type = identifier(payload["cell_id"]), identifier(payload["building_type"])
        require(cell_id in planet.cells and building_type in RECIPES)
        cell = planet.cells[cell_id]
        require(cell.buildable, "CELL_UNBUILDABLE")
        in_reach(planet, player, cell.center)
        require(not any(building.cell_id == cell_id for building in state.buildings.values()), "CELL_OCCUPIED")
        require(all(other.position is None or surface_distance(other.position, cell.center, planet.radius)
                    >= BUILDING_RADIUS + PLAYER_RADIUS for other in state.players.values()), "CELL_OCCUPIED")
        require(building_type != "drill" or cell.resource in MINABLE_RESOURCES, "RESOURCE_REQUIRED")
        cost = RECIPES[building_type]
        require(player.inventory["ore"] >= cost, "INSUFFICIENT_RESOURCES")
        building_id = str(uuid.uuid4())
        building = Building(building_id, cell_id, building_type, player.team_id, player.user_id)
        player.inventory["ore"] -= cost
        state.buildings[building_id] = building
        return {"building_id": building_id}
    if kind in ("resource.pickup", "resource.deposit", "resource.give"):
        target_key = "recipient_player_id" if kind == "resource.give" else "building_id"
        fields(payload, target_key, "resource", "amount")
        target_id = identifier(payload[target_key])
        amount = payload["amount"]
        resource = payload["resource"]
        require(isinstance(resource, str) and resource in ("ore", *MINABLE_RESOURCES) and type(amount) is int and 1 <= amount <= INVENTORY_CAPACITY)
        if kind == "resource.give":
            target = state.players.get(target_id)
            require(target is not None and target.user_id != player.user_id)
            require(target.team_id == player.team_id, "FORBIDDEN")
            require(target.position is not None, "OUT_OF_RANGE")
            in_reach(planet, player, target.position)
            source, destination, capacity = player.inventory, target.inventory, INVENTORY_CAPACITY
        else:
            building = state.buildings.get(target_id)
            require(building is not None)
            require(building.team_id == player.team_id, "FORBIDDEN")
            in_reach(planet, player, planet.cells[building.cell_id].center)
            stock = state.team_storage[player.team_id] if building.building_type == "warehouse" else building.stock
            if kind == "resource.pickup":
                source, destination, capacity = stock, player.inventory, INVENTORY_CAPACITY
            else:
                source, destination = player.inventory, stock
                capacity = STORAGE_CAPACITY if building.building_type == "warehouse" else BUILDING_CAPACITY
        require(source.get(resource, 0) >= amount, "INSUFFICIENT_RESOURCES")
        require(sum(destination.values()) + amount <= capacity, "INVENTORY_FULL")
        source[resource] -= amount
        destination[resource] = destination.get(resource, 0) + amount
        return {}
    raise Rejected("NOT_IMPLEMENTED")


def result(request_id, revision, ok, **payload):
    return {"type": "action.result", "request_id": request_id, "revision": revision,
            "payload": {"ok": ok, **payload}}


def apply_command(context: Context, command, unit_of_work: UnitOfWork):
    """Return a result only after commit; persistence failures propagate.

    Significant requests and their results are committed together. Replays have
    no mutation or revision increment. The caller must derive recipient-specific
    snapshots after commit, rather than broadcast this private state wholesale.
    """
    request_id = command.get("request_id") if isinstance(command, dict) else None
    try:
        with unit_of_work.transaction() as state:
            authorize(context, state)
            require(isinstance(command, dict))
            kind, payload = command.get("type"), command.get("payload")
            require(isinstance(kind, str) and isinstance(payload, dict))
            moving = kind == "player.input"
            require(set(command) == ({"type", "payload"} if moving else {"type", "request_id", "payload"}))
            if not moving:
                require(isinstance(request_id, str) and len(request_id) == 36)
                try:
                    require(str(uuid.UUID(request_id)) == request_id)
                except ValueError:
                    raise Rejected("INVALID_ARGUMENT") from None
            try:
                serialized = json.dumps({"type": kind, "payload": payload}, sort_keys=True,
                                        separators=(",", ":"), allow_nan=False)
            except (ValueError, TypeError):
                raise Rejected("INVALID_ARGUMENT") from None
            require(len(serialized.encode("utf-8")) <= 4096)
            fingerprint = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
            key = f"{context.user_id}:{request_id}"
            if not moving and key in state.command_results:
                previous = state.command_results[key]
                require(previous["fingerprint"] == fingerprint, "REQUEST_CONFLICT")
                # A detached response prevents callers from modifying the replay cache.
                return json.loads(json.dumps(previous["result"]))
            try:
                details = dispatch(context, kind, payload, state, unit_of_work.planet)
                state.revision += 1
                response = result(request_id, state.revision, True, **details)
            except Rejected as error:
                # Dispatch validates every condition before performing mutations.
                response = result(request_id, state.revision, False, code=error.code)
            if not moving:
                state.command_results[key] = {"fingerprint": fingerprint, "result": json.loads(json.dumps(response))}
            return response
    except Rejected as error:
        return result(request_id if isinstance(request_id, str) else None, unit_of_work.state.revision, False, code=error.code)
