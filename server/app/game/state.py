"""Game state and an atomic publication boundary independent of transport.

The optional persist callback must accept a detached draft or raise. It runs
before publication under the same world lock. An adapter may commit immediately
or enqueue for eventual persistence; the backend owns the durability policy.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from threading import RLock

from app.world.geometry import Planet, surface_distance

TICK_SECONDS = .05
SPEED = 4.0
REACH = 4.5
PLAYER_RADIUS = .3 / 1.5
BUILDING_RADIUS = .8
MOUNTAIN_RADIUS = 1.5


def building_interaction_distance(planet, cell):
    """Reach the building from roughly half a cell, outside its collision disc."""
    cell_radius = sum(surface_distance(cell.center, v, planet.radius) for v in cell.vertices) / len(cell.vertices)
    return max(cell_radius, BUILDING_RADIUS + PLAYER_RADIUS + .05)


INVENTORY_CAPACITY = 50
BUILDING_CAPACITY = 50
STORAGE_CAPACITY = 200
BASE_STORAGE_CAPACITY = 300
MINABLE_RESOURCES = ("water", "sulfur", "iron", "copper")
RESOURCES = ("ore", *MINABLE_RESOURCES, "oxygen")
STARTING_ORE = 0
STARTING_RESOURCES = {"iron": 40, "sulfur": 15, "water": 5}
OXYGEN_PER_CYCLE = 0.1
RECIPES = {"drill": {"iron": 5}, "warehouse": {"iron": 10, "sulfur": 5},
           "oxygen_generator": {"iron": 15, "sulfur": 5}, "dome_base": {"iron": 10}}
INPUT_TIMEOUT_TICKS = 5
PRODUCTION_TICKS = 20
OXYGEN_GOAL = 100

# Public palette shared with the color picker. Accept only these exact values.
PLAYER_COLORS = ("#ff6b4a", "#ffbd4a", "#a7d94b", "#42d6a4",
                 "#42b8ff", "#687bff", "#bd70ff", "#ff75b8")


@dataclass(frozen=True)
class Context:
    """Created by the backend from a live authenticated session, never payload."""
    world_id: str
    user_id: str
    team_id: str


@dataclass
class Player:
    user_id: str
    team_id: str
    position: tuple[float, float, float] | None = None
    inventory: dict = field(default_factory=lambda: {**dict.fromkeys(RESOURCES, 0), "ore": STARTING_ORE})
    seq: int = -1
    move: tuple[float, float, float] = (0., 0., 0.)
    input_tick: int = -INPUT_TIMEOUT_TICKS
    color: str = PLAYER_COLORS[0]
    heading: tuple[float, float, float] = (0., 0., -1.)
    altitude: float = 0.
    vertical_speed: float = 0.
    jump_held: bool = False
    jump_pending: bool = False
    running: bool = False


@dataclass
class Building:
    building_id: str
    cell_id: str
    building_type: str
    team_id: str
    creator_id: str
    stock: dict = field(default_factory=lambda: dict.fromkeys(RESOURCES, 0))
    production_ticks: int = 0
    paid_cost: dict = field(default_factory=dict)


@dataclass
class WorldState:
    world_id: str
    map_version: str
    stage: str = "lobby"
    tick: int = 0
    revision: int = 0
    generation: int = 0
    players: dict[str, Player] = field(default_factory=dict)
    buildings: dict[str, Building] = field(default_factory=dict)
    landing_claims: dict[str, str] = field(default_factory=dict)
    mountains: list[str] = field(default_factory=list)
    team_storage: dict[str, dict] = field(default_factory=dict)
    team_oxygen: dict[str, int] = field(default_factory=dict)  # Legacy saves only.
    oxygen_percent: float = 0.0
    admin_paused: bool = False
    admin_version: int = 0
    admin_characters: list = field(default_factory=list)
    admin_active_character: str = "expedition"
    economy_version: int = 2
    # Request keys are user_id + ':' + canonical UUID within this world.
    command_results: dict[str, dict] = field(default_factory=dict)
    rovers: dict = field(default_factory=dict)
    rover_surveys: dict = field(default_factory=dict)
    rover_points: dict = field(default_factory=dict)
    rover_grants: list = field(default_factory=list)

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, data):
        """Restore a trusted persistence record, not client-supplied JSON."""
        values = deepcopy(data)
        if values.get("economy_version", 1) < 2:
            # Legacy construction spent personal ore. Preserve its value as iron
            # and remember the actual old price rather than refund a new recipe.
            old_prices = {"drill": 5, "warehouse": 5, "oxygen_generator": 8, "dome_base": 5}
            for player in values["players"].values():
                pool = values.setdefault("team_storage", {}).setdefault(player["team_id"], {})
                for resource, amount in player["inventory"].items():
                    target = "iron" if resource == "ore" else resource
                    pool[target] = pool.get(target, 0) + amount
                player["inventory"] = {}
            for pool in values.get("team_storage", {}).values():
                pool["iron"] = pool.get("iron", 0) + pool.pop("ore", 0)
            for building in values["buildings"].values():
                building.setdefault("paid_cost", {"iron": old_prices[building["building_type"]]})
                stock = building["stock"]
                stock["iron"] = stock.get("iron", 0) + stock.pop("ore", 0)
            values["oxygen_percent"] = min(100, max(values.get("team_oxygen", {}).values(), default=0))
            values["economy_version"] = 2
        values["players"] = {key: Player(**value) for key, value in values["players"].items()}
        for player in values["players"].values():
            if player.position is not None:
                player.position = tuple(player.position)
            player.move = tuple(player.move)
        values["buildings"] = {key: Building(**value) for key, value in values["buildings"].items()}
        # Older saves contain only ore; retain balances and add empty resources.
        for stock in [*(p.inventory for p in values["players"].values()),
                      *(b.stock for b in values["buildings"].values()),
                      *values.get("team_storage", {}).values()]:
            for resource in RESOURCES:
                stock.setdefault(resource, 0)
        return cls(**values)


class UnitOfWork:
    """One instance per world, shared by all commands and tick callers.

    No mutation is published if validation or the persist callback fails. Readers
    get detached snapshots. Durable batches must include command_results.
    Multiple processes need a backend transaction/locking adapter instead.
    """
    def __init__(self, planet: Planet, state: WorldState, persist=None):
        if state.map_version != planet.version:
            raise ValueError("Saved world uses another map version")
        self.planet = planet
        self._state = deepcopy(state)
        self._persist = persist
        self._lock = RLock()

    @property
    def state(self):
        with self._lock:
            return deepcopy(self._state)

    @contextmanager
    def transaction(self):
        with self._lock:
            draft = deepcopy(self._state)
            yield draft
            if draft == self._state:
                return
            if self._persist is not None:
                self._persist(deepcopy(draft))
            self._state = deepcopy(draft)

    def enroll(self, context: Context):
        """Backend calls after validating current world/team membership."""
        with self.transaction() as state:
            if context.world_id != state.world_id:
                raise ValueError("Wrong world")
            if context.user_id in state.players:
                if state.players[context.user_id].team_id != context.team_id:
                    raise ValueError("Membership changed; reconcile it before reconnect")
                return
            if len(state.players) >= 4:
                raise ValueError("World is full")
            state.players[context.user_id] = Player(context.user_id, context.team_id)
            state.team_storage.setdefault(context.team_id, dict.fromkeys(RESOURCES, 0))
            for resource, amount in STARTING_RESOURCES.items():
                state.team_storage[context.team_id][resource] += amount
            state.team_oxygen.setdefault(context.team_id, 0)
            state.revision += 1


def storage_capacity(state, team_id):
    """Total resource units shared by a team, independent of resource type."""
    return BASE_STORAGE_CAPACITY + STORAGE_CAPACITY * sum(b.building_type == "warehouse" and b.team_id == team_id
                                       for b in state.buildings.values())
