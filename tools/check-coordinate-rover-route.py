"""Offline deterministic physical route search; no live DB or network.
Buildings are seeded solely in this test world; movement and transfers use the real tick.
"""
import copy, json, math, sys, uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'server'))
from app.game import Context, UnitOfWork, WorldState, apply_command
from app.game.state import Building, TICK_SECONDS
from app.game.rover import coordinates, parse, step_rovers
from app.world.geometry import generate_planet, move_on_surface, unit, add, scale, dot, surface_distance

def command(w,c,k,**payload):
    return apply_command(c,{'type':k,'request_id':str(uuid.uuid4()),'payload':payload},w)['payload']
p=generate_planet(); c=Context('qa-world','qa-user','qa-team'); w=UnitOfWork(p,WorldState(c.world_id,p.version)); w.enroll(c)
assert command(w,c,'landing.select',cell_id=p.landing_sites[0])['ok']; assert command(w,c,'world.start')['ok']
base=w.state; office=next(iter(base.buildings.values())); neighbors=p.cells[office.cell_id].neighbors
sources=[x for x in neighbors if p.cells[x].resource in ('iron','copper','water','sulfur')]
rid=next(iter(base.rovers)); initial=base.rovers[rid]['position']
def toward(a,b):
    n=unit(a); t=unit(b); return unit(add(t,scale(n,-dot(t,n))))
for source in sources:
 for dest in neighbors:
  if dest==source:continue
  for distance in (1.2,1.5,2.0):
   s=copy.deepcopy(base);res=p.cells[source].resource
   s.buildings['fixture-drill']=Building('fixture-drill',source,'drill',c.team_id,c.user_id)
   s.buildings['fixture-drill'].stock[res]=8
   s.buildings['fixture-warehouse']=Building('fixture-warehouse',dest,'warehouse',c.team_id,c.user_id)
   a=coordinates(move_on_surface(p.cells[source].center,toward(p.cells[source].center,p.cells[dest].center),distance,p.radius))
   b=coordinates(move_on_surface(p.cells[dest].center,toward(p.cells[dest].center,p.cells[source].center),distance,p.radius))
   r=s.rovers[rid];program='move_to(SOURCE)\nload(3)\nmove_to(DEPOT)\nunload()';r.update(status='running',instructions=parse(program,{'SOURCE':a,'DEPOT':b}),targets={'SOURCE':a,'DEPOT':b},pc=0)
   before=s.team_storage[c.team_id][res]; maxcargo=0
   for tick in range(2000):
    step_rovers(s,p);maxcargo=max(maxcargo,r['cargo'][res])
    if r['status'] in ('error','idle'): break
   if r['status']=='idle' and s.team_storage[c.team_id][res]==before+3 and maxcargo==3:
    out={'source_cell':source,'depot_cell':dest,'source':a,'depot':b,'ticks':tick+1,'resource':res,'initial_position':initial,'final_position':r['position'],'storage_before':before,'storage_after':s.team_storage[c.team_id][res],'peak_cargo':maxcargo}
    print(json.dumps(out,indent=2));sys.exit(0)
raise SystemExit('No successful route found on real terrain')
