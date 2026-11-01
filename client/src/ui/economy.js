export const RESOURCE_NAMES = Object.freeze({iron:'железа', copper:'меди', water:'воды', sulfur:'серы'});
export const RESOURCE_SYMBOLS = Object.freeze({iron:'Fe', copper:'Cu', water:'H₂O', sulfur:'S'});
export const MINABLE_RESOURCES = Object.freeze(Object.keys(RESOURCE_NAMES));

export function recipeFor(state, type) {
  const recipe = state?.config?.recipes?.[type];
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) return null;
  const entries = Object.entries(recipe);
  return entries.length && entries.every(([resource, amount]) => resource in RESOURCE_NAMES && Number.isFinite(amount) && amount >= 0)
    ? recipe : null;
}

export function formatResources(resources, compact = false) {
  return Object.entries(resources || {}).map(([resource, amount]) =>
    `${amount} ${compact ? RESOURCE_SYMBOLS[resource] || resource : RESOURCE_NAMES[resource] || resource}`).join(' + ');
}

export function missingResources(state, type) {
  const recipe = recipeFor(state, type);
  if (!recipe || !state?.team_storage) return null;
  return Object.fromEntries(Object.entries(recipe)
    .map(([resource, amount]) => [resource, Math.max(0, amount - (state.team_storage[resource] || 0))])
    .filter(([, amount]) => amount > 0));
}

export function canAfford(state, type) {
  const missing = missingResources(state, type);
  return missing !== null && Object.keys(missing).length === 0;
}

export function transferPlan(source, destination, capacity) {
  if (!source || !destination || !Number.isFinite(capacity)) return [];
  let room = Math.max(0, capacity - Object.values(destination).reduce((sum,value)=>sum+(Number.isFinite(value)?value:0),0));
  const plan = [];
  for (const resource of MINABLE_RESOURCES) {
    const amount = Math.min(50, Math.floor(source[resource] || 0), Math.floor(room));
    if (amount > 0) { plan.push({resource,amount}); room -= amount; }
  }
  return plan;
}

export function buildingTransfer(state, building) {
  if (!state || !building) return {type:null,items:[]};
  if (building.building_type==='drill') return {
    type:'resource.pickup', items:transferPlan(building.stock,state.inventory,state.config?.inventory_capacity),
  };
  if (building.building_type==='warehouse') return {
    type:'resource.deposit', items:transferPlan(state.inventory,state.team_storage,state.config?.storage_capacity),
  };
  if (building.building_type==='oxygen_generator') return {
    type:'resource.deposit', items:transferPlan({water:state.inventory?.water || 0},building.stock,state.config?.building_capacity),
  };
  return {type:null,items:[]};
}
