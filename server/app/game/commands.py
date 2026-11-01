"""Authoritative commands. Identity is supplied out of band by the backend."""
import hashlib
import json
import math
import uuid

from app.world.geometry import surface_distance
from .state import (BUILDING_CAPACITY, BUILDING_RADIUS, INVENTORY_CAPACITY,
                    PLAYER_RADIUS, REACH, RECIPES, MINABLE_RESOURCES, RESOURCES, STARTING_RESOURCES,
                    Building, Context, Player, UnitOfWork)
from .state import PLAYER_COLORS, MOUNTAIN_RADIUS, building_interaction_distance, storage_capacity


class Rejected(Exception):
    def __init__(self, code, line=None):
        self.code = code
        self.line = line


def require(condition, code="INVALID_ARGUMENT"):
    if not condition:
        raise Rejected(code)


def fields(payload, *expected):
    require(isinstance(payload, dict) and set(payload) == set(expected))


def identifier(value):
    require(isinstance(value, str) and 1 <= len(value) <= 128)
    return value


def in_reach(planet, player, position, distance=REACH):
    require(player.position is not None and surface_distance(player.position, position, planet.radius) <= distance,
            "OUT_OF_RANGE")


def in_building_reach(planet, player, building):
    cell = planet.cells[building.cell_id]
    in_reach(planet, player, cell.center, building_interaction_distance(planet, cell))


def authorize(context, state):
    require(isinstance(context, Context) and context.world_id == state.world_id, "UNAUTHORIZED")
    player = state.players.get(context.user_id)
    require(player is not None, "UNAUTHORIZED")
    require(player.team_id == context.team_id, "FORBIDDEN")
    return player


def restart_world(state, planet):
    players, claims, pools = {}, {}, {}
    for (user_id, old), cell in zip(state.players.items(), planet.landing_sites):
        players[user_id] = Player(user_id, old.team_id, position=planet.cells[cell].center,
                                  color=old.color, seq=old.seq)
        claims[cell] = user_id
        pool = pools.setdefault(old.team_id, dict.fromkeys(RESOURCES, 0))
        for resource, amount in STARTING_RESOURCES.items():
            pool[resource] += amount
    state.players, state.landing_claims, state.team_storage = players, claims, pools
    state.buildings, state.mountains = {}, []
    state.rovers, state.rover_surveys, state.rover_points, state.rover_grants = {}, {}, {}, []
    state.team_oxygen = dict.fromkeys(pools, 0)
    state.oxygen_percent, state.stage, state.tick = 0.0, "lobby", 0
    state.generation += 1
    state.cell_overrides = {}
    state.map_revision += 1
    return {"generation": state.generation}


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
    if kind == "world.restart":
        fields(payload)
        require(all(p.team_id == player.team_id for p in state.players.values()), "FORBIDDEN")
        return restart_world(state, planet)
    if kind == "world.start":
        fields(payload)
        require(state.stage == "lobby", "ALREADY_STARTED")
        require(set(state.landing_claims.values()) == set(state.players), "LANDING_REQUIRED")
        state.mountains = [cell for cell in planet.landing_sites if cell not in state.landing_claims]
        state.stage = "running"
        from .rover import ensure_start
        ensure_start(state, planet)
        return {}
    if kind == "player.color":
        fields(payload, "color")
        color = payload["color"]
        require(isinstance(color, str) and color in PLAYER_COLORS)
        player.color = color
        return {"color": color}
    require(state.stage == "running", "NOT_STARTED")
    if kind.startswith("rover."):
        from .rover import (coordinates, office_access, parse, new_rover, spawn_position,
                            NAME, COST, CAPACITY, ROVER_RADIUS)
        if kind == "rover.survey":
            fields(payload)
            require(player.position is not None)
            coords = coordinates(player.position)
            surveys = state.rover_surveys.setdefault(player.user_id, [])
            require(len(surveys) < 16, "SURVEY_LIMIT")
            if coords not in surveys: surveys.append(coords)
            return coords
        if kind == "rover.stop":
            fields(payload, "rover_id")
            rover = state.rovers.get(identifier(payload["rover_id"]))
            require(rover is not None and rover['team_id'] == player.team_id, "FORBIDDEN")
            rover.update(status='idle', speed=0., error=None, line=None)
            return {}
        if kind == "rover.point.register":
            require(office_access(state, planet, player), "OFFICE_REQUIRED")
            fields(payload, "name", "latitude", "longitude")
            name, lat, lon = payload['name'], payload['latitude'], payload['longitude']
            require(isinstance(name,str) and NAME.fullmatch(name) is not None)
            require(type(lat) in (int,float) and type(lon) in (int,float) and math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon < 180 and round(lat,4)==lat and round(lon,4)==lon and (abs(lat)!=90 or lon==0))
            coords={'latitude':lat,'longitude':lon}
            require(coords in state.rover_surveys.get(player.user_id, []), "SURVEY_REQUIRED")
            points=state.rover_points.setdefault(player.team_id,{})
            require(name not in points, "POINT_EXISTS")
            require(len(points)<12, "POINT_LIMIT")
            points[name]={**coords,'name':name,'author':player.user_id,'version':1}
            return {}
        if kind == "rover.purchase":
            require(office_access(state, planet, player), "OFFICE_REQUIRED")
            fields(payload)
            pool=state.team_storage[player.team_id]
            require(all(pool.get(k,0)>=v for k,v in COST.items()), "INSUFFICIENT_RESOURCES")
            require(sum(r['team_id']==player.team_id for r in state.rovers.values())<4, "ROVER_LIMIT")
            obstacles=[(planet.cells[b.cell_id].center,BUILDING_RADIUS+ROVER_RADIUS+.05) for b in state.buildings.values()]
            obstacles += [(planet.cells[c].center,MOUNTAIN_RADIUS+ROVER_RADIUS+.05) for c in state.mountains]
            obstacles += [(p.position,PLAYER_RADIUS+ROVER_RADIUS+.05) for p in state.players.values() if p.position is not None]
            obstacles += [(r['position'],2*ROVER_RADIUS+.05) for r in state.rovers.values()]
            try: pos=spawn_position(player.position,planet,obstacles)
            except ValueError: raise Rejected("SPAWN_BLOCKED") from None
            from app.world.terrain import ground_position, seed_from_world_id
            rover=new_rover(player.team_id,ground_position(pos,planet.radius,seed=seed_from_world_id(state.world_id)),player.color)
            for k,v in COST.items(): pool[k]-=v
            state.rovers[rover['rover_id']]=rover
            return {'rover_id':rover['rover_id']}
        if kind in ("rover.program", "rover.start"):
            fields(payload, *(('rover_id','program','expected_revision') if kind == 'rover.program' else ('rover_id','expected_revision')))
            rover=state.rovers.get(identifier(payload['rover_id']))
            require(rover is not None and rover['team_id']==player.team_id, "FORBIDDEN")
            require(type(payload['expected_revision']) is int and payload['expected_revision']==rover['program_revision'], "REVISION_CONFLICT")
            points=state.rover_points.get(player.team_id,{})
            program=payload['program'] if kind=='rover.program' else rover['program']
            try: instructions=parse(program,points)
            except ValueError as e: raise Rejected(str(e), getattr(e, "line", None)) from None
            if kind=='rover.program':
                require(rover['status'] not in ('running','waiting'), "ROVER_RUNNING")
                rover['program']=program;rover['program_revision']+=1
                return {'program_revision':rover['program_revision']}
            require(rover['status'] not in ('running','waiting'), "ROVER_RUNNING")
            rover.update(status='running',error=None,line=None,pc=0,wait_ticks=0,instructions=instructions,
                         targets={i['value']:i['point'] for i in instructions if i['op']=='move_to'})
            rover['program_revision']+=1
            return {'program_revision':rover['program_revision']}
        raise Rejected("NOT_IMPLEMENTED")
    if kind == "player.input":
        require(isinstance(payload, dict) and {"seq", "move"} <= set(payload)
                and set(payload) <= {"seq", "move", "heading", "jump", "running", "flashlight", "pitch"})
        seq, move = payload["seq"], payload["move"]
        require(type(seq) is int and 0 <= seq <= 2**53 - 1)
        require(isinstance(move, (list, tuple)) and len(move) == 3)
        require(all(type(v) in (int, float) and -1 <= v <= 1 and math.isfinite(v) for v in move))
        require(seq > player.seq, "STALE_INPUT")
        jump, running = payload.get("jump", False), payload.get("running", False)
        require(type(jump) is bool and type(running) is bool)
        flashlight = payload.get("flashlight", player.flashlight)
        pitch = payload.get("pitch", player.pitch)
        require(type(flashlight) is bool)
        require(type(pitch) in (int, float) and math.isfinite(pitch) and -1.45 <= pitch <= 1.45)
        heading = payload.get("heading", player.heading)
        require(isinstance(heading, (list, tuple)) and len(heading) == 3)
        require(all(type(v) in (int, float) and math.isfinite(v) and -1 <= v <= 1 for v in heading))
        require(sum(v*v for v in heading) > .01)
        player.heading = tuple(heading)
        player.jump_pending = player.jump_pending or (
            jump and not player.jump_held and player.altitude <= 0)
        player.jump_held, player.running = jump, running
        player.flashlight, player.pitch = flashlight, pitch
        player.seq, player.move, player.input_tick = seq, tuple(move), state.tick
        return {}
    if kind == "building.place":
        fields(payload, "cell_id", "building_type")
        cell_id, building_type = identifier(payload["cell_id"]), identifier(payload["building_type"])
        require(cell_id in planet.cells and building_type in RECIPES and building_type != "dome_base")
        cell = planet.cells[cell_id]
        require(cell.buildable, "CELL_UNBUILDABLE")
        in_reach(planet, player, cell.center)
        require(not any(building.cell_id == cell_id for building in state.buildings.values()), "CELL_OCCUPIED")
        require(all(other.position is None or surface_distance(other.position, cell.center, planet.radius)
                    >= BUILDING_RADIUS + PLAYER_RADIUS for other in state.players.values()), "CELL_OCCUPIED")
        require(building_type != "drill" or cell.resource in MINABLE_RESOURCES, "RESOURCE_REQUIRED")
        cost = RECIPES[building_type]
        pool = state.team_storage[player.team_id]
        require(all(pool.get(resource, 0) >= amount for resource, amount in cost.items()), "INSUFFICIENT_RESOURCES")
        building_id = str(uuid.uuid4())
        building = Building(building_id, cell_id, building_type, player.team_id, player.user_id)
        # Every player-placed building enters the same authoritative build
        # schedule.  The landing dome is created by world setup and therefore
        # keeps the dataclass default of "completed".
        building.construction_status = "planned"
        building.paid_cost = dict(cost)
        for resource, amount in cost.items():
            pool[resource] -= amount
        state.buildings[building_id] = building
        return {"building_id": building_id}
    if kind == "building.remove":
        fields(payload, "building_id")
        building = state.buildings.get(identifier(payload["building_id"]))
        require(building is not None)
        require(building.team_id == player.team_id, "FORBIDDEN")
        require(building.building_type != "dome_base", "FORBIDDEN")
        in_building_reach(planet, player, building)
        pool = state.team_storage[player.team_id]
        # Refunds can exceed capacity: never destroy resources during demolition.
        for stock in (building.paid_cost, building.stock):
            for resource, amount in stock.items():
                pool[resource] = pool.get(resource, 0) + amount
        del state.buildings[building.building_id]
        return {"refunded": dict(building.paid_cost)}
    if kind == "player.teleport":
        fields(payload, "player_id")
        target = state.players.get(identifier(payload["player_id"]))
        require(target is not None and target.user_id != player.user_id and target.position is not None,
                "TARGET_UNAVAILABLE")
        from .rover import ROVER_RADIUS, spawn_position
        obstacles = [(planet.cells[b.cell_id].center, BUILDING_RADIUS + PLAYER_RADIUS)
                     for b in state.buildings.values()]
        obstacles += [(planet.cells[cell].center, MOUNTAIN_RADIUS + PLAYER_RADIUS)
                      for cell in state.mountains]
        obstacles += [(other.position, 2 * PLAYER_RADIUS + .05) for other in state.players.values()
                      if other.user_id != player.user_id and other.position is not None]
        obstacles += [(rover['position'], PLAYER_RADIUS + ROVER_RADIUS + .05)
                      for rover in state.rovers.values()]
        try:
            player.position = spawn_position(target.position, planet, obstacles)
        except ValueError:
            raise Rejected("SPAWN_BLOCKED") from None
        player.move = (0., 0., 0.)
        player.altitude = player.vertical_speed = 0.
        player.jump_held = player.jump_pending = player.running = False
        return {"player_id": target.user_id}
    if kind == "player.respawn":
        fields(payload)
        bases = [b for b in state.buildings.values()
                 if b.team_id == player.team_id and b.building_type == "dome_base"]
        own = [b for b in bases if b.creator_id == player.user_id]
        base = (own or bases)[-1] if bases else None
        origin = base.cell_id if base else next(cell for cell, user in state.landing_claims.items()
                                               if user == player.user_id)
        blocked = {b.cell_id for b in state.buildings.values()} | set(state.mountains)
        candidates = sorted(planet.cells.values(), key=lambda c: surface_distance(
            c.center, planet.cells[origin].center, planet.radius))
        obstacles = [(planet.cells[b.cell_id].center, BUILDING_RADIUS + PLAYER_RADIUS)
                     for b in state.buildings.values()]
        obstacles += [(planet.cells[cell].center, MOUNTAIN_RADIUS + PLAYER_RADIUS)
                      for cell in state.mountains]
        destination = next((c for c in candidates if c.cell_id not in blocked and all(
            surface_distance(c.center, position, planet.radius) >= radius
            for position, radius in obstacles) and all(
            other.user_id == player.user_id or other.position is None or
            surface_distance(c.center, other.position, planet.radius) >= 2 * PLAYER_RADIUS
            for other in state.players.values())), None)
        require(destination is not None, "SPAWN_BLOCKED")
        player.position = destination.center
        player.move = (0., 0., 0.)
        player.altitude = player.vertical_speed = 0.
        player.roof_building_id = None
        player.support_building_id = None
        player.support_surface_id = None
        player.jump_held = player.jump_pending = player.running = False
        return {"cell_id": destination.cell_id, "building_id": base.building_id if base else None}
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
            require(building.building_type not in ("solar_panel", "wind_turbine"))
            in_building_reach(planet, player, building)
            stock = state.team_storage[player.team_id] if building.building_type == "warehouse" else building.stock
            if kind == "resource.pickup":
                source, destination, capacity = stock, player.inventory, INVENTORY_CAPACITY
            else:
                source, destination = player.inventory, stock
                capacity = storage_capacity(state, player.team_id) if building.building_type == "warehouse" else BUILDING_CAPACITY
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
    """Return a result after publication; persist-adapter failures propagate.

    Significant requests and their results are published together. Replays have
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
                response = result(request_id, state.revision, False, code=error.code, **({"line": error.line} if error.line else {}))
            if not moving:
                state.command_results[key] = {"fingerprint": fingerprint, "result": json.loads(json.dumps(response))}
            return response
    except Rejected as error:
        return result(request_id if isinstance(request_id, str) else None, unit_of_work.state.revision, False, code=error.code)
