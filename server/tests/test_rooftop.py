import uuid
import unittest

from app.game import Context, UnitOfWork, WorldState, apply_command, step
from app.game.state import (GRAVITY, JUMP_SPEED, TICK_SECONDS)
from app.world import generate_planet, move_on_surface, surface_distance
from app.world.geometry import cross, unit
from app.world.terrain import ground_position, seed_from_world_id


class UnobstructedMovementTests(unittest.TestCase):
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

    def test_walk_passes_through_building_without_stepping(self):
        inward = self.place_player(2.)
        for _ in range(10):
            self.input(inward)
            self.tick()
            player = self.world.state.players['alice']
            self.assertEqual(player.altitude, 0.)
            self.assertIsNone(player.support_building_id)
            self.assertIsNone(player.support_surface_id)
            self.assertIsNone(player.roof_building_id)
        self.assertLess(surface_distance(player.position, self.center, self.planet.radius), .01)

    def test_jump_over_building_lands_on_terrain(self):
        inward = self.place_player(2.)
        for index in range(45):
            self.input(inward if index < 10 else (0., 0., 0.), jump=index == 0)
            self.tick()
        player = self.world.state.players['alice']
        self.assertEqual(player.altitude, 0.)
        self.assertEqual(player.vertical_speed, 0.)
        self.assertIsNone(player.roof_building_id)
        self.assertIsNone(player.support_building_id)

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

    def test_snapshot_has_no_building_contacts_or_steps(self):
        from app.game.simulation import snapshot
        payload = snapshot(self.context, self.world)['payload']
        building = next(item for item in payload['buildings'] if item['building_id'] == self.building.building_id)
        for field in ('collision_profile', 'collision_supports', 'collision_roof_radius'):
            self.assertNotIn(field, building)
        self.assertNotIn('step_height', payload['config'])
        self.assertNotIn('building_roof_radius', payload['config'])
        self.assertEqual(payload['config']['jump_speed'], JUMP_SPEED)
        self.assertEqual(payload['config']['gravity'], GRAVITY)


if __name__ == '__main__':
    unittest.main()
