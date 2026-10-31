import pytest

from app.storage import Database
from app.transport import GameService


def test_world_config_validates_benchmark_dimensions(monkeypatch, tmp_path):
    monkeypatch.setenv('MARS_PLANET_RADIUS', '45.5')
    monkeypatch.setenv('MARS_PLANET_SUBDIVISIONS', '4')
    service = GameService(Database(tmp_path / 'world.sqlite3'))
    assert service.planet.radius == 45.5
    assert service.planet.version.startswith('icosphere-v1-s4-r45.5-')
    for name, value in [('MARS_PLANET_RADIUS', 'NaN'), ('MARS_PLANET_RADIUS', '19'),
                        ('MARS_PLANET_RADIUS', '121'), ('MARS_PLANET_SUBDIVISIONS', '2'),
                        ('MARS_PLANET_SUBDIVISIONS', '3.0')]:
        monkeypatch.setenv('MARS_PLANET_RADIUS', '30')
        monkeypatch.setenv('MARS_PLANET_SUBDIVISIONS', '3')
        monkeypatch.setenv(name, value)
        with pytest.raises(ValueError):
            GameService(Database(tmp_path / 'invalid.sqlite3'))


def test_changed_map_config_refuses_and_preserves_saved_world(monkeypatch, tmp_path):
    path = tmp_path / 'world.sqlite3'
    db = Database(path)
    db.initialize()
    identity = db.register('alice', b'salt', b'hash', 'session', 3600)
    monkeypatch.setenv('MARS_PLANET_RADIUS', '30')
    monkeypatch.setenv('MARS_PLANET_SUBDIVISIONS', '3')
    original_service = GameService(db)
    original_service.join(identity)
    db.save_game(original_service.runtime(identity).state)
    saved_before = db.load_game(identity['world_id'])

    monkeypatch.setenv('MARS_PLANET_RADIUS', '31')
    changed_service = GameService(db)
    with pytest.raises(ValueError, match='existing save was left unchanged'):
        changed_service.runtime(identity)
    assert db.load_game(identity['world_id']) == saved_before
