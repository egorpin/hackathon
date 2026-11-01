export function normalizeOpenTabs(files, storedTabs) {
  const valid = new Set(files.map(file => file.id));
  const candidates = Array.isArray(storedTabs) ? storedTabs : files.map(file => file.id);
  return [...new Set(candidates.filter(id => typeof id === 'string' && valid.has(id)))];
}

export function closeOpenTab(openTabs, id) {
  const index = openTabs.indexOf(id);
  if (index < 0) return {openTabs:[...openTabs], selected:null};
  const remaining = openTabs.filter(tabId => tabId !== id);
  return {openTabs:remaining, selected:remaining[Math.min(index, remaining.length - 1)] ?? null};
}

export function moveLocalFile(files, folders, id, folderName) {
  if (!folders.includes(folderName)) return false;
  const file = files.find(item => item.id === id);
  if (!file || file.readOnly) return false;
  file.folder = folderName;
  return true;
}
