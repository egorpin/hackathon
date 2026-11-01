import { surfaceDistance, vector } from '../scene/motion.js';

export function inInteractionRange(state, building) {
  const player = state?.players?.find(item => item.player_id === state.self_id);
  const radius = state?.world?.radius ?? state?.config?.radius;
  const reach = building?.interaction_distance;
  return !!player?.position && !!building?.position && Number.isFinite(radius) && Number.isFinite(reach)
    && surfaceDistance(vector(player.position), vector(building.position), radius) <= reach;
}

export function aimedBuilding(scene, state, refresh = false) {
  if (!scene?.enabled || scene.mode !== 'first' || scene.controls?.suspended || state?.stage !== 'running') return null;
  if (refresh) scene.pick();
  const building = state.buildings?.find(item => item.building_id === scene.targetedBuilding?.building_id);
  return building && inInteractionRange(state, building) ? building : null;
}
