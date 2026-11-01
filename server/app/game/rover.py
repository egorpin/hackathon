"""Safe coordinate rover language and deterministic fixed-step simulation."""
import math
import re
import uuid
from .state import (BUILDING_RADIUS, MOUNTAIN_RADIUS, PLAYER_RADIUS, RESOURCES,
                    building_interaction_distance, storage_capacity, Building)
from app.world.geometry import unit, scale, add, dot, surface_distance, move_on_surface
from app.world.terrain import terrain_height, ground_position, seed_from_world_id

CAPACITY = 50.0
EMPTY_MASS = 100.0
COST = {'iron': 10, 'copper': 5}
MASSES = {'ore': 1., 'iron': 1., 'copper': 1.5, 'water': 1., 'sulfur': .5, 'oxygen': 1.}
BASE_SPEED, MIN_SPEED, MAX_SPEED = 2., .2, 3.
ROVER_RADIUS = .3
ARRIVAL = .15
NAME = re.compile(r'[A-Za-z_][A-Za-z0-9_]{0,23}\Z')

def coordinates(position):
    x,y,z = unit(position)
    lat = round(math.degrees(math.asin(max(-1., min(1., y)))), 4)
    lon = 0. if abs(lat) == 90 else round(math.degrees(math.atan2(z,x)), 4)
    if lon >= 180: lon = -180.
    return {'latitude': lat, 'longitude': lon}

def position(lat, lon, radius):
    lat, lon = math.radians(lat), math.radians(lon)
    return (radius*math.cos(lat)*math.cos(lon), radius*math.sin(lat), radius*math.cos(lat)*math.sin(lon))

def mass(rover):
    return sum(rover['cargo'].get(k,0)*v for k,v in MASSES.items())

def speed_for(grade, load):
    speed = BASE_SPEED * (1-.4*load)/(1+6*max(grade,0)*(1+load))*(1+min(.25,2*max(-grade,0)))
    return max(MIN_SPEED, min(MAX_SPEED, speed))

def office_access(state, planet, player):
    return player.position is not None and any(b.team_id == player.team_id and b.building_type == 'dome_base' and surface_distance(player.position,planet.cells[b.cell_id].center,planet.radius) <= building_interaction_distance(planet,planet.cells[b.cell_id]) for b in state.buildings.values())

def spawn_position(center, planet, obstacles):
    normal=unit(center)
    axis=(0.,1.,0.) if abs(normal[1]) < .9 else (1.,0.,0.)
    tangent=unit(add(axis,scale(normal,-dot(axis,normal))))
    for distance in (1.5,2.,3.,4.,5.,7.,10.):
        for i in range(24):
            angle=i*math.tau/24
            cross=(normal[1]*tangent[2]-normal[2]*tangent[1],normal[2]*tangent[0]-normal[0]*tangent[2],normal[0]*tangent[1]-normal[1]*tangent[0])
            direction=add(scale(tangent,math.cos(angle)),scale(cross,math.sin(angle)))
            candidate=move_on_surface(center,direction,distance,planet.radius)
            if all(surface_distance(candidate,p,planet.radius)>=r for p,r in obstacles): return candidate
    raise ValueError('No safe spawn position')

def new_rover(team, position, color):
    return {'rover_id':str(uuid.uuid4()),'team_id':team,'position':position,'heading':(0.,0.,-1.),'color':color,
            'status':'idle','program':'','program_revision':0,'line':None,'cargo':dict.fromkeys(RESOURCES,0),
            'speed':0.,'grade':0.,'error':None,'pc':0,'instructions':[],'targets':{},'wait_ticks':0}

def ensure_start(state, planet):
    # Existing occupied landing sites are left intact: never destroy user property.
    for cell,user in state.landing_claims.items():
        p=state.players.get(user)
        if not p: continue
        occupant=next((b for b in state.buildings.values() if b.cell_id==cell),None)
        if occupant is None:
            b=Building(str(uuid.uuid4()),cell,'dome_base',p.team_id,user)
            state.buildings[b.building_id]=b
        obstacles=[(planet.cells[b.cell_id].center, BUILDING_RADIUS+PLAYER_RADIUS+.05) for b in state.buildings.values()]
        obstacles += [(planet.cells[c].center,MOUNTAIN_RADIUS+PLAYER_RADIUS+.05) for c in state.mountains]
        if p.position is None or any(surface_distance(p.position,q,planet.radius)<r for q,r in obstacles):
            p.position=spawn_position(planet.cells[cell].center,planet,obstacles)
        if p.team_id not in state.rover_grants:
            rover_obstacles = [(q, radius - PLAYER_RADIUS + ROVER_RADIUS) for q, radius in obstacles]
            rover_obstacles += [(other.position, PLAYER_RADIUS + ROVER_RADIUS + .05) for other in state.players.values() if other.position is not None]
            rover_obstacles += [(other['position'], 2 * ROVER_RADIUS + .05) for other in state.rovers.values()]
            r=new_rover(p.team_id,ground_position(spawn_position(planet.cells[cell].center,planet,rover_obstacles), planet.radius, seed=seed_from_world_id(state.world_id)),p.color)
            state.rovers[r['rover_id']]=r
            state.rover_grants.append(p.team_id)

class ProgramError(ValueError):
    def __init__(self, code, line=1):
        super().__init__(code)
        self.line = line

def parse(program, points=None):
    if not isinstance(program,str) or len(program.encode('utf-8'))>512: raise ProgramError('PROGRAM_TOO_LONG')
    points = dict(points or {})
    declared = set()
    lines=program.splitlines(); instructions=[]; loop=None
    for number, raw in enumerate(lines,1):
        line=raw.strip()
        if not line or line.startswith(('--', '#')): continue
        declaration=re.fullmatch(r'([A-Za-z_][A-Za-z0-9_]{0,23})\s*=\s*\(\s*([^,()]+)\s*,\s*([^,()]+)\s*\)',line)
        if declaration:
            name, latitude, longitude = declaration.groups()
            if name in declared or instructions: raise ProgramError('INVALID_PROGRAM', number)
            try: lat, lon = float(latitude), float(longitude)
            except ValueError: raise ProgramError('INVALID_PROGRAM', number) from None
            if not math.isfinite(lat) or not math.isfinite(lon) or not -90 <= lat <= 90 or not -180 <= lon < 180 or (abs(lat)==90 and lon!=0):
                raise ProgramError('INVALID_PROGRAM', number)
            points[name] = {'latitude':lat,'longitude':lon}; declared.add(name)
            continue
        if line=='while true do':
            if loop is not None: raise ProgramError('INVALID_PROGRAM', number)
            loop=len(instructions); instructions.append({'op':'loop','line':number}); continue
        if line=='end':
            if loop is None or any(i['op']=='end' for i in instructions): raise ProgramError('INVALID_PROGRAM', number)
            if len(instructions)==loop+1: raise ProgramError('INVALID_PROGRAM', number)
            instructions.append({'op':'end','target':loop+1,'line':number}); continue
        m=re.fullmatch(r'(move_to|load|unload|wait)\s*\(\s*([^()]*)\s*\)',line)
        if not m: raise ProgramError('INVALID_PROGRAM', number)
        op,arg=m.groups(); arg=arg.strip()
        if op=='move_to':
            if not NAME.fullmatch(arg) or arg not in points: raise ProgramError('UNKNOWN_POINT', number)
            value=arg
        elif op=='unload':
            if arg: raise ProgramError('INVALID_PROGRAM', number)
            value=None
        else:
            try: value=float(arg)
            except ValueError: raise ProgramError('INVALID_PROGRAM', number) from None
            if not math.isfinite(value) or value<=0 or value>3600: raise ProgramError('INVALID_PROGRAM', number)
        instruction={'op':op,'value':value,'line':number}
        if op=='move_to': instruction['point']=dict(points[value])
        instructions.append(instruction)
        if len(instructions)>128: raise ProgramError('INVALID_PROGRAM', number)
    if not instructions or (loop is not None and not any(i['op']=='end' for i in instructions)): raise ProgramError('INVALID_PROGRAM', len(lines) or 1)
    return instructions

def telemetry(r):
    return {k:r[k] for k in ('rover_id','team_id','position','heading','color','status','program','program_revision','line','cargo','speed','grade','error')} | {'cargo_mass':mass(r),'total_mass':EMPTY_MASS+mass(r),'capacity':CAPACITY}

def step_rovers(state, planet):
    seed=seed_from_world_id(state.world_id)
    for r in state.rovers.values():
        if r['status'] not in ('running','waiting'): continue
        r['speed']=0.; r['status']='running'; r['error']=None
        for _ in range(8):
            if r['pc']>=len(r['instructions']): r['status']='idle';r['line']=None;break
            ins=r['instructions'][r['pc']]; op=ins['op'];r['line']=ins['line']
            if op=='loop': r['pc']+=1;continue
            if op=='end': r['pc']=ins['target'];continue
            if op=='wait':
                if not r['wait_ticks']: r['wait_ticks']=max(1,math.ceil(ins['value']/.05))
                r['wait_ticks']-=1
                if not r['wait_ticks']: r['pc']+=1
                break
            if op=='move_to':
                point=r['targets'][ins['value']]; target=position(point['latitude'],point['longitude'],planet.radius)
                distance=surface_distance(r['position'],target,planet.radius)
                if distance<=ARRIVAL: r['pc']+=1;continue
                n=unit(r['position']); t=unit(target); direction=add(t,scale(n,-dot(t,n)))
                if sum(v*v for v in direction)<1e-16: r['status']='error';r['error']='AMBIGUOUS_DIRECTION';break
                direction=unit(direction); probe=move_on_surface(r['position'],direction,min(.2,distance),planet.radius)
                grade=(terrain_height(probe,seed)-terrain_height(r['position'],seed))/min(.2,distance)
                r['grade']=grade; ratio=mass(r)/CAPACITY
                if grade > .6-.3*ratio or grade < -.7: r['status']='error';r['error']='SLOPE_TOO_STEEP';break
                speed=speed_for(grade,ratio)
                obstacles=[(planet.cells[b.cell_id].center,BUILDING_RADIUS+ROVER_RADIUS) for b in state.buildings.values()]
                obstacles += [(planet.cells[c].center,MOUNTAIN_RADIUS+ROVER_RADIUS) for c in state.mountains]
                dest=move_on_surface(r['position'],direction,min(speed*.05,distance),planet.radius,obstacles)
                if surface_distance(dest,r['position'],planet.radius)<1e-8: r['status']='error';r['error']='PATH_BLOCKED';break
                r['position']=ground_position(dest,planet.radius,seed=seed);r['heading']=direction;r['speed']=speed
                break
            kind='drill' if op=='load' else 'warehouse'
            nearby=[b for b in state.buildings.values() if b.team_id==r['team_id'] and b.building_type==kind and surface_distance(r['position'],planet.cells[b.cell_id].center,planet.radius)<=building_interaction_distance(planet,planet.cells[b.cell_id])]
            if len(nearby)!=1: r['status']='error';r['error']='AMBIGUOUS_BUILDING' if nearby else 'BUILDING_NOT_FOUND';break
            if op=='load':
                resource=planet.cells[nearby[0].cell_id].resource; weight=MASSES.get(resource,1.)
                limit=min(ins['value'],CAPACITY-mass(r)); count=int((limit+1e-9)//weight)
                if count<1: r['status']='error';r['error']='CARGO_FULL_OR_LIMIT_TOO_SMALL';break
                count=min(count,nearby[0].stock.get(resource,0))
                if not count: r['status']='waiting';r['error']='DRILL_EMPTY';break
                nearby[0].stock[resource]-=count;r['cargo'][resource]+=count;r['pc']+=1;break
            pool=state.team_storage[r['team_id']]; space=max(0,storage_capacity(state,r['team_id'])-sum(pool.values()))
            for resource in RESOURCES:
                count=min(space,r['cargo'].get(resource,0));r['cargo'][resource]-=count;pool[resource]=pool.get(resource,0)+count;space-=count
            if sum(r['cargo'].values()): r['status']='waiting';r['error']='STORAGE_FULL';break
            r['pc']+=1;break
