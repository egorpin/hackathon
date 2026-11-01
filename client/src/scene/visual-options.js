// Visual preferences never change simulation or resource availability.
export const DEFAULT_VISUAL_OPTIONS = Object.freeze({
  rocks: true,
  resourceDeposits: true,
  dust: true,
  stars: true,
  sky: true,
  sun: true,
  hands: true,
  animations: true,
});

export function updateVisualOptions(current, patch = {}) {
  const next = { ...current };
  for (const key of Object.keys(DEFAULT_VISUAL_OPTIONS)) {
    if (typeof patch?.[key] === 'boolean') next[key] = patch[key];
  }
  return next;
}
