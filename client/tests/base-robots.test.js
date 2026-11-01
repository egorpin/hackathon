import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { allocateRobotRoles, BaseRobots } from '../src/scene/base-robots.js';

test('each active construction site reserves exactly three builders, with bounded ambient crowd', () => {
  const sites = [
    { building_id: 'a', construction_status: 'planned' },
    { building_id: 'b', construction_status: 'building' },
    { building_id: 'c', construction_status: 'completed' },
  ];
  const roles = allocateRobotRoles(sites);
  assert.equal(roles.filter(role => role.role === 'ambient').length, 9);
  assert.equal(roles.filter(role => role.siteId === 'a').length, 3);
  assert.equal(roles.filter(role => role.siteId === 'b').length, 3);
  assert.equal(roles.filter(role => role.siteId === 'c').length, 0);
  assert.equal(allocateRobotRoles(Array.from({ length: 20 }, (_, i) => ({ id: i }))).length, 30);
});

test('crowd remains on the projected sphere and dispose removes every robot', () => {
  const scene = new THREE.Scene();
  const models = { create: () => new THREE.Group(), animate() {} };
  const crowd = new BaseRobots(scene, models, {
    projectSurface: direction => direction.clone().normalize().multiplyScalar(100),
  });
  crowd.setState({ position: new THREE.Vector3(0, 100, 0), buildings: [], players: [] });
  assert.equal(scene.children.length, 9);
  for (let i = 0; i < 30; i++) crowd.update(1 / 30);
  for (const entry of crowd.entries.values()) assert.ok(Math.abs(entry.position.length() - 100.08) < 1e-6);
  crowd.dispose();
  assert.equal(scene.children.length, 0);
  assert.equal(crowd.entries.size, 0);
});

test('construction builders are removed when a site completes', () => {
  const scene = new THREE.Scene();
  const crowd = new BaseRobots(scene, { create: () => new THREE.Group(), animate() {} });
  crowd.setState({ position: [0, 100, 0], buildings: [{ building_id: 'site', position: [0, 100, 2], construction_status: 'planned' }] });
  assert.equal([...crowd.entries.values()].filter(entry => entry.role.role === 'builder').length, 3);
  crowd.setState({ buildings: [{ building_id: 'site', position: [0, 100, 2], construction_status: 'completed' }] });
  assert.equal([...crowd.entries.values()].filter(entry => entry.role.role === 'builder').length, 0);
  assert.equal(crowd.entries.size, 12, 'completed builders stay in the crowd as ambient robots');
  crowd.setState({ buildings: [{ building_id: 'site', position: [0, 100, 2], construction_status: 'building' }] });
  assert.equal([...crowd.entries.values()].filter(entry => entry.role.role === 'builder').length, 3);
  crowd.dispose();
});

test('model instances use the tiny scale and are positioned immediately on creation', () => {
  const scene = new THREE.Scene();
  const crowd = new BaseRobots(scene, { create: () => new THREE.Group(), animate() {} });
  crowd.setState({ position: [0, 100, 0] });
  for (const entry of crowd.entries.values()) {
    assert.equal(entry.root.scale.x, .14);
    assert.ok(entry.root.position.length() > 99);
    assert.ok(entry.root.position.distanceTo(entry.position) < 1e-8);
  }
  crowd.dispose();
});

test('three builders reach a nearby site in eight seconds, then work without greeting the player', () => {
  const scene = new THREE.Scene();
  const calls = [];
  const models = { create: () => new THREE.Group(), animate: (root, state) => calls.push({ role: root.userData.robotRole, state }) };
  const site = { building_id: 'nearby', construction_status: 'planned', position: [4, 99.92, 0] };
  const crowd = new BaseRobots(scene, models, {
    projectSurface: direction => direction.clone().normalize().multiplyScalar(100),
    seed: 42,
  });
  crowd.setState({ position: [0, 100, 0], buildings: [site], players: [{ position: [0, 100, 0] }] });
  for (let i = 0; i < 160; i++) crowd.update(.05);
  const builders = [...crowd.entries.values()].filter(entry => entry.role.role === 'builder');
  assert.equal(builders.length, 3);
  assert.ok(builders.every(entry => entry.position.distanceTo(entry.target) < .6),
    builders.map(entry => `${entry.position.distanceTo(entry.target).toFixed(2)}: p${entry.position.toArray().map(n => n.toFixed(1))} t${entry.target.toArray().map(n => n.toFixed(1))}`).join('; '));

  site.construction_status = 'building';
  for (let i = 0; i < 240; i++) crowd.update(.05);
  assert.ok(calls.some(call => call.role === 'builder' && call.state === 'build'));
  assert.ok(!calls.some(call => call.role === 'builder' && ['wave', 'jump'].includes(call.state)));
  crowd.dispose();
});

test('ambient jump and wave reactions keep their complete animation durations', () => {
  for (const [choice, expectedDuration] of [[0, 1.4], [0.9, 2.2]]) {
    const scene = new THREE.Scene();
    const crowd = new BaseRobots(scene, { create: () => new THREE.Group(), animate() {} }, { seed: 8 });
    crowd.setState({ position: [0, 100, 0], players: [{ position: [0, 100, 0] }] });
    const ambient = [...crowd.entries.values()].find(entry => entry.role.role === 'ambient');
    crowd.players = [{ position: ambient.position }];
    ambient.random = () => ambient.role.id === 'ambient-0' ? (ambient._reactionDraw++ ? choice : 0) : .9;
    ambient._reactionDraw = 0;
    crowd.update(.05);
    assert.equal(ambient.action, choice === 0 ? 'wave' : 'jump');
    const duration = choice === 0 ? 2.2 : 1.4;
    assert.ok(Math.abs(ambient.actionUntil - (crowd.now + duration)) < 1e-9);
    crowd.dispose();
  }
});
