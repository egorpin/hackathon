"""Global energy, proportional production and save compatibility."""
import unittest

from app.game import WorldState, snapshot, step
from app.game.energy import energy_balance
from app.game.state import Building, RECIPES, RESOURCES, TICK_SECONDS
import test_game as helpers


class EnergyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planet = helpers.generate_planet()

    setUp = helpers.GameTests.setUp
    act = helpers.GameTests.act
    ok = helpers.GameTests.ok
    start = helpers.GameTests.start
    build = helpers.GameTests.build
    advance = helpers.GameTests.advance
    move_near = helpers.GameTests.move_near
    interact = helpers.GameTests.interact

    def test_solar_build_remove_and_no_resource_storage(self):
        self.start()
        before = self.world.state.team_storage['team-a']
        panel = self.build('solar_panel')
        self.assertEqual(energy_balance(self.world.state), {'production': 10, 'consumption': 0, 'efficiency': 1})
        for resource, price in RECIPES['solar_panel'].items():
            self.assertEqual(self.world.state.team_storage['team-a'][resource], before[resource] - price)
        view = snapshot(self.context, self.world)['payload']
        self.assertEqual(view['energy']['production'], 10)
        self.assertNotIn('stock', next(b for b in view['buildings'] if b['building_id'] == panel))
        for resource in ('iron', 'energy'):
            self.assertFalse(self.interact('resource.deposit', building_id=panel, resource=resource, amount=1)['payload']['ok'])
        self.ok(self.interact('building.remove', building_id=panel))
        self.assertEqual(self.world.state.team_storage['team-a'], before)
        self.assertEqual(energy_balance(self.world.state)['production'], 0)

    def test_no_energy_stops_production_but_simulation_keeps_ticking(self):
        self.start()
        drill = self.build()
        self.advance(40)
        self.assertEqual(self.world.state.buildings[drill].production_ticks, 0)
        self.assertEqual(sum(self.world.state.buildings[drill].stock.values()), 0)
        self.assertEqual(snapshot(self.context, self.world)['payload']['energy']['efficiency'], 0)
        self.assertEqual(self.world.state.tick, 40)

    def test_global_half_supply_slows_every_producer_and_recovers_without_reserve(self):
        state = WorldState('world-a', self.planet.version, stage='running')
        state.team_storage = {team: dict.fromkeys(RESOURCES, 0) for team in ('team-a', 'team-b')}
        cells = list(self.planet.cells.values())
        for i in range(8):
            kind = 'drill' if i < 4 else 'oxygen_generator'
            cell = next(c for c in cells if c.resource == 'iron') if kind == 'drill' else cells[i]
            state.buildings[str(i)] = Building(str(i), cell.cell_id, kind, 'team-a' if i % 2 else 'team-b', 'alice')
            state.buildings[str(i)].stock['water'] = 5 if kind == 'oxygen_generator' else 0
        state.buildings['solar'] = Building('solar', cells[-1].cell_id, 'solar_panel', 'team-a', 'alice')
        self.assertEqual(energy_balance(state)['efficiency'], .5)
        for _ in range(20):
            step(state, TICK_SECONDS, self.planet)
        self.assertTrue(all(b.production_ticks == 10 for key, b in state.buildings.items() if key != 'solar'))
        self.assertEqual(state.oxygen_percent, 0)
        restored = WorldState.from_dict(state.to_dict())
        self.assertEqual(restored, state)
        for _ in range(20):
            step(restored, TICK_SECONDS, self.planet)
        self.assertAlmostEqual(restored.oxygen_percent, .4)
        self.assertTrue(all(restored.buildings[str(i)].stock['iron'] == 1 for i in range(4)))
        del restored.buildings['solar']
        before = restored.oxygen_percent
        for _ in range(40):
            step(restored, TICK_SECONDS, self.planet)
        self.assertEqual(restored.oxygen_percent, before)
        restored.buildings['solar'] = state.buildings['solar']
        restored.buildings['extra'] = Building('extra', cells[-2].cell_id, 'solar_panel', 'team-b', 'alice')
        self.assertEqual(energy_balance(restored)['efficiency'], 1)
        for _ in range(20):
            step(restored, TICK_SECONDS, self.planet)
        self.assertAlmostEqual(restored.oxygen_percent, .8)

    def test_fractional_progress_survives_cycles_and_legacy_saves(self):
        state = WorldState('world-a', self.planet.version, stage='running')
        cell = next(c for c in self.planet.cells.values() if c.resource == 'iron')
        for i in range(6):
            state.buildings[str(i)] = Building(str(i), cell.cell_id, 'drill', 'team-a', 'alice')
        state.buildings['solar'] = Building('solar', cell.cell_id, 'solar_panel', 'team-a', 'alice')
        for _ in range(240):
            step(state, TICK_SECONDS, self.planet)
        self.assertEqual(state.buildings['0'].stock['iron'], 10)
        self.assertAlmostEqual(state.buildings['0'].production_ticks, 0, places=6)
        self.assertEqual(WorldState.from_dict(state.to_dict()), state)
        del state.buildings['solar']
        self.assertEqual(energy_balance(WorldState.from_dict(state.to_dict()))['production'], 0)
