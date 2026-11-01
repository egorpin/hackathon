import uuid
import unittest

from app.game import Context, UnitOfWork, WorldState, apply_command, step
from app.game.state import (GRAVITY, JUMP_SPEED, TICK_SECONDS, Building)
from app.world import generate_planet, move_on_surface, surface_distance
from app.world.geometry import cross, unit
from app.world.terrain import ground_position, seed_from_world_id


class BuildingCollisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planet = generate_planet()

    def setUp(self):
        self.context = Context('roof-world', 'alice', 'team-a')
        self.world = UnitOfWork(self.planet, WorldState('roof-world', self.planet.version))
        self.world.enroll(self.context)
        self.assertTrue(self.command('landing.select', cell_id=self.planet.landing_sites[0])['payload']['ok'])
        self.assertTrue(self.command('world.start')['payload']['ok'])
        self.building = next(b for b in self.world.state.buildings.values() if b.building_type == 'dome_base')
        self.center = self.planet.cells[self.building.cell_id].center
        self.seed = seed_from_world_id('roof-world')
        self.seq = 0

    def command(self, kind, **payload):
        return apply_command(self.context, {
            'type': kind, 'request_id': str(uuid.uuid4()), 'payload': payload,
        }, self.world)

    def input(self, move=(0., 0., 0.), jump=False):
        self.seq += 1
        return apply_command(self.context, {
            'type': 'player.input', 'payload': {
                'seq': self.seq, 'move': move, 'jump': jump,
            },
        }, self.world)

    def tick(self):
        with self.world.transaction() as state:
            step(state, TICK_SECONDS, self.planet)

    def place_player(self, distance):
        east = unit(cross(self.center, self.planet.cells[self.building.cell_id].vertices[0]))
        pos = move_on_surface(self.center, east, distance, self.planet.radius)
        with self.world.transaction() as state:
            state.players['alice'].position = ground_position(pos, self.planet.radius, seed=self.seed)
        return tuple(-value for value in east)

    def test_walk_climbs_dome_tiers(self):
        inward = self.place_player(2.)
        for _ in range(10):
            self.input(inward)
            self.tick()
        player = self.world.state.players['alice']
        self.assertAlmostEqual(player.altitude, .68828, delta=.02)
        self.assertEqual(player.support_building_id, self.building.building_id)
        self.assertEqual(player.support_surface_id, 'dome_crown')
        self.assertEqual(player.roof_building_id, self.building.building_id)
        self.assertLess(surface_distance(player.position, self.center, self.planet.radius), .1)

    def test_jump_clears_building_and_lands_on_its_roof(self):
        inward = self.place_player(2.)
        for index in range(45):
            self.input(inward if index < 10 else (0., 0., 0.), jump=index == 0)
            self.tick()
        player = self.world.state.players['alice']
        self.assertGreater(player.altitude, .65)
        self.assertEqual(player.vertical_speed, 0.)
        self.assertEqual(player.roof_building_id, self.building.building_id)
        self.assertEqual(player.support_building_id, self.building.building_id)
        self.assertEqual(player.support_surface_id, 'dome_crown')

    def test_old_roof_contact_falls_and_cannot_jump_in_air(self):
        self.place_player(0.)
        with self.world.transaction() as state:
            player = state.players['alice']
            player.altitude = 1.
            player.vertical_speed = 0.
            player.roof_building_id = self.building.building_id
            player.support_building_id = self.building.building_id
            player.support_surface_id = 'roof'
        self.input(jump=True)
        self.tick()
        player = self.world.state.players['alice']
        self.assertLess(player.altitude, 1.)
        self.assertLess(player.vertical_speed, 0.)
        self.assertIsNone(player.roof_building_id)
        self.assertIsNone(player.support_building_id)
        self.assertIsNone(player.support_surface_id)

    def test_jump_from_a_valid_foundation_support(self):
        east = unit(cross(self.center, self.planet.cells[self.building.cell_id].vertices[0]))
        point = move_on_surface(self.center, east, 1., self.planet.radius)
        with self.world.transaction() as state:
            player = state.players['alice']
            player.position = ground_position(point, self.planet.radius, .12, self.seed)
            player.altitude = .12
            player.support_building_id = self.building.building_id
            player.support_surface_id = 'foundation'
        self.input(jump=True)
        self.tick()
        player = self.world.state.players['alice']
        self.assertGreater(player.altitude, .12)
        self.assertGreater(player.vertical_speed, 0.)
        self.assertIsNone(player.support_building_id)

    def test_removing_supported_building_clears_contact_and_player_falls(self):
        cell = next(self.planet.cells[cell_id] for cell_id in self.planet.cells[self.building.cell_id].neighbors
                    if self.planet.cells[cell_id].buildable)
        support = Building('warehouse-support', cell.cell_id, 'warehouse', 'team-a', 'alice')
        with self.world.transaction() as state:
            state.buildings[support.building_id] = support
            player = state.players['alice']
            player.position = ground_position(cell.center, self.planet.radius, .12, self.seed)
            player.altitude = .12
            player.support_building_id = support.building_id
            player.support_surface_id = 'foundation'
            player.roof_building_id = support.building_id
        self.assertTrue(self.command('building.remove', building_id=support.building_id)['payload']['ok'])
        player = self.world.state.players['alice']
        self.assertIsNone(player.support_building_id)
        self.assertIsNone(player.support_surface_id)
        self.assertIsNone(player.roof_building_id)
        self.tick()
        self.assertLess(self.world.state.players['alice'].altitude, .12)

    def test_snapshot_publishes_collision_bands_and_capsule_config(self):
        from app.game.simulation import snapshot
        payload = snapshot(self.context, self.world)['payload']
        building = next(item for item in payload['buildings'] if item['building_id'] == self.building.building_id)
        self.assertEqual(len(building['collision_shapes']), 6)
        self.assertEqual(building['collision_shapes'][0]['kind'], 'box')
        self.assertEqual(sum(shape['kind'] == 'cylinder' for shape in building['collision_shapes']), 3)
        self.assertTrue(all('center' in shape and 'bottom' in shape and 'top' in shape
                            for shape in building['collision_shapes']))
        self.assertEqual(payload['config']['player_height'], .6)
        self.assertEqual(payload['config']['step_height'], .3)
        self.assertEqual(payload['config']['jump_speed'], JUMP_SPEED)
        self.assertEqual(payload['config']['gravity'], GRAVITY)


if __name__ == '__main__':
    unittest.main()
