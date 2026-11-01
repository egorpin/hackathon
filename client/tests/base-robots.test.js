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
  for (const entry of crowd.entries.values()) assert.ok(Math.abs(entry.position.length() - 100) < 1e-6);
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

test('ambient robots keep their patrols within the hub', () => {
  const scene = new THREE.Scene();
  const base = new THREE.Vector3(0, 100, 0);
  const crowd = new BaseRobots(scene, { create: () => new THREE.Group(), animate() {} }, { seed: 42 });
  crowd.setState({ position: base });
  for (let i = 0; i < 240; i++) crowd.update(.05);
  for (const entry of crowd.entries.values()) {
    assert.ok(entry.position.distanceTo(base) <= 6.1, `${entry.role.id} wandered ${entry.position.distanceTo(base).toFixed(2)}m from the hub`);
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

test('ambient robots greet from twice the previous reaction distance', () => {
  const scene = new THREE.Scene();
  const crowd = new BaseRobots(scene, { create: () => new THREE.Group(), animate() {} }, { seed: 8 });
  crowd.setState({ position: [0, 100, 0] });
  const ambient = [...crowd.entries.values()].find(entry => entry.role.id === 'ambient-0');
  ambient.random = () => 0;

  crowd.players = [{ position: ambient.position.clone().add(new THREE.Vector3(3.1, 0, 0)) }];
  crowd.update(.05);
  assert.notEqual(ambient.action, 'wave');
  assert.notEqual(ambient.action, 'jump');

  crowd.players = [{ position: ambient.position.clone().add(new THREE.Vector3(3, 0, 0)) }];
  crowd.update(.05);
  assert.equal(ambient.action, 'wave');
  crowd.dispose();
});

test('wave greeting shows a shared billboard bubble for two seconds and releases its texture', () => {
  const scene = new THREE.Scene();
  const texture = new THREE.Texture();
  let textureDisposals = 0;
  texture.dispose = () => { textureDisposals++; };
  const crowd = new BaseRobots(scene, { create: () => new THREE.Group(), animate() {} }, {
    seed: 8, ambientCount: 2, greetingTextureFactory: () => texture,
  });
  crowd.setState({ position: [0, 100, 0] });
  const [first, second] = [...crowd.entries.values()];
  assert.ok(first.greetingSprite && second.greetingSprite);
  second.reactionCooldown = 100;
  assert.ok(Math.abs(first.greetingSprite.scale.x * first.root.scale.x - 1.25 / 3) < 1e-9);
  assert.ok(Math.abs(first.greetingSprite.scale.y * first.root.scale.y - .55 / 3) < 1e-9);
  assert.equal(first.greetingSprite.material, second.greetingSprite.material, 'robots share one greeting material');
  let materialDisposals = 0;
  first.greetingSprite.material.dispose = () => { materialDisposals++; };
  first.random = () => first._draw++ ? 0 : 0;
  first._draw = 0;
  crowd.players = [{ position: first.position.clone() }];

  crowd.update(.05);
  assert.equal(first.action, 'wave');
  assert.equal(first.greetingSprite.visible, true);
  for (let i = 0; i < 38; i++) crowd.update(.05);
  assert.equal(first.greetingSprite.visible, true);
  for (let i = 0; i < 4; i++) crowd.update(.05);
  assert.equal(first.greetingSprite.visible, false);
  assert.equal(second.greetingSprite.visible, false, 'unrelated robots do not show the greeting');
  crowd.dispose();
  assert.equal(textureDisposals, 1, 'the shared texture is released once');
  assert.equal(materialDisposals, 1, 'the shared material is released once');
});

test('couriers carry a colored resource from a deposit to the dome and skip other actions until unloading', () => {
  const scene = new THREE.Scene();
  const calls = [];
  const arms = [];
  const crowd = new BaseRobots(scene, {
    create: () => {
      const root = new THREE.Group();
      for (const name of ['LeftArm', 'RightArm']) {
        const arm = new THREE.Group(); arm.name = name; root.add(arm); arms.push(arm);
      }
      return root;
    },
    animate: (root, state) => {
      for (const arm of root.children.filter(child => ['LeftArm', 'RightArm'].includes(child.name))) arm.quaternion.identity();
      calls.push({ role: root.userData.robotRole, state });
    },
  }, {
    ambientCount: 1, maxCount: 1, seed: 42,
    greetingTextureFactory: () => new THREE.Texture(),
    projectSurface: direction => direction.clone().normalize().multiplyScalar(100),
  });
  crowd.setState({
    position: [0, 100, 0],
    buildings: [{ building_type: 'dome_base', position: [0, 100, 0] }],
    players: [{ position: [0, 100, 0] }],
    deposits: [{ cell_id: 'iron-1', position: [5, 99.875, 0], resource: 'iron' }],
  });
  const robot = crowd.entries.get('ambient-0');
  robot.courierCooldown = 0;
  robot.random = () => 0;
  let sawCargo = false;
  let returnedHome = false;
  const outboundSteps = [], returnSteps = [];
  robot.greetingSprite.visible = true;
  for (let i = 0; i < 500; i++) {
    const phase = robot.courierPhase;
    const previous = robot.position.clone();
    crowd.update(.05);
    const step = previous.distanceTo(robot.position);
    if (phase === 'outbound' && robot.courierPhase === 'outbound' && step > 1e-6) outboundSteps.push(step);
    if (phase === 'returning' && robot.courierPhase === 'returning' && step > 1e-6) returnSteps.push(step);
    if (robot.courierPhase !== 'idle') {
      assert.ok(['walk', 'idle'].includes(calls.at(-1).state), 'couriers use only travel/unload animation states');
      assert.equal(robot.greetingSprite.visible, false, 'couriers cannot show a greeting bubble');
    }
    if (robot.cargoMesh.visible) {
      sawCargo = true;
      assert.ok(['returning', 'unloading'].includes(robot.courierPhase));
      assert.equal(robot.cargoMesh.material.color.getHex(), 0xb76e45);
      assert.equal(robot.cargoMesh.userData.robotCargo, true);
      assert.ok(arms.every(arm => arm.quaternion.angleTo(new THREE.Quaternion()) > 2.4), 'both arms stay raised after walk animation');
      robot.root.updateWorldMatrix(true, true);
      const cargoWorld = robot.cargoMesh.getWorldPosition(new THREE.Vector3());
      assert.ok(cargoWorld.dot(robot.position.clone().normalize()) - robot.position.length() > .32,
        'the resource is held above the robot head');
    }
    if (robot.courierPhase === 'unloading') {
      returnedHome = true;
      assert.ok(robot.position.distanceTo(crowd.homePosition) < .5);
    }
    if (returnedHome && robot.courierPhase === 'idle' && !robot.cargoMesh.visible) break;
  }
  assert.ok(sawCargo, 'cargo should be visible after reaching the iron deposit');
  assert.ok(returnedHome, 'the courier should reach its home before unloading');
  assert.equal(robot.cargoMesh.visible, false, 'cargo should disappear after unloading');
  assert.ok(robot.courierCooldown > 0, 'a completed delivery should pause before the next trip');
  assert.ok(outboundSteps.length && returnSteps.length);
  assert.ok(returnSteps.reduce((sum, value) => sum + value, 0) / returnSteps.length
    < outboundSteps.reduce((sum, value) => sum + value, 0) / outboundSteps.length * .6,
  'loaded return pace is slower than the outbound pace');
  assert.ok(arms.every(arm => arm.quaternion.angleTo(new THREE.Quaternion()) < 1e-8), 'arms restore after unloading');
  crowd.dispose();
});

test('grounding compensates the animated robot model bottom at its actual scale', () => {
  const scene = new THREE.Scene();
  let foot, motion;
  const crowd = new BaseRobots(scene, {
    create: () => {
      const root = new THREE.Group();
      foot = new THREE.Mesh(new THREE.BoxGeometry(.4, .2, .4), new THREE.MeshBasicMaterial());
      foot.position.y = .5;
      motion = new THREE.Group(); motion.add(foot); root.add(motion);
      return root;
    },
    animate: (_root, state) => { foot.position.y = .2; motion.position.y = state === 'jump' ? .5 : 0; },
  }, {
    ambientCount: 1, maxCount: 1, projectSurface: direction => direction.clone().normalize().multiplyScalar(100),
  });
  crowd.setState({ position: [0, 100, 0] });
  const robot = crowd.entries.get('ambient-0');
  assert.ok(Math.abs(robot.footOffset - .056) < 1e-6, 'local foot minimum is scaled by 0.14');
  crowd.update(.05);
  robot.root.updateWorldMatrix(true, true);
  const normal = robot.position.clone().normalize();
  const box = foot.geometry.boundingBox || (foot.geometry.computeBoundingBox(), foot.geometry.boundingBox);
  let lowest = Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const point = new THREE.Vector3(corner & 1 ? box.max.x : box.min.x,
      corner & 2 ? box.max.y : box.min.y,
      corner & 4 ? box.max.z : box.min.z);
    lowest = Math.min(lowest, foot.localToWorld(point).dot(normal));
  }
  assert.ok(Math.abs(lowest - 100) < 1e-4, `animated foot remains on ground at radial height ${lowest}`);
  assert.ok(Math.abs(robot.footOffset - .014) < 1e-6, 'ground offset follows the current foot animation');
  crowd.animate(robot, 'jump', .05);
  robot.root.updateWorldMatrix(true, true);
  const airborne = foot.localToWorld(new THREE.Vector3(0, -.1, 0)).dot(normal);
  assert.ok(airborne > 100.05, 'jump motion lifts the model instead of being cancelled by grounding');
  crowd.animate(robot, 'idle', .05);
  robot.root.updateWorldMatrix(true, true);
  const landed = foot.localToWorld(new THREE.Vector3(0, -.1, 0)).dot(normal);
  assert.ok(Math.abs(landed - 100) < 1e-4);
  crowd.dispose();
});

test('clicking a nearby robot starts a complete greeting or jump without interrupting work or cargo trips', () => {
  const scene = new THREE.Scene();
  let targetMesh;
  const crowd = new BaseRobots(scene, {
    create: () => {
      const root = new THREE.Group();
      targetMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
      root.add(targetMesh);
      return root;
    },
    animate() {},
  }, { ambientCount: 1, maxCount: 1, greetingTextureFactory: () => new THREE.Texture() });
  crowd.setState({ position: [0, 100, 0] });
  const robot = crowd.entries.get('ambient-0');
  const raycaster = {
    recursive: false,
    intersectObjects(roots, recursive) {
      assert.deepEqual(roots, [robot.root]);
      this.recursive = recursive;
      return [{ object: targetMesh, distance: 2 }];
    },
  };

  assert.equal(crowd.interact(raycaster, 1), false, 'hits outside interaction range are ignored');
  robot.random = () => 0;
  assert.equal(crowd.interact(raycaster, 3), true);
  assert.equal(raycaster.recursive, true);
  assert.equal(robot.action, 'wave');
  assert.ok(Math.abs(robot.actionUntil - 2.2) < 1e-9);
  assert.equal(robot.greetingSprite.visible, true);
  assert.ok(robot.reactionCooldown > 0);
  for (let i = 0; i < 41; i++) crowd.update(.05);
  assert.equal(robot.action, 'wave', 'the complete wave clip continues after the bubble hides');
  assert.equal(robot.greetingSprite.visible, false);

  robot.random = () => .9;
  assert.equal(crowd.interact(raycaster, 3), true);
  assert.equal(robot.action, 'jump');
  assert.ok(Math.abs(robot.actionUntil - (crowd.now + 1.4)) < 1e-9);
  robot.action = 'build';
  robot.actionUntil = crowd.now + 1;
  assert.equal(crowd.interact(raycaster, 3), true);
  assert.equal(robot.action, 'build', 'clicking does not interrupt active construction work');
  robot.courierPhase = 'returning';
  assert.equal(crowd.interact(raycaster, 3), false, 'loaded couriers are not clickable');
  crowd.dispose();
});
