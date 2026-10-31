"""Game state and an atomic publication boundary independent of transport.

The optional persist callback must commit a complete draft atomically or raise.
It runs before publication under the same world lock. The default is explicitly
in-memory; the backend owns the durable adapter and session authentication.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from threading import RLock

from app.world.geometry import Planet

TICK_SECONDS = .05
SPEED = 4.0
REACH = 4.5
PLAYER_RADIUS = .3
BUILDING_RADIUS = .8
MOUNTAIN_RADIUS = 1.5
INVENTORY_CAPACITY = 50
BUILDING_CAPACITY = 50
STORAGE_CAPACITY = 200
MINABLE_RESOURCES = ("water", "sulfur", "iron")
RESOURCES = ("ore", *MINABLE_RESOURCES, "oxygen")
STARTING_ORE = 20
RECIPES = {"drill": 5, "warehouse": 5, "oxygen_generator": 8}
INPUT_TIMEOUT_TICKS = 5
PRODUCTION_TICKS = 20
OXYGEN_GOAL = 100


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


@dataclass
class Building:
    building_id: str
    cell_id: str
    building_type: str
    team_id: str
    creator_id: str
    stock: dict = field(default_factory=lambda: dict.fromkeys(RESOURCES, 0))
    production_ticks: int = 0


@dataclass
class WorldState:
    world_id: str
    map_version: str
    stage: str = "lobby"
    tick: int = 0
    revision: int = 0
    players: dict[str, Player] = field(default_factory=dict)
    buildings: dict[str, Building] = field(default_factory=dict)
    landing_claims: dict[str, str] = field(default_factory=dict)
    mountains: list[str] = field(default_factory=list)
    team_storage: dict[str, dict] = field(default_factory=dict)
    team_oxygen: dict[str, int] = field(default_factory=dict)
    # Request keys are user_id + ':' + canonical UUID within this world.
    command_results: dict[str, dict] = field(default_factory=dict)

    def to_dict(self):
        return asdict(self)

    @classmethod
    def from_dict(cls, data):
        """Restore a trusted persistence record, not client-supplied JSON."""
        values = deepcopy(data)
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

    No mutation is published if validation or persistence fails. Readers get
    detached snapshots. Persistence must include command_results in its commit.
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
            if state.stage != "lobby" or len(state.players) >= 4:
                raise ValueError("World is full or already started")
            state.players[context.user_id] = Player(context.user_id, context.team_id)
            state.team_storage.setdefault(context.team_id, dict.fromkeys(RESOURCES, 0))
            state.team_oxygen.setdefault(context.team_id, 0)
            state.revision += 1
