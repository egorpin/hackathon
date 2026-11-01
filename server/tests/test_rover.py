import uuid
from app.game import Context, UnitOfWork, WorldState, apply_command, snapshot
from app.game.rover import coordinates, position, parse, speed_for, mass
from app.game.simulation import step
from app.game.state import Building, TICK_SECONDS
from app.world.geometry import generate_planet, surface_distance, move_on_surface, unit, cross

def cmd(world, ctx, kind, **payload):
    return apply_command(ctx, {'type':kind,'request_id':str(uuid.uuid4()),'payload':payload},world)['payload']

def setup():
    p=generate_planet(); ctx=Context('w','a','t'); world=UnitOfWork(p,WorldState('w',p.version)); world.enroll(ctx)
    assert cmd(world,ctx,'landing.select',cell_id=p.landing_sites[0])['ok']
    assert cmd(world,ctx,'world.start')['ok']
    return p,ctx,world

def test_surveys_registry_and_program_revision():
    p,c,w=setup(); state=w.state; rid=next(iter(state.rovers)); office=next(iter(state.buildings.values()))
    coords=coordinates(state.players['a'].position)
    assert not cmd(w,c,'rover.point.register',name='A',**coords)['ok']
    assert cmd(w,c,'rover.survey')['ok']
    assert cmd(w,c,'rover.point.register',name='A',**coords)['ok']
    assert cmd(w,c,'rover.point.register',name='A',**coords)['code']=='POINT_EXISTS'
    assert cmd(w,c,'rover.program',rover_id=rid,program='while true do\nmove_to(A)\nwait(1)\nend',expected_revision=0)['ok']
    assert cmd(w,c,'rover.start',rover_id=rid,expected_revision=0)['code']=='REVISION_CONFLICT'
    assert cmd(w,c,'rover.start',rover_id=rid,expected_revision=1)['ok']
    assert cmd(w,c,'rover.start',rover_id=rid,expected_revision=2)['code']=='ROVER_RUNNING'
    assert cmd(w,c,'rover.stop',rover_id=rid)['ok']
    assert w.state.rovers[rid]['status']=='idle'
    view=snapshot(c,w)['payload']; assert view['office_access'] and len(view['rover_fleet'])==1

def test_parser_and_physics():
    import pytest
    for bad in ('while true do\nend','import os','move_to(X)','wait(nan)','load(-1)'):
        with pytest.raises(ValueError): parse(bad,{})
    assert speed_for(0,1)<speed_for(0,0)
    assert speed_for(.1,1)<speed_for(-.1,1)
    xyz=position(14.1234,-62.5678,30)
    assert coordinates(xyz)=={'latitude':14.1234,'longitude':-62.5678}

def test_load_unload_and_restart_state():
    p,c,w=setup(); rid=next(iter(w.state.rovers)); cells=p.cells[p.landing_sites[0]].neighbors
    source=next(x for x in cells if p.cells[x].resource=='iron'); dest=next(x for x in cells if x!=source)
    def near(cell):
        c=p.cells[cell]; return move_on_surface(c.center,unit(cross(c.center,c.vertices[0])),1.2,p.radius)
    with w.transaction() as s:
        s.buildings['d']=Building('d',source,'drill','t','a');s.buildings['d'].stock['iron']=8
        s.buildings['h']=Building('h',dest,'warehouse','t','a')
        r=s.rovers[rid];r.update(position=near(source),status='running',instructions=parse('load(3)\nunload()',{}),pc=0)
    with w.transaction() as s: step(s,TICK_SECONDS,p)
    assert w.state.rovers[rid]['cargo']['iron']==3
    with w.transaction() as s: s.rovers[rid]['position']=near(dest)
    before=w.state.team_storage['t']['iron']
    with w.transaction() as s: step(s,TICK_SECONDS,p)
    assert w.state.team_storage['t']['iron']==before+3 and mass(w.state.rovers[rid])==0
    restored=WorldState.from_dict(w.state.to_dict())
    assert restored.rovers[rid]['cargo']['iron']==0

def test_movement_blocking_and_slope(monkeypatch):
    import app.game.rover as mod
    p,c,w=setup(); rid=next(iter(w.state.rovers)); start=w.state.rovers[rid]['position']
    target=move_on_surface(start,(0,0,1),2,p.radius); point=coordinates(target)
    with w.transaction() as s:
        r=s.rovers[rid];r.update(status='running',instructions=parse('move_to(T)',{'T':point}),targets={'T':point},pc=0)
    monkeypatch.setattr(mod,'terrain_height',lambda *args: 0)
    for _ in range(100):
        with w.transaction() as s: step(s,TICK_SECONDS,p)
    assert surface_distance(w.state.rovers[rid]['position'],target,p.radius)<.2
    with w.transaction() as s:
        r=s.rovers[rid];r.update(position=start,status='running',pc=0)
        s.mountains.append(next(iter(s.buildings.values())).cell_id)
    monkeypatch.setattr(mod,'move_on_surface',lambda pos,*args,**kwargs: pos if kwargs or len(args)>=4 else target)
    with w.transaction() as s: step(s,TICK_SECONDS,p)
    assert w.state.rovers[rid]['error']=='PATH_BLOCKED'
    monkeypatch.undo()
    monkeypatch.setattr(mod,'terrain_height',lambda pos, seed: 0 if surface_distance(pos,start,p.radius)<.01 else 10)
    with w.transaction() as s:
        r=s.rovers[rid];r.update(position=start,status='running',pc=0)
        step(s,TICK_SECONDS,p)
    assert w.state.rovers[rid]['error']=='SLOPE_TOO_STEEP'

def test_waits_partial_unload_and_conservation():
    p,c,w=setup();rid=next(iter(w.state.rovers));cells=p.cells[p.landing_sites[0]].neighbors
    source=next(x for x in cells if p.cells[x].resource=='iron'); dest=next(x for x in cells if x!=source)
    def near(cell):
        cell=p.cells[cell];return move_on_surface(cell.center,unit(cross(cell.center,cell.vertices[0])),1.2,p.radius)
    with w.transaction() as s:
        s.buildings['d']=Building('d',source,'drill','t','a');s.buildings['h']=Building('h',dest,'warehouse','t','a')
        r=s.rovers[rid];r.update(position=near(source),status='running',instructions=parse('load(3)\nunload()',{}),pc=0)
        step(s,TICK_SECONDS,p)
    assert w.state.rovers[rid]['error']=='DRILL_EMPTY'
    with w.transaction() as s:
        s.buildings['d'].stock['iron']=3;step(s,TICK_SECONDS,p)
        s.rovers[rid]['position']=near(dest);s.team_storage['t']={k:0 for k in s.team_storage['t']};s.team_storage['t']['iron']=499
        step(s,TICK_SECONDS,p)
    assert w.state.rovers[rid]['cargo']['iron']==2 and w.state.rovers[rid]['error']=='STORAGE_FULL'
    with w.transaction() as s:
        s.team_storage['t']['iron']-=2;step(s,TICK_SECONDS,p)
    assert w.state.rovers[rid]['cargo']['iron']==0 and w.state.team_storage['t']['iron']==500

def test_purchase_idempotence_and_private_team_data():
    p,c,w=setup()
    with w.transaction() as s: s.team_storage['t']['copper']=10
    before=dict(w.state.team_storage['t']);request={'type':'rover.purchase','request_id':str(uuid.uuid4()),'payload':{}}
    first=apply_command(c,request,w);assert first['payload']['ok'];assert apply_command(c,request,w)==first
    assert len(w.state.rovers)==2 and w.state.team_storage['t']['iron']==before['iron']-10
    other=Context('w','b','other');w.enroll(other)
    with w.transaction() as s: s.players['b'].position=s.players['a'].position
    assert cmd(w,other,'rover.stop',rover_id=first['payload']['rover_id'])['code']=='FORBIDDEN'
    assert cmd(w,other,'rover.purchase')['code']=='OFFICE_REQUIRED'
    assert snapshot(other,w)['payload']['rover_fleet']==[]
    assert cmd(w,c,'rover.survey')['ok'] and snapshot(other,w)['payload']['rover_surveys']==[]

def test_real_database_restart_pauses_and_preserves_rover(tmp_path):
    from app.storage import Database
    from app.transport import GameService
    db=Database(tmp_path/'rover.sqlite');db.initialize()
    identity=db.register('alice',b'salt',b'hash','session',3600)
    service=GameService(db); service.join(identity)
    assert service.command(identity,{'type':'world.start','request_id':str(uuid.uuid4()),'payload':{}})['payload']['ok']
    runtime=service.runtime(identity); rid=next(iter(runtime.state.rovers))
    with runtime.transaction() as s:
        s.rovers[rid]['status']='running';s.rovers[rid]['cargo']['iron']=3
    restored=GameService(db);restored.join(identity); state=restored.runtime(identity).state
    assert list(state.rovers)==[rid]
    assert state.rovers[rid]['status']=='idle' and state.rovers[rid]['cargo']['iron']==3
    assert len(state.rover_grants)==1
