import math
import unittest

from app.game.collision import resolve_player_motion


class PlayerCollisionTests(unittest.TestCase):
    radius = 30.
    center = (30., 0., 0.)
    ground = lambda self, _point: self.radius

    def point(self, distance):
        angle = distance / self.radius
        return (self.radius * math.cos(angle), self.radius * math.sin(angle), 0.)

    def shape(self, radius, bottom=30., top=31., sid="body"):
        return {"building_id": "b", "surface_id": sid, "center": self.center,
                "radius": radius, "bottom": bottom, "top": top}

    def advance(self, point, altitude=0., vertical_speed=0., move=(0., -1., 0.), distance=.2,
                shapes=None, grounded=True, **options):
        return resolve_player_motion(point, altitude, vertical_speed, move, distance, .05,
                                     self.radius, self.ground, shapes or [], grounded=grounded,
                                     **options)

    def test_wall_blocks_and_slides_along_band(self):
        wall = self.shape(.8, 30., 31.)
        point = self.point(2.)
        for _ in range(12):
            point, altitude, speed, support, surface = self.advance(
                point, move=(0., -1., 0.), distance=.2, shapes=[wall], grounded=False)
        self.assertGreaterEqual(self.radius * math.atan2(point[1], point[0]), 1.0 - .01)
        self.assertIsNone(support)

    def test_wall_slide_preserves_tangential_motion(self):
        wall = self.shape(.8, 30., 31.)
        point = self.point(1.3)
        start_z = point[2]
        for _ in range(5):
            point, altitude, speed, support, surface = self.advance(
                point, move=(0., -1., 1.), distance=.2, shapes=[wall], grounded=False)
        self.assertGreater(point[2], start_z + .2)
        self.assertGreaterEqual(self.radius * math.acos(point[0] / self.radius), .95)

    def test_grounded_player_steps_only_on_low_band(self):
        curb = self.shape(1., 30., 30.12, "foundation")
        result = self.advance(self.point(1.4), distance=.3, shapes=[curb])
        point, altitude, speed, support, surface = result
        self.assertAlmostEqual(altitude, .12, places=5)
        self.assertEqual((support, surface), ("b", "foundation"))

        tall = self.shape(1., 30., 30.5)
        blocked = self.advance(self.point(1.4), distance=.3, shapes=[tall])
        distance = self.radius * math.atan2(blocked[0][1], blocked[0][0])
        self.assertGreaterEqual(distance, 1.19)
        self.assertLess(distance, 1.3)
        self.assertEqual(blocked[1], 0.)

    def test_jump_can_clear_wall_and_descending_lands_on_top(self):
        roof = self.shape(.8, 30., 30.8)
        point, altitude, speed = self.point(0.), 1., -2.
        support = surface = None
        for _ in range(20):
            point, altitude, speed, support, surface = self.advance(
                point, altitude, speed, move=(0., 0., 0.), distance=0.,
                shapes=[roof], grounded=False)
            if support:
                break
        self.assertEqual((support, surface), ("b", "body"))
        self.assertAlmostEqual(altitude, .8, places=5)
        self.assertEqual(speed, 0.)

    def test_leaving_or_removing_support_clears_contact_and_falls(self):
        foundation = self.shape(1., 30., 30.12, "foundation")
        point, altitude, speed, support, surface = self.advance(
            self.point(.8), .12, 0., move=(0., 1., 0.), distance=.5,
            shapes=[foundation], grounded=True, support_building_id="b",
            support_surface_id="foundation")
        self.assertIsNone(support)
        _, altitude, speed, support, surface = self.advance(
            point, altitude, speed, move=(0., 0., 0.), distance=0.,
            shapes=[], grounded=False, support_building_id="b",
            support_surface_id="foundation")
        self.assertLess(altitude, .12)
        self.assertLess(speed, 0.)
        self.assertIsNone(support)

    def test_initial_penetration_can_move_outward(self):
        wall = self.shape(.8, 30., 31.)
        point, altitude, speed, support, surface = self.advance(
            self.point(.2), .7, 0., move=(0., 1., 0.), distance=.2,
            shapes=[wall], grounded=False)
        self.assertGreater(self.radius * math.atan2(point[1], point[0]), .2)

    def test_diagonal_motion_slides_without_entering_wall(self):
        wall=self.shape(.8,30.,31.)
        start=self.point(1.02)
        point, *_=self.advance(start,move=(0.,-.7,.7),distance=.3,shapes=[wall])
        from app.world.geometry import surface_distance
        self.assertGreater(point[2],.1)
        self.assertGreaterEqual(surface_distance(point,self.center,30.),1.-1e-5)

    def test_low_step_is_rejected_when_headroom_is_too_small(self):
        curb=self.shape(1.,30.,30.12,'foundation')
        ceiling=self.shape(1.,30.65,31.,'ceiling')
        point,altitude,_,support,_=self.advance(self.point(1.4),distance=.4,shapes=[curb,ceiling])
        self.assertEqual(altitude,0.)
        self.assertIsNone(support)
        self.assertGreaterEqual(30*math.atan2(point[1],point[0]),1.19)

    def test_jump_stops_at_underside_of_overhang(self):
        ceiling=self.shape(1.,30.8,31.,'ceiling')
        _,altitude,speed,_,_=self.advance(self.point(0.),0.,4.8,move=(0.,0.,0.),
                                        distance=0.,shapes=[ceiling],grounded=False)
        self.assertAlmostEqual(altitude,.2,places=6)
        self.assertEqual(speed,0.)

    def test_models_publish_six_parts_and_rectangular_concrete(self):
        from app.game.collision import collision_shapes
        from app.world.terrain import seed_from_world_id
        for kind in ['drill','dome_base','warehouse','oxygen_generator','solar_panel','wind_turbine']:
            with self.subTest(kind=kind):
                shapes=collision_shapes(kind,self.center,30.,seed_from_world_id('profiles'))
                self.assertEqual(len(shapes),6)
                self.assertEqual(len({s['id'] for s in shapes}),6)
                for shape in shapes:
                    self.assertGreater(shape['top'],shape['bottom'])
                    self.assertTrue(all(math.isfinite(x) for x in shape['center']))
                if kind!='drill':
                    foundation=next(s for s in shapes if s['id']=='foundation')
                    self.assertEqual(foundation['kind'],'box')
                    self.assertGreater(foundation['half_x'],0)
                    self.assertGreater(foundation['half_z'],0)


if __name__ == "__main__":
    unittest.main()
