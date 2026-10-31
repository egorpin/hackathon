"""Economy invariants: conservation, ownership, retries and persisted progress."""
from concurrent.futures import ThreadPoolExecutor

from app.game import Context, UnitOfWork, WorldState, apply_command, snapshot
from app.game.state import RECIPES, STARTING_RESOURCES, storage_capacity
import unittest
import test_game as helpers
from test_game import command


class EconomyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planet = helpers.GameTests.planet if hasattr(helpers.GameTests, 'planet') else helpers.generate_planet()

    setUp = helpers.GameTests.setUp
    act = helpers.GameTests.act
    ok = helpers.GameTests.ok
    start = helpers.GameTests.start
    advance = helpers.GameTests.advance
    build = helpers.GameTests.build
    def test_starter_grant_once_and_team_pool(self):
        view = snapshot(self.context, self.world)
        view["payload"]["config"]["recipes"]["drill"]["iron"] = 999
        self.assertEqual(RECIPES["drill"]["iron"], 5)
        before = self.world.state.team_storage['team-a']
        self.world.enroll(self.context)
        self.assertEqual(before, self.world.state.team_storage['team-a'])
        self.world.enroll(Context('world-a', 'bob', 'team-a'))
        for resource, amount in STARTING_RESOURCES.items():
            self.assertEqual(self.world.state.team_storage['team-a'][resource], 2 * amount)

    def test_remove_refunds_paid_cost_and_stock_exactly_once(self):
        self.start()
        for kind in RECIPES:
            before = dict(self.world.state.team_storage['team-a'])
            building_id = self.build(kind)
            with self.world.transaction() as state:
                state.buildings[building_id].stock['copper'] = 3
            request = command('building.remove', building_id=building_id)
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: apply_command(self.context, request, self.world), range(4)))
            self.ok(results[0])
            self.assertTrue(all(r == results[0] for r in results))
            before['copper'] += 3
            self.assertEqual(self.world.state.team_storage['team-a'], before)
            self.assertEqual(self.world.state.buildings, {})

    def test_warehouse_capacity_and_overflow_refund(self):
        self.start()
        drill = self.build()
        cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
        warehouse = self.build('warehouse', cell)
        self.assertEqual(storage_capacity(self.world.state, 'team-a'), 500)
        with self.world.transaction() as state:
            pool = state.team_storage['team-a']
            pool['iron'] += 500 - sum(pool.values())
        self.advance(20)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 500)
        self.ok(self.act('building.remove', building_id=warehouse))
        self.assertEqual(storage_capacity(self.world.state, 'team-a'), 300)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 515)
        self.advance(40)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 515)
        self.assertEqual(sum(self.world.state.buildings[drill].stock.values()), 0)

    def test_water_drill_sustains_generator_and_cap_stops_consumption(self):
        self.start()
        neighbors = self.planet.cells[self.planet.landing_sites[0]].neighbors
        self.build('drill', neighbors[1])
        self.build('oxygen_generator', neighbors[0])
        with self.world.transaction() as state:
            state.team_storage['team-a']['water'] = 0
        self.advance(19)
        self.assertEqual(self.world.state.oxygen_percent, 0)
        self.advance(1)
        self.assertEqual(self.world.state.oxygen_percent, .1)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 0)
        with self.world.transaction() as state:
            state.oxygen_percent = 99.95
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, 100)
        self.advance(20)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 1)

    def test_respawn_uses_base_then_landing_after_demolition(self):
        self.start()
        base = self.build('dome_base')
        self.assertEqual(self.ok(self.act('player.respawn'))['building_id'], base)
        self.ok(self.act('building.remove', building_id=base))
        response = self.ok(self.act('player.respawn'))
        self.assertIsNone(response['building_id'])
        self.assertEqual(response['cell_id'], self.planet.landing_sites[0])

    def test_remove_rejects_distance_team_and_failed_commit(self):
        eve = Context('world-a', 'eve', 'team-b')
        self.world.enroll(eve)
        self.ok(self.act('landing.select', context=eve, cell_id=self.planet.landing_sites[1]))
        self.start()
        building = self.build()
        self.assertEqual(self.act('building.remove', context=eve, building_id=building)['payload']['code'], 'FORBIDDEN')
        with self.world.transaction() as state:
            state.players['alice'].position = self.planet.cells[self.planet.landing_sites[1]].center
        self.assertEqual(self.act('building.remove', building_id=building)['payload']['code'], 'OUT_OF_RANGE')
        with self.world.transaction() as state:
            state.players['alice'].position = self.planet.cells[self.planet.landing_sites[0]].center
        before = self.world.state
        def fail(_):
            raise OSError('disk failure')
        self.world._persist = fail
        with self.assertRaises(OSError):
            self.act('building.remove', building_id=building)
        self.assertEqual(before, self.world.state)

    def test_missing_sulfur_does_not_spend_iron(self):
        self.start()
        with self.world.transaction() as state:
            state.team_storage['team-a']['sulfur'] = 0
        before = self.world.state.team_storage
        self.assertEqual(self.act('building.place', building_type='warehouse',
            cell_id=self.planet.cells[self.planet.landing_sites[0]].neighbors[0])['payload']['code'], 'INSUFFICIENT_RESOURCES')
        self.assertEqual(before, self.world.state.team_storage)
        self.build('drill')

    def test_new_economy_roundtrip_and_legacy_refund(self):
        self.start()
        building = self.build('oxygen_generator')
        self.advance(25)
        restored = WorldState.from_dict(self.world.state.to_dict())
        self.assertEqual(restored, self.world.state)
        self.assertEqual(restored.oxygen_percent, .1)
        self.assertEqual(restored.buildings[building].production_ticks, 5)
        legacy = self.world.state.to_dict()
        legacy.pop('economy_version')
        legacy['buildings'][building].pop('paid_cost')
        legacy['players']['alice']['inventory'] = {'ore': 7}
        restored = WorldState.from_dict(legacy)
        self.world = UnitOfWork(self.planet, restored)
        before = restored.team_storage['team-a']['iron']
        self.ok(self.act('building.remove', building_id=building))
        self.assertEqual(self.world.state.team_storage['team-a']['iron'], before + 8)
