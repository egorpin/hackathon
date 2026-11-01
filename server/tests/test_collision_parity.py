"""Exercise the browser and authoritative solver on identical multi-frame paths."""
import json
from pathlib import Path
import subprocess
import unittest

from app.game.collision import resolve_player_motion
from app.world.geometry import unit, scale


class CollisionParityTests(unittest.TestCase):
    def test_browser_matches_server_trajectories(self):
        cases = []
        shapes = [
            dict(building_id="base", surface_id="foundation", center=[0,30,0], radius=1.05, bottom=30, top=30.12),
            dict(building_id="base", surface_id="body", center=[0,30,0], radius=.68, bottom=30.12, top=30.75),
        ]
        for start, velocity, move, slope in [
            ([0,30,2],0,[0,0,-1],False),
            ([.7,30,2],0,[0,0,-1],False),
            ([0,30,2],4.8,[0,0,-1],False),
            ([0,30,0],0,[0,0,1],False),
            ([.7,30,2],0,[0,0,-1],True),
        ]:
            ground = lambda p: 30 + (.15 * unit(p)[2] if slope else 0)
            cases.append(dict(position=scale(unit(start),ground(start)),verticalSpeed=velocity,
                              move=move,slope=slope,shapes=shapes))
        box_shapes = [
            dict(building_id="base", surface_id="foundation", kind="box", center=[0,30,0],
                 axis_x=[1,0,0],axis_z=[0,0,1],half_x=.95,half_z=.65,bottom=30,top=30.12),
            dict(building_id="base", surface_id="body", kind="box", center=[0,30,0],
                 axis_x=[1,0,0],axis_z=[0,0,1],half_x=.4,half_z=.3,bottom=30.12,top=30.8),
        ]
        for x in [0,.5,1.05,1.3]:
            cases.append(dict(position=scale(unit([x,30,2]),30),verticalSpeed=0,
                              move=[0,0,-1],slope=False,shapes=box_shapes))
        rotated = [{**shape,"axis_x":[2**-.5,0,2**-.5],"axis_z":[-2**-.5,0,2**-.5]} for shape in box_shapes]
        cases.append(dict(position=scale(unit([.7,30,2]),30),verticalSpeed=0,
                          move=[0,0,-1],slope=False,shapes=rotated))
        script = """
import * as THREE from './client/node_modules/three/build/three.module.js';
import {resolveBuildingMotion} from './client/src/scene/building-collision.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
const outputs=JSON.parse(input).map(c=>{
 const ground=p=>30+(c.slope ? .15*p.clone().normalize().z : 0);
 let position=new THREE.Vector3().fromArray(c.position),altitude=0,verticalSpeed=c.verticalSpeed;
 let supportBuildingId=null,supportSurfaceId=null;
 const frames=[];
 for(let i=0;i<60;i++){
   const move=new THREE.Vector3().fromArray(i<25?c.move:[0,0,0]);
   const r=resolveBuildingMotion(position,altitude,verticalSpeed,move,.2,.05,30,ground,c.shapes,
     {grounded:altitude<=1e-5||supportBuildingId!==null,supportBuildingId,supportSurfaceId});
   ({position,altitude,verticalSpeed,supportBuildingId,supportSurfaceId}=r);
   frames.push([position.toArray(),altitude,verticalSpeed,supportBuildingId,supportSurfaceId]);
 }
 return frames;
});
console.log(JSON.stringify(outputs));
"""
        run = subprocess.run(['node','--input-type=module','-e',script],
            input=json.dumps(cases),text=True,capture_output=True,
            cwd=Path(__file__).resolve().parents[2],check=True)
        browser=json.loads(run.stdout)
        for case_index,case in enumerate(cases):
            position=case['position'];altitude=0.;speed=case['verticalSpeed'];building=surface=None
            ground=lambda p:30+(.15*unit(p)[2] if case['slope'] else 0)
            for frame in range(60):
                position,altitude,speed,building,surface=resolve_player_motion(
                    position,altitude,speed,case['move'] if frame<25 else [0,0,0],.2,.05,30,ground,case['shapes'],
                    grounded=altitude<=1e-5 or building is not None,
                    support_building_id=building,support_surface_id=surface)
                expected=browser[case_index][frame]
                with self.subTest(case=case_index,frame=frame):
                    for a,b in zip([*position,altitude,speed],[*expected[0],expected[1],expected[2]]):
                        self.assertAlmostEqual(a,b,places=7)
                    self.assertEqual([building,surface],expected[3:])
