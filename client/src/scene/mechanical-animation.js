import * as THREE from 'three';

// Procedural idle motion for mechanically named nodes in an imported GLB.
// The asset remains the source of truth for pivots and bind transforms. This
// module only animates matching nodes and composes every frame from a snapshot.
const RULES = {
  oxygen_generator: [
    {key:'compressor',match:/oxygen.?housing/i,type:'bob',axis:[1,0,0],amplitude:0.002,speed:24,verticalAmplitude:0.002},
  ],
  drill: [
    { key: 'bit', match: /drill.?bit|bit.?drill/i, type: 'spin', axis: [0, 1, 0], speed: 3.2 },
    { key: 'body', match: /drill.?body|chassis/i, type: 'bob', axis: [1, 0, 0], amplitude: 0.006, speed: 28, verticalAmplitude: 0.006 },
  ],
  rover: [
    { key: 'wheel', match: /wheel/i, type: 'spin', axis: [1, 0, 0], speed: 0.45 },
    { key: 'mast', match: /camera.?mast|mast.?joint|scan.?mast/i, type: 'sweep', axis: [0, 1, 0], amplitude: 0.14, speed: 0.55 },
    { key: 'arm', match: /arm.?joint|shoulder|elbow|wrist/i, type: 'sweep', axis: [1, 0, 0], amplitude: 0.07, speed: 0.8 },
  ],
};

const snapshot = node => ({ position: node.position.clone(), quaternion: node.quaternion.clone() });

/** Attach bounded decorative motion to nodes whose names identify their part.
 * Call update(dt, { active }) once per frame. `active` increases motion for a
 * selected/working object; it does not add movement or game behavior.
 */
export function attachMechanicalAnimation(root, kind) {
  const rules = RULES[kind];
  if (!root || !rules) return { update() {}, dispose() {}, matched: [] };
  const parts = [];
  root.traverse(node => {
    const rule = rules.find(candidate => candidate.match.test(node.name || ''));
    if (rule) parts.push({ node, rule, base: snapshot(node) });
  });
  let time = 0;
  const axis = new THREE.Vector3();
  function update(dt, { active = false } = {}) {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if(kind==='drill' && !active) {
      for(const {node,rule,base} of parts)if(rule.type==='bob')node.position.copy(base.position);
      return;
    }
    time += Math.min(dt, 0.1);
    const gain = active ? 1.5 : 1;
    for (const { node, rule, base } of parts) {
      node.position.copy(base.position);
      node.quaternion.copy(base.quaternion);
      axis.fromArray(rule.axis).normalize();
      if (rule.type === 'spin') {
        const angle = time * rule.speed * gain;
        node.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
      } else if (rule.type === 'sweep') {
        const angle = Math.sin(time * rule.speed) * rule.amplitude * gain;
        node.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
      } else if (rule.type === 'bob') {
        node.position.addScaledVector(axis, Math.sin(time * (rule.speed || 2.1)) * rule.amplitude * gain);
        if (rule.verticalAmplitude) node.position.y += Math.cos(time * (rule.speed || 2.1)) * rule.verticalAmplitude * gain;
      }
    }
  }
  function dispose() {
    for (const { node, base } of parts) {
      node.position.copy(base.position);
      node.quaternion.copy(base.quaternion);
    }
  }
  return { update, dispose, matched: parts.map(({ node, rule }) => ({ name: node.name, role: rule.key })) };
}
