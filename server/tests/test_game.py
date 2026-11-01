"""Domain tests also run without third-party dependencies via unittest."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
from pathlib import Path
import tempfile
import unittest
import uuid

from app.game import Context, UnitOfWork, WorldState, apply_command, snapshot, step
from app.game.state import (BUILDING_CAPACITY, INVENTORY_CAPACITY, TICK_SECONDS, Building, PLAYER_COLORS,
                            BUILDING_RADIUS, PLAYER_RADIUS, building_interaction_distance)
from app.world import generate_planet, move_on_surface, surface_distance
from app.world.export import export_planet
from app.world.geometry import angle, cross, dot, unit
from app.world.terrain import ground_position, seed_from_world_id


def command(kind, **payload):
    return {"type": kind, "request_id": str(uuid.uuid4()), "payload": payload}


class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planet = generate_planet()

    def test_topology_and_winding(self):
        planet = self.planet
        self.assertEqual(len(planet.cells), 642)
        self.assertEqual(sum(len(c.neighbors) == 5 for c in planet.cells.values()), 12)
        edge_count = sum(len(c.neighbors) for c in planet.cells.values()) // 2
        self.assertEqual(1280 - edge_count + len(planet.cells), 2)
        for cell in planet.cells.values():
            self.assertIn(len(cell.neighbors), (5, 6))
            self.assertEqual(len(cell.vertices), len(cell.neighbors))
            self.assertAlmostEqual(math.sqrt(dot(cell.center, cell.center)), planet.radius)
            for a, b in zip(cell.vertices, cell.vertices[1:] + cell.vertices[:1]):
                self.assertGreater(dot(cross(a, b), cell.center), 0)
            for neighbor in cell.neighbors:
                self.assertIn(cell.cell_id, planet.cells[neighbor].neighbors)
                shared = set(cell.vertices) & set(planet.cells[neighbor].vertices)
                self.assertEqual(len(shared), 2)

    def test_chunk_partition_connected_and_deterministic(self):
        planet = self.planet
        self.assertEqual(planet, generate_planet())
        members = [cell for cells in planet.chunks.values() for cell in cells]
        self.assertEqual(len(members), len(set(members)))
        self.assertEqual(set(members), set(planet.cells))
        self.assertTrue(any(len(cells) > 1 for cells in planet.chunks.values()))
        for chunk, cells in planet.chunks.items():
            self.assertLessEqual(len(cells), 16)
            visited, pending = set(), [cells[0]]
            while pending:
                current = pending.pop()
                if current not in visited:
                    visited.add(current)
                    pending.extend(set(planet.cells[current].neighbors) & set(cells) - visited)
                self.assertEqual(planet.cells[current].chunk_id, chunk)
            self.assertEqual(visited, set(cells))
        self.assertEqual(len(planet.landing_sites), 4)
        self.assertTrue(all(len(planet.cells[c].neighbors) == 5 for c in planet.landing_sites))

    def test_deposits_are_deterministic_and_available_at_landings(self):
        self.assertEqual({c.resource for c in self.planet.cells.values()}, {None, "water", "iron", "sulfur", "copper"})
        for site in self.planet.landing_sites:
            self.assertIsNone(self.planet.cells[site].resource)
            self.assertTrue({"water", "iron", "sulfur"} <= {self.planet.cells[n].resource for n in self.planet.cells[site].neighbors})

    def test_export_byte_counts_and_hashes(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = export_planet(self.planet, directory)
            total = 0
            for record in manifest["chunks"]:
                raw = (Path(directory) / record["path"]).read_bytes()
                self.assertEqual(record["byte_size"], len(raw))
                self.assertEqual(record["sha256"], hashlib.sha256(raw).hexdigest())
                total += len(raw)
            self.assertEqual(manifest["total_chunk_bytes"], total)

    def test_small_fixture_matches_versioned_generator(self):
        fixture = Path(__file__).resolve().parents[2] / "world" / "fixtures" / "small"
        self.assertTrue((fixture / "manifest.json").is_file())
        with tempfile.TemporaryDirectory() as directory:
            export_planet(generate_planet(subdivisions=1, chunk_cells=8), directory)
            self.assertEqual({p.name for p in fixture.glob("*.json")}, {p.name for p in Path(directory).glob("*.json")})
            for path in fixture.glob("*.json"):
                self.assertEqual(path.read_bytes(), (Path(directory) / path.name).read_bytes())

    def test_continuous_movement_at_both_poles(self):
        for pole in (-30., 30.):
            position = (0., pole, 0.)
            moved = move_on_surface(position, (1., 0., 0.), .2, 30.)
            self.assertGreater(moved[0], 0)
            self.assertAlmostEqual(math.sqrt(dot(moved, moved)), 30)
            self.assertLessEqual(surface_distance(position, moved, 30), .2)
            self.assertEqual(move_on_surface(position, (0., 1., 0.), .2, 30), position)
        position = (-.01, math.sqrt(900 - .0001), 0)
        self.assertGreater(move_on_surface(position, (1., 0., 0.), .2, 30)[0], 0)

    def test_swept_collision_even_when_endpoint_is_clear(self):
        start = (0., 30., 0.)
        obstacle = move_on_surface(start, (1., 0., 0.), 1., 30.)
        moved = move_on_surface(start, (1., 0., 0.), 2., 30., [(obstacle, .2)])
        self.assertEqual(moved, start)


class GameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planet = generate_planet()

    def setUp(self):
        self.context = Context("world-a", "alice", "team-a")
        self.world = UnitOfWork(self.planet, WorldState("world-a", self.planet.version))
        self.world.enroll(self.context)

    def act(self, kind, context=None, **payload):
        return apply_command(context or self.context, command(kind, **payload), self.world)

    def ok(self, response):
        self.assertTrue(response["payload"]["ok"], response)
        return response["payload"]

    def start(self):
        self.ok(self.act("landing.select", cell_id=self.planet.landing_sites[0]))
        self.ok(self.act("world.start"))

    def advance(self, ticks):
        # Simulation itself performs no persistence or lock acquisition.
        with self.world.transaction() as state:
            for _ in range(ticks):
                step(state, TICK_SECONDS, self.planet)

    def build(self, building_type="drill", cell_id=None, complete=True):
        if cell_id is None:
            cell_id = self.planet.cells[self.planet.landing_sites[0]].neighbors[0]
        building_id = self.ok(self.act("building.place", cell_id=cell_id, building_type=building_type))["building_id"]
        # Most tests exercise completed-building behavior. Construction tests
        # opt out so they can assert the complete timeline independently.
        if complete:
            with self.world.transaction() as state:
                building = state.buildings[building_id]
                building.construction_progress = building.construction_required
                building.construction_status = "completed"
        return building_id

    def supply_energy(self):
        # Production fixtures have a remote panel; balances under test stay intact.
        cell = next(c for c in self.planet.cells if c not in self.planet.landing_sites
                    and c not in self.planet.cells[self.planet.landing_sites[0]].neighbors)
        with self.world.transaction() as state:
            state.buildings['test-solar'] = Building('test-solar', cell, 'solar_panel', 'team-a', 'alice')

    def move_near(self, building_id):
        cell = self.planet.cells[self.world.state.buildings[building_id].cell_id]
        direction = unit(cross(cell.center, cell.vertices[0]))
        with self.world.transaction() as state:
            state.players['alice'].position = move_on_surface(cell.center, direction, 1.1, self.planet.radius)

    def interact(self, kind, building_id, **payload):
        self.move_near(building_id)
        return self.act(kind, building_id=building_id, **payload)

    def test_teleport_to_player_checks_target_and_clears_motion(self):
        bob = Context('world-a', 'bob', 'team-a')
        self.world.enroll(bob)
        self.ok(self.act('landing.select', cell_id=self.planet.landing_sites[0]))
        self.ok(self.act('landing.select', context=bob, cell_id=self.planet.landing_sites[1]))
        self.ok(self.act('world.start'))
        with self.world.transaction() as state:
            player = state.players['alice']
            player.move = (1., 0., 0.)
            player.altitude = player.vertical_speed = 2.
            player.jump_held = player.jump_pending = player.running = True
        self.ok(self.act('player.teleport', player_id='bob'))
        player = self.world.state.players['alice']
        target = self.world.state.players['bob']
        distance = surface_distance(player.position, target.position, self.planet.radius)
        self.assertGreaterEqual(distance, 2 * PLAYER_RADIUS)
        self.assertLessEqual(distance, 10.01)
        self.assertEqual((player.move, player.altitude, player.vertical_speed), ((0., 0., 0.), 0., 0.))
        self.assertFalse(player.jump_held or player.jump_pending or player.running)
        for target_id in ('alice', 'missing'):
            self.assertEqual(self.act('player.teleport', player_id=target_id)['payload']['code'], 'TARGET_UNAVAILABLE')

    def test_teleport_rejects_blocked_destination(self):
        from unittest.mock import patch
        bob = Context('world-a', 'bob', 'team-a')
        self.world.enroll(bob)
        self.ok(self.act('landing.select', cell_id=self.planet.landing_sites[0]))
        self.ok(self.act('landing.select', context=bob, cell_id=self.planet.landing_sites[1]))
        self.ok(self.act('world.start'))
        original = self.world.state.players['alice'].position
        with patch('app.game.rover.spawn_position', side_effect=ValueError):
            self.assertEqual(self.act('player.teleport', player_id='bob')['payload']['code'], 'SPAWN_BLOCKED')
        self.assertEqual(self.world.state.players['alice'].position, original)

    def test_building_interaction_range_is_short_and_matches_snapshot(self):
        self.start()
        cell = self.planet.cells[self.planet.cells[self.planet.landing_sites[0]].neighbors[0]]
        direction = unit(cross(cell.center, cell.vertices[0]))
        with self.world.transaction() as state:
            state.players['alice'].position = move_on_surface(cell.center, direction, 3.5, self.planet.radius)
        building = self.build(cell_id=cell.cell_id)  # Placement retains its 4.5 m range.
        published = next(b for b in snapshot(self.context, self.world)['payload']['buildings']
                         if b['building_id'] == building)['interaction_distance']
        mean = sum(surface_distance(cell.center, v, self.planet.radius) for v in cell.vertices) / len(cell.vertices)
        self.assertAlmostEqual(published, max(mean, BUILDING_RADIUS + PLAYER_RADIUS + .05))
        self.assertLess(published, 3.5)
        with self.world.transaction() as state:
            state.buildings[building].stock['iron'] = 2
            state.players['alice'].inventory['iron'] = 2
        for kind in ('resource.pickup', 'resource.deposit', 'building.remove'):
            payload = {} if kind == 'building.remove' else {'resource': 'iron', 'amount': 1}
            self.assertEqual(self.act(kind, building_id=building, **payload)['payload']['code'], 'OUT_OF_RANGE')
        self.move_near(building)
        for kind in ('resource.pickup', 'resource.deposit', 'building.remove'):
            payload = {} if kind == 'building.remove' else {'resource': 'iron', 'amount': 1}
            self.ok(self.act(kind, building_id=building, **payload))

    def test_interaction_range_remains_outside_collision_on_small_planet(self):
        planet = generate_planet(radius=1)
        cell = next(iter(planet.cells.values()))
        self.assertGreater(building_interaction_distance(planet, cell), BUILDING_RADIUS + PLAYER_RADIUS)

    def test_lobby_claims_capacity_and_mountains(self):
        self.assertEqual(self.act("world.start")["payload"]["code"], "LANDING_REQUIRED")
        others = [Context("world-a", f"user-{n}", "team-a") for n in range(3)]
        for context in others:
            self.world.enroll(context)
        with self.assertRaises(ValueError):
            self.world.enroll(Context("world-a", "fifth", "team-a"))
        for context, site in zip([self.context, *others], self.planet.landing_sites):
            self.ok(self.act("landing.select", context=context, cell_id=site))
        self.assertEqual(self.act("landing.select", cell_id=self.planet.landing_sites[1])["payload"]["code"], "CELL_OCCUPIED")
        self.ok(self.act("world.start"))
        self.assertEqual(self.world.state.mountains, [])
        self.assertEqual(self.act("landing.select", cell_id=self.planet.landing_sites[0])["payload"]["code"], "ALREADY_STARTED")

    def test_unused_sites_are_nonbuildable_mountains(self):
        self.start()
        self.assertEqual(len(self.world.state.mountains), 3)
        self.assertEqual(self.act("building.place", cell_id=self.planet.landing_sites[1], building_type="drill")["payload"]["code"], "CELL_UNBUILDABLE")

    def test_start_base_is_free_and_protected(self):
        self.start()
        bases = [b for b in self.world.state.buildings.values() if b.building_type == 'dome_base']
        self.assertEqual(len(bases), 1)
        self.assertEqual(self.world.state.team_storage['team-a']['iron'], 40)
        self.assertFalse(self.act('building.place', cell_id=self.planet.cells[self.planet.landing_sites[0]].neighbors[0], building_type='dome_base')['payload']['ok'])
        self.assertEqual(self.act('building.remove', building_id=bases[0].building_id)['payload']['code'], 'FORBIDDEN')

    def test_complete_resource_loop_and_balance(self):
        self.start()
        self.supply_energy()
        neighbors = self.planet.cells[self.planet.landing_sites[0]].neighbors
        drill = self.build("drill", neighbors[0])
        warehouse = self.build("warehouse", neighbors[1])
        generator_cell = next(cell for cell in neighbors if cell != neighbors[0]
                              and cell in self.planet.cells[neighbors[1]].neighbors)
        with self.world.transaction() as state:
            state.players["alice"].position = move_on_surface(self.planet.cells[generator_cell].center, unit(cross(self.planet.cells[generator_cell].center, self.planet.cells[generator_cell].vertices[0])), 1.2, self.planet.radius)
        self.build("oxygen_generator", generator_cell)
        self.advance(100)
        state = self.world.state
        self.assertEqual(state.buildings[drill].stock["iron"], 5)
        self.assertEqual(state.team_storage["team-a"]["iron"], 10)
        self.assertEqual(state.team_storage["team-a"]["water"], 0)
        self.assertEqual(state.oxygen_percent, 0.5)
        self.advance(60)
        self.assertEqual(self.world.state.oxygen_percent, 0.5)
        self.assertEqual(self.world.state.team_storage["team-a"]["iron"], 10)
        self.ok(self.interact("resource.pickup", building_id=drill, resource="iron", amount=8))
        self.assertEqual(self.world.state.players["alice"].inventory["iron"], 8)
        self.ok(self.interact("resource.deposit", building_id=warehouse, resource="iron", amount=8))
        self.assertEqual(self.world.state.team_storage["team-a"]["iron"], 18)

    def test_drill_requires_resource_without_spending(self):
        self.start()
        cell = next(c for c in self.planet.cells.values() if c.buildable and c.resource is None)
        with self.world.transaction() as state:
            state.players["alice"].position = self.planet.cells[cell.neighbors[0]].center
        before = self.world.state
        response = self.act("building.place", cell_id=cell.cell_id, building_type="drill")
        self.assertEqual(response["payload"]["code"], "RESOURCE_REQUIRED")
        self.assertEqual(self.world.state.players, before.players)
        self.assertEqual(self.world.state.buildings, before.buildings)
        self.build("warehouse", cell.cell_id)

    def test_each_deposit_produces_and_transfers_its_resource(self):
        self.start()
        self.supply_energy()
        for resource in ("iron", "water", "sulfur", "copper"):
            cell = next(c for c in self.planet.cells.values() if c.resource == resource)
            with self.world.transaction() as state:
                state.players["alice"].position = move_on_surface(cell.center, unit(cross(cell.center, (0, 0, 1))), 2, self.planet.radius)
            building_id = self.build(cell_id=cell.cell_id)
            before = self.world.state.team_storage["team-a"][resource]
            self.advance(20)
            self.assertEqual(self.world.state.buildings[building_id].stock[resource], 1)
            self.assertEqual(self.world.state.team_storage["team-a"][resource], before)
            self.ok(self.act("resource.pickup", building_id=building_id, resource=resource, amount=1))
            self.assertEqual(self.world.state.players["alice"].inventory[resource], 1)
            self.assertEqual(self.act("resource.pickup", building_id=building_id, resource="oxygen", amount=1)["payload"]["code"], "INVALID_ARGUMENT")

    def test_retry_conflict_and_concurrent_build(self):
        self.start()
        cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[0]
        request = command("building.place", cell_id=cell, building_type="drill")
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: apply_command(self.context, request, self.world), range(4)))
        self.assertTrue(all(r == results[0] for r in results))
        self.ok(results[0])
        self.assertEqual(len(self.world.state.buildings), 2)
        self.assertEqual(self.world.state.team_storage["team-a"]["iron"], 35)
        conflict = {**request, "payload": {**request["payload"], "building_type": "warehouse"}}
        self.assertEqual(apply_command(self.context, conflict, self.world)["payload"]["code"], "REQUEST_CONFLICT")
        other_cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.act("building.place", cell_id=other_cell, building_type="drill"), range(4)))
        self.assertEqual(sum(r["payload"]["ok"] for r in results), 1)
        self.assertEqual(self.world.state.team_storage["team-a"]["iron"], 30)

    def test_commit_failure_does_not_publish_building_or_debit_or_request(self):
        self.start()
        before = self.world.state

        def fail(_):
            raise OSError("simulated commit failure")

        self.world._persist = fail
        with self.assertRaises(OSError):
            self.build()
        self.assertEqual(self.world.state, before)

    def test_saved_state_restore_and_retry(self):
        saved = []
        self.world._persist = lambda state: saved.append(json.dumps(state.to_dict()))
        self.start()
        self.supply_energy()
        request = command("building.place", cell_id=self.planet.cells[self.planet.landing_sites[0]].neighbors[0], building_type="drill")
        response = apply_command(self.context, request, self.world)
        # Construction takes 160 travel ticks and 60 building ticks; the
        # remaining 220 ticks produce eleven units at full power.
        self.advance(440)
        restored = UnitOfWork(self.planet, WorldState.from_dict(json.loads(saved[-1])))
        self.assertEqual(json.loads(json.dumps(restored.state.to_dict())), json.loads(saved[-1]))
        self.assertEqual(apply_command(self.context, request, restored), response)
        self.assertEqual(snapshot(self.context, restored)["payload"]["team_storage"]["iron"], 35)
        self.assertEqual(next(b for b in restored.state.buildings.values() if b.building_type == "drill").stock["iron"], 11)
        with self.assertRaises(ValueError):
            UnitOfWork(generate_planet(subdivisions=1), restored.state)

    def test_player_color_is_palette_checked_owned_and_persisted(self):
        bob = Context("world-a", "bob", "team-a")
        self.world.enroll(bob)
        self.ok(self.act("landing.select", cell_id=self.planet.landing_sites[0]))
        self.ok(self.act("landing.select", context=bob, cell_id=self.planet.landing_sites[1]))
        self.ok(self.act("world.start"))
        own_id = self.build()
        with self.world.transaction() as state:
            state.players["bob"].position = state.players["alice"].position
            other_cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
            state.buildings["bob-building"] = Building("bob-building", other_cell, "warehouse", "team-a", "bob")
        saved = []
        self.world._persist = lambda state: saved.append(state.to_dict())

        response = self.act("player.color", color="#42b8ff")
        self.ok(response)
        self.assertEqual(self.world.state.players["alice"].color, "#42b8ff")
        self.assertEqual(self.world.state.players["bob"].color, PLAYER_COLORS[0])
        self.assertEqual(saved[-1]["players"]["alice"]["color"], "#42b8ff")
        restored = UnitOfWork(self.planet, WorldState.from_dict(saved[-1]))
        view = snapshot(self.context, restored)["payload"]
        self.assertEqual(next(p for p in view["players"] if p["user_id"] == "alice")["color"], "#42b8ff")
        self.assertEqual(next(b for b in view["buildings"] if b["building_id"] == own_id)["color"], "#42b8ff")
        self.assertEqual(next(b for b in view["buildings"] if b["building_id"] == "bob-building")["color"], PLAYER_COLORS[0])
        self.assertEqual(self.act("player.color", color="#ffffff")["payload"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(self.world.state.players["alice"].color, "#42b8ff")

    def test_authorization_and_untrusted_payload(self):
        self.start()
        cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[0]
        for context, code in [(Context("other-world", "alice", "team-a"), "UNAUTHORIZED"),
                              (Context("world-a", "alice", "forged-team"), "FORBIDDEN"),
                              (Context("world-a", "unknown", "team-a"), "UNAUTHORIZED")]:
            self.assertEqual(self.act("building.place", context=context, cell_id=cell, building_type="drill")["payload"]["code"], code)
        self.assertEqual(self.act("building.place", cell_id=cell, building_type="drill", team_id="team-a")["payload"]["code"], "INVALID_ARGUMENT")

    def test_distances_cost_and_occupied_cell(self):
        self.start()
        far = max((c for c in self.planet.cells.values() if c.buildable), key=lambda c: angle(c.center, self.world.state.players["alice"].position))
        self.assertEqual(self.act("building.place", cell_id=far.cell_id, building_type="drill")["payload"]["code"], "OUT_OF_RANGE")
        drill = self.build()
        building = self.world.state.buildings[drill]
        self.assertEqual(self.act("building.place", cell_id=building.cell_id, building_type="drill")["payload"]["code"], "CELL_OCCUPIED")
        with self.world.transaction() as state:
            state.players["alice"].position = far.center
        self.assertEqual(self.act("resource.pickup", building_id=drill, resource="ore", amount=1)["payload"]["code"], "OUT_OF_RANGE")
        with self.world.transaction() as state:
            state.players["alice"].position = self.planet.cells[self.planet.landing_sites[0]].center
            state.team_storage["team-a"]["iron"] = 0
        self.assertEqual(self.act("building.place", cell_id=self.planet.cells[self.planet.landing_sites[0]].neighbors[1], building_type="drill")["payload"]["code"], "INSUFFICIENT_RESOURCES")

    def test_invalid_amounts_and_capacities(self):
        self.start()
        self.supply_energy()
        drill = self.build()
        self.advance(2000)
        self.assertEqual(self.world.state.team_storage["team-a"]["iron"], 35)
        self.assertEqual(self.world.state.buildings[drill].stock["iron"], BUILDING_CAPACITY)
        for amount in (-1, 0, True, 1.5, "1", 51, 10**300, None):
            self.assertEqual(self.act("resource.pickup", building_id=drill, resource="ore", amount=amount)["payload"]["code"], "INVALID_ARGUMENT")
        with self.world.transaction() as state:
            state.players["alice"].inventory["ore"] = INVENTORY_CAPACITY - 1
            state.players["alice"].inventory["iron"] = 1
            state.buildings[drill].stock["iron"] = BUILDING_CAPACITY
        self.move_near(drill)
        self.assertEqual(self.act("resource.pickup", building_id=drill, resource="iron", amount=1)["payload"]["code"], "INVENTORY_FULL")
        self.assertEqual(self.act("resource.deposit", building_id=drill, resource="iron", amount=1)["payload"]["code"], "INVENTORY_FULL")

    def test_give_and_private_snapshot(self):
        bob = Context("world-a", "bob", "team-a")
        eve = Context("world-a", "eve", "team-b")
        for context, cell in zip((self.context, bob, eve), self.planet.landing_sites):
            self.world.enroll(context)
            self.ok(self.act("landing.select", context=context, cell_id=cell))
        self.ok(self.act("world.start"))
        drill = self.build()
        self.assertEqual(self.act("resource.give", recipient_player_id="bob", resource="ore", amount=1)["payload"]["code"], "OUT_OF_RANGE")
        with self.world.transaction() as state:
            for name in ("bob", "eve"):
                state.players[name].position = state.players["alice"].position
            state.oxygen_percent = 42
            state.players["alice"].inventory["ore"] = 3
        self.ok(self.act("resource.give", recipient_player_id="bob", resource="ore", amount=3))
        self.assertEqual(self.world.state.players["bob"].inventory["ore"], 3)
        self.assertEqual(self.act("resource.give", recipient_player_id="eve", resource="ore", amount=1)["payload"]["code"], "FORBIDDEN")
        for action in ("resource.pickup", "resource.deposit"):
            self.assertEqual(self.act(action, context=eve, building_id=drill, resource="ore", amount=1)["payload"]["code"], "FORBIDDEN")
        view = snapshot(eve, self.world)["payload"]
        self.assertEqual(len(view["players"]), 3)
        self.assertTrue(all("inventory" not in p for p in view["players"]))
        self.assertNotIn("stock", view["buildings"][0])
        self.assertEqual(view["oxygen"], 42)

    def test_movement_speed_sequence_timeout_and_fixed_step(self):
        self.start()
        before = self.world.state.players["alice"].position
        move = unit(cross(before, (0, 0, 1)))
        request = {"type": "player.input", "payload": {"seq": 1, "move": move}}
        self.ok(apply_command(self.context, request, self.world))
        self.assertEqual(apply_command(self.context, request, self.world)["payload"]["code"], "STALE_INPUT")
        self.advance(1)
        after = self.world.state.players["alice"].position
        self.assertGreater(surface_distance(before, after, 30), .19)
        self.assertLessEqual(surface_distance(before, after, 30), .2)
        self.advance(4)
        stopped = self.world.state.players["alice"].position
        self.advance(20)
        for actual, expected in zip(self.world.state.players["alice"].position, stopped):
            self.assertAlmostEqual(actual, expected, places=12)
        for dt in (-1, 0, .1, float("nan")):
            with self.assertRaises(ValueError):
                step(self.world.state, dt, self.planet)
        for invalid in ([float("nan"), 0, 0], [float("inf"), 0, 0], [True, 0, 0], [10**1000, 0, 0], [2, 0, 0]):
            request["payload"] = {"seq": 2, "move": invalid}
            self.assertEqual(apply_command(self.context, request, self.world)["payload"]["code"], "INVALID_ARGUMENT")

    def test_movement_stops_at_building_and_mountain(self):
        self.start()
        drill = self.build()
        target = self.planet.cells[self.world.state.buildings[drill].cell_id].center
        for seq in range(30):
            origin = self.world.state.players["alice"].position
            direction = unit(tuple(b - a for a, b in zip(origin, target)))
            self.ok(apply_command(self.context, {"type": "player.input", "payload": {"seq": seq, "move": direction}}, self.world))
            self.advance(1)
        position = self.world.state.players["alice"].position
        self.assertGreaterEqual(surface_distance(position, target, 30), 1.0)
        self.assertLess(surface_distance(position, target, 30), 1.3)
        mountain = self.planet.cells[self.world.state.mountains[0]].center
        near = move_on_surface(mountain, unit(cross(mountain, (0, 0, 1))), 1.9, 30)
        with self.world.transaction() as state:
            state.players["alice"].position = near
        direction = unit(tuple(b - a for a, b in zip(near, mountain)))
        self.ok(apply_command(self.context, {"type": "player.input", "payload": {"seq": 31, "move": direction}}, self.world))
        self.advance(1)
        position = self.world.state.players["alice"].position
        self.assertEqual(position, ground_position(near, 30, seed=seed_from_world_id(self.world.state.world_id)))
        self.assertAlmostEqual(surface_distance(position, near, 30), 0, places=6)
        self.assertAlmostEqual(surface_distance(position, mountain, 30), 1.9, delta=.01)

    def test_mutating_committed_draft_does_not_mutate_world(self):
        with self.world.transaction() as draft:
            draft.team_oxygen["team-a"] = 1
        draft.team_oxygen["team-a"] = -1
        self.assertEqual(self.world.state.team_oxygen["team-a"], 1)

    def test_failed_result_replays_and_snapshots_are_detached(self):
        request = command("world.start")
        first = apply_command(self.context, request, self.world)
        self.ok(self.act("landing.select", cell_id=self.planet.landing_sites[0]))
        self.assertEqual(apply_command(self.context, request, self.world), first)
        first["payload"]["code"] = "tampered"
        self.assertEqual(apply_command(self.context, request, self.world)["payload"]["code"], "LANDING_REQUIRED")
        view = snapshot(self.context, self.world)
        view["payload"]["inventory"]["ore"] = -100
        self.assertEqual(self.world.state.players["alice"].inventory["ore"], 0)


if __name__ == "__main__":
    unittest.main()
