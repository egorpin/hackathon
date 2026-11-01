"""Economy invariants: conservation, ownership, retries and persisted progress."""
from concurrent.futures import ThreadPoolExecutor

from app.game import Context, UnitOfWork, WorldState, apply_command, snapshot
from app.game.state import Building, RECIPES, STARTING_RESOURCES, storage_capacity
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
    supply_energy = helpers.GameTests.supply_energy
    advance = helpers.GameTests.advance
    build = helpers.GameTests.build
    _ensure_builder_clearance = helpers.GameTests._ensure_builder_clearance
    move_near = helpers.GameTests.move_near
    interact = helpers.GameTests.interact
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

    def test_all_placed_buildings_have_authoritative_plan_and_construction_schedule(self):
        self.start()
        state = self.world.state
        cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
        # The demo's starter pool does not contain copper; seed enough to cover
        # the two new recipes while keeping placement and charging authoritative.
        with self.world.transaction() as draft:
            draft.team_storage['team-a']['copper'] = 20
        panel_id = self.build('solar_panel', cell, complete=False)
        state = self.world.state
        panel = state.buildings[panel_id]
        self.assertEqual((panel.construction_status, panel.construction_progress, panel.construction_required),
                         ('planned', 0, 60))
        view = snapshot(self.context, self.world)['payload']
        panel_view = next(building for building in view['buildings'] if building['building_id'] == panel_id)
        self.assertEqual(panel_view['construction_status'], 'planned')
        self.assertEqual(view['energy']['production'], 0)
        self.assertNotIn('energy', panel_view)
        self.assertEqual(view['config']['energy_output'], {'solar_panel': 10, 'wind_turbine': 10})

        self.advance(159)
        self.assertEqual(self.world.state.buildings[panel_id].construction_status, 'planned')
        self.advance(1)
        self.assertEqual(self.world.state.buildings[panel_id].construction_status, 'building')
        self.assertEqual(self.world.state.buildings[panel_id].construction_progress, 0)
        self.advance(60)
        self.assertEqual(self.world.state.buildings[panel_id].construction_status, 'completed')
        self.assertEqual(self.world.state.buildings[panel_id].construction_progress, 60)

        turbine_id = self.build('wind_turbine', self.planet.cells[self.planet.landing_sites[0]].neighbors[2], complete=False)
        self.assertEqual(self.world.state.buildings[turbine_id].construction_status, 'planned')
        self.assertEqual(snapshot(self.context, self.world)['payload']['energy']['production'], 10)
        self.advance(400)
        view = snapshot(self.context, self.world)['payload']
        self.assertEqual(view['energy']['production'], 20)
        turbine_view = next(b for b in view['buildings'] if b['building_id'] == turbine_id)
        self.assertNotIn('stock', turbine_view)
        self.assertEqual(turbine_view['efficiency'], 1)
        self.ok(self.interact('building.remove', building_id=turbine_id))
        self.assertEqual(snapshot(self.context, self.world)['payload']['energy']['production'], 10)

        # Drill, warehouse and oxygen generator use the exact same schedule;
        # all player-placeable types therefore drive the same plan/robot UI.
        for kind in ('drill', 'warehouse', 'oxygen_generator'):
            fresh = UnitOfWork(self.planet, WorldState(f'construction-{kind}', self.planet.version))
            context = Context(f'construction-{kind}', 'alice', 'team-a')
            fresh.enroll(context)
            self.ok(apply_command(context, command('landing.select', cell_id=self.planet.landing_sites[0]), fresh))
            self.ok(apply_command(context, command('world.start'), fresh))
            target = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
            placed = apply_command(context, command('building.place', cell_id=target, building_type=kind), fresh)
            self.ok(placed)
            item = fresh.state.buildings[placed['payload']['building_id']]
            self.assertEqual((item.construction_status, item.construction_progress), ('planned', 0))

    def test_construction_state_survives_save_reload_and_legacy_buildings_are_complete(self):
        saved = {}
        persistent = UnitOfWork(self.planet, WorldState('persisted-world', self.planet.version),
                                persist=lambda state: saved.update(data=state.to_dict()))
        context = Context('persisted-world', 'alice', 'team-a')
        persistent.enroll(context)
        self.ok(apply_command(context, command('landing.select', cell_id=self.planet.landing_sites[0]), persistent))
        self.ok(apply_command(context, command('world.start'), persistent))
        cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
        with persistent.transaction() as state:
            state.team_storage['team-a']['copper'] = 4
        placed = apply_command(context, command('building.place', cell_id=cell, building_type='solar_panel'), persistent)
        self.ok(placed)
        building_id = placed['payload']['building_id']
        with persistent.transaction() as state:
            for _ in range(200):
                helpers.step(state, helpers.TICK_SECONDS, self.planet)
        restored = UnitOfWork(self.planet, WorldState.from_dict(saved['data']))
        restored_building = restored.state.buildings[building_id]
        self.assertEqual((restored_building.construction_status, restored_building.construction_progress),
                         ('building', 40))

        # Records from before construction fields existed deserialize as built.
        legacy = Building('legacy', cell, 'warehouse', 'team-a', 'alice')
        self.assertEqual(legacy.construction_status, 'completed')
        self.assertFalse(any('energy' in field for field in vars(legacy)))

    def test_remove_refunds_paid_cost_and_stock_exactly_once(self):
        self.start()
        for kind in (kind for kind in RECIPES if kind != 'dome_base'):
            before = dict(self.world.state.team_storage['team-a'])
            building_id = self.build(kind)
            with self.world.transaction() as state:
                state.buildings[building_id].stock['copper'] = 3
            self.move_near(building_id)
            request = command('building.remove', building_id=building_id)
            with ThreadPoolExecutor(max_workers=4) as pool:
                results = list(pool.map(lambda _: apply_command(self.context, request, self.world), range(4)))
            self.ok(results[0])
            self.assertTrue(all(r == results[0] for r in results))
            before['copper'] += 3
            self.assertEqual(self.world.state.team_storage['team-a'], before)
            self.assertEqual([b.building_type for b in self.world.state.buildings.values()], ['dome_base'])

    def test_warehouse_capacity_and_overflow_refund(self):
        self.start()
        self.supply_energy()
        drill = self.build()
        cell = self.planet.cells[self.planet.landing_sites[0]].neighbors[1]
        warehouse = self.build('warehouse', cell)
        self.assertEqual(storage_capacity(self.world.state, 'team-a'), 500)
        with self.world.transaction() as state:
            pool = state.team_storage['team-a']
            pool['iron'] += 500 - sum(pool.values())
        self.advance(20)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 500)
        self.ok(self.interact('building.remove', building_id=warehouse))
        self.assertEqual(storage_capacity(self.world.state, 'team-a'), 300)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 515)
        self.advance(40)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 515)
        self.assertEqual(sum(self.world.state.buildings[drill].stock.values()), 3)
        self.advance(1200)
        self.assertEqual(sum(self.world.state.buildings[drill].stock.values()), 50)
        self.assertEqual(sum(self.world.state.team_storage['team-a'].values()), 515)

    def test_manual_water_delivery_to_generator_and_cap_stops_consumption(self):
        self.start()
        self.supply_energy()
        neighbors = self.planet.cells[self.planet.landing_sites[0]].neighbors
        drill = self.build('drill', neighbors[1])
        generator = self.build('oxygen_generator', neighbors[0])
        with self.world.transaction() as state:
            state.team_storage['team-a']['water'] = 0
        self.advance(19)
        self.assertEqual(self.world.state.oxygen_percent, 0)
        self.advance(1)
        self.assertEqual(self.world.state.oxygen_percent, 0)
        self.assertEqual(self.world.state.buildings[drill].stock['water'], 1)
        self.ok(self.interact('resource.pickup', building_id=drill, resource='water', amount=1))
        self.ok(self.interact('resource.deposit', building_id=generator, resource='water', amount=1))
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, .2)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 0)
        self.ok(self.interact('resource.pickup', building_id=drill, resource='water', amount=1))
        self.ok(self.interact('resource.deposit', building_id=generator, resource='water', amount=1))
        with self.world.transaction() as state:
            state.oxygen_percent = 99.95
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, 100)
        self.ok(self.interact('resource.pickup', building_id=drill, resource='water', amount=1))
        self.ok(self.interact('resource.deposit', building_id=generator, resource='water', amount=1))
        self.advance(20)
        self.assertEqual(self.world.state.buildings[generator].stock['water'], 1)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 0)

    def test_respawn_uses_protected_start_base(self):
        self.start()
        base = next(b.building_id for b in self.world.state.buildings.values() if b.building_type == 'dome_base')
        self.assertEqual(self.ok(self.act('player.respawn'))['building_id'], base)
        self.assertEqual(self.interact('building.remove', building_id=base)['payload']['code'], 'FORBIDDEN')

    def test_warehouse_supplies_only_adjacent_allied_generator_missing_water(self):
        self.start()
        self.supply_energy()
        neighbors = self.planet.cells[self.planet.landing_sites[0]].neighbors
        drill_cell = next(cell for cell in neighbors if self.planet.cells[cell].resource == 'water')
        drill = self.build('drill', drill_cell)
        warehouse_cell = next(cell for cell in neighbors if cell != drill_cell)
        warehouse = self.build('warehouse', warehouse_cell)
        generator_cell = next(cell for cell in neighbors if cell != drill_cell
                              and cell in self.planet.cells[warehouse_cell].neighbors)
        generator = self.build('oxygen_generator', generator_cell)
        with self.world.transaction() as state:
            state.team_storage['team-a']['water'] = 0
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, 0)
        self.ok(self.interact('resource.pickup', building_id=drill, resource='water', amount=1))
        self.ok(self.interact('resource.deposit', building_id=warehouse, resource='water', amount=1))
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, .2)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 0)
        self.assertEqual(self.world.state.buildings[generator].stock['water'], 0)
        with self.world.transaction() as state:
            state.team_storage['team-a']['water'] = 4
            state.buildings[generator].stock['water'] = 1
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, .4)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 4)
        # Team resources alone cannot feed a distant generator.
        with self.world.transaction() as state:
            state.buildings[warehouse].cell_id = next(cell.cell_id for cell in self.planet.cells.values()
                if cell.buildable and cell.cell_id not in self.planet.cells[generator_cell].neighbors
                and cell.cell_id not in (drill_cell, generator_cell))
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, .4)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 4)
        # A neighboring enemy warehouse never supplies this team's generator.
        with self.world.transaction() as state:
            state.buildings[warehouse].cell_id = warehouse_cell
            state.buildings[warehouse].team_id = 'team-b'
        self.advance(20)
        self.assertEqual(self.world.state.oxygen_percent, .4)
        with self.world.transaction() as state:
            state.buildings[warehouse].team_id = 'team-a'
            state.oxygen_percent = 100
        self.advance(20)
        self.assertEqual(self.world.state.team_storage['team-a']['water'], 4)
        self.assertEqual(self.world.state.buildings[generator].stock['water'], 0)
        config = snapshot(self.context, self.world)['payload']['config']
        self.assertFalse(config['drill_auto_transfer'])
        self.assertEqual(config['warehouse_supply'], 'neighbors')
        self.assertEqual(config['oxygen_inputs'], {'water': 1})

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
        self.move_near(building)
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
        self.supply_energy()
        building = self.build('oxygen_generator')
        with self.world.transaction() as state:
            state.buildings[building].stock['water'] = 1
        self.advance(25)
        restored = WorldState.from_dict(self.world.state.to_dict())
        self.assertEqual(restored, self.world.state)
        self.assertEqual(restored.oxygen_percent, .2)
        self.assertEqual(restored.buildings[building].production_ticks, 5)
        legacy = self.world.state.to_dict()
        legacy.pop('economy_version')
        legacy['buildings'].pop('test-solar', None)
        legacy['buildings'][building].pop('paid_cost')
        legacy['players']['alice']['inventory'] = {'ore': 7}
        restored = WorldState.from_dict(legacy)
        self.world = UnitOfWork(self.planet, restored)
        before = restored.team_storage['team-a']['iron']
        self.ok(self.interact('building.remove', building_id=building))
        self.assertEqual(self.world.state.team_storage['team-a']['iron'], before + 8)

    def test_legacy_building_ore_migrates_before_delivery_or_refund(self):
        self.start()
        building = self.build('drill')
        legacy = self.world.state.to_dict()
        legacy.pop('economy_version')
        legacy['buildings'].pop('test-solar', None)
        legacy['buildings'][building].pop('paid_cost')
        legacy['buildings'][building]['stock'] = {'ore': 8, 'iron': 2}
        restored = WorldState.from_dict(legacy)
        self.assertEqual(restored.buildings[building].stock['iron'], 10)
        self.assertEqual(restored.buildings[building].stock['ore'], 0)
        self.assertEqual(WorldState.from_dict(restored.to_dict()), restored)
        self.world = UnitOfWork(self.planet, restored)
        before = restored.team_storage['team-a']['iron']
        self.ok(self.interact('building.remove', building_id=building))
        self.assertEqual(self.world.state.team_storage['team-a']['iron'], before + 15)
        self.assertEqual(self.world.state.team_storage['team-a']['ore'], 0)
