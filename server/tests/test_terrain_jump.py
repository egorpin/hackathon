import unittest
import uuid
import math

from app.game import Context, UnitOfWork, WorldState, apply_command, step
from app.game.state import INPUT_TIMEOUT_TICKS, TICK_SECONDS
from app.world import generate_planet
from app.world.terrain import (DEFAULT_TERRAIN_SEED, ground_position, seed_from_world_id,
                               terrain_features, terrain_height)


class TerrainAndJumpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.planet = generate_planet()

    def setUp(self):
        self.context = Context('world', 'alice', 'team')
        self.world = UnitOfWork(self.planet, WorldState('world', self.planet.version))
        self.world.enroll(self.context)
        self.act('landing.select', cell_id=self.planet.landing_sites[0])
        self.act('world.start')

    def act(self, kind, **payload):
        return apply_command(self.context, {'type': kind, 'request_id': str(uuid.uuid4()), 'payload': payload}, self.world)

    def advance(self, ticks):
        with self.world.transaction() as state:
            for _ in range(ticks):
                step(state, TICK_SECONDS, self.planet)

    def test_server_terrain_reference_samples(self):
        samples = [
            ((1, 0, 0), 0.1286716363369052),
            ((0, 1, 0), 0.02116018504766136),
            ((0, 0, 1), 0.022613102430665194),
            ((.3, .4, .5), 0.12055212633029176),
            ((-.8, .1, .2), -0.4916172493828303),
        ]
        for point, expected in samples:
            self.assertAlmostEqual(terrain_height(point, DEFAULT_TERRAIN_SEED), expected, places=12)
            projected = ground_position(point, 30, seed=DEFAULT_TERRAIN_SEED)
            self.assertAlmostEqual(sum(x*x for x in projected) ** .5, 30 + expected)

    def test_world_seed_is_stable_and_changes_feature_layout(self):
        seed = seed_from_world_id('demo-world')
        self.assertEqual(seed, seed_from_world_id('demo-world'))
        self.assertNotEqual(seed, seed_from_world_id('other-world'))
        self.assertNotEqual(terrain_features(seed), terrain_features(seed_from_world_id('other-world')))

    def test_seeded_terrain_matches_javascript(self):
        import json
        import subprocess
        from pathlib import Path
        seed = seed_from_world_id('demo-world')
        points = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [.3, .4, .5], [-.8, .1, .2]]
        script = ("import {configureTerrain,terrainHeight} from './client/src/scene/terrain.js';"
                  f"configureTerrain({seed});console.log(JSON.stringify({json.dumps(points)}.map(p=>terrainHeight(...p))));")
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parents[2],
                                text=True, capture_output=True, check=True)
        browser = json.loads(result.stdout)
        server = [terrain_height(point, seed) for point in points]
        for left, right in zip(browser, server):
            self.assertAlmostEqual(left, right, places=12)

    def test_terrain_relief_stays_shallow_and_gently_sloped(self):
        count, step = 1000, .004
        golden = (5 ** .5 - 1) / 2
        max_height = max_slope = 0
        for i in range(count):
            y = 1 - 2 * (i + .5) / count
            r, angle = (1 - y*y) ** .5, 2 * math.pi * i * golden
            x, z = r * math.cos(angle), r * math.sin(angle)
            height = terrain_height((x, y, z), seed_from_world_id('world'))
            x2 = x * math.cos(step) + z * math.sin(step)
            z2 = -x * math.sin(step) + z * math.cos(step)
            max_height = max(max_height, abs(height))
            max_slope = max(max_slope, abs(terrain_height((x2, y, z2), seed_from_world_id('world')) - height) / (20 * step))
        self.assertLess(max_height, 3.0)
        self.assertLess(max_slope, .85)

    def test_jump_validates_flags_and_lands_after_input_timeout(self):
        invalid = {'type': 'player.input', 'payload': {'seq': 1, 'move': [0, 0, 0], 'jump': 1}}
        self.assertEqual(apply_command(self.context, invalid, self.world)['payload']['code'], 'INVALID_ARGUMENT')
        player = self.world.state.players['alice']
        self.assertEqual(player.seq, -1)
        request = {'type': 'player.input', 'payload': {'seq': 1, 'move': [0, 0, 0], 'jump': True}}
        self.assertTrue(apply_command(self.context, request, self.world)['payload']['ok'])
        self.advance(1)
        self.assertGreater(self.world.state.players['alice'].altitude, 0)
        with self.world.transaction() as state:
            state.players['alice'].input_tick = state.tick - INPUT_TIMEOUT_TICKS - 1
        self.advance(60)
        player = self.world.state.players['alice']
        self.assertEqual(player.altitude, 0)
        self.assertEqual(player.vertical_speed, 0)

    def test_held_jump_does_not_retrigger_until_release(self):
        for seq, jump in ((1, True), (2, True)):
            request = {'type': 'player.input', 'payload': {'seq': seq, 'move': [0, 0, 0], 'jump': jump}}
            self.assertTrue(apply_command(self.context, request, self.world)['payload']['ok'])
            self.advance(1)
        self.assertFalse(self.world.state.players['alice'].jump_pending)
