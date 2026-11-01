import * as THREE from 'three';
import { projectTerrain } from './terrain.js';

export function createBaseMarker(radius) {
  const marker = new THREE.Mesh(
    new THREE.OctahedronGeometry(Math.max(.35, radius * .025), 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
  );
  marker.visible = false;
  marker.renderOrder = 20;
  return marker;
}

/** Update the top-map marker from the dome_base snapshot record and its world position. */
export function updateBaseMarker(marker, building, position, mode, radius, terrain) {
  if (mode !== 'top' || building?.building_type !== 'dome_base' || !position) {
    marker.visible = false;
    return false;
  }
  const point = Array.isArray(position) ? new THREE.Vector3().fromArray(position) : position.clone();
  marker.position.copy(projectTerrain(point, radius, Math.max(.25, radius * .015), terrain));
  if (building.color) marker.material.color.set(building.color);
  marker.visible = true;
  return true;
}
