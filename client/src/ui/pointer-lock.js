const pending = new WeakSet();

// Call during the closing click/keypress, before the dialog's queued close
// event loses browser user activation. The close event may call this again.
export function restorePointerLock(scene) {
  const canvas = scene.controls.canvas;
  if (!scene.enabled || scene.stage === 'lobby' || scene.controls.mode !== 'first'
      || document.querySelector('dialog[open]') || document.pointerLockElement === canvas
      || pending.has(canvas) || !canvas.requestPointerLock) return;
  scene.controls.suspended = false;
  scene.controls.clear();
  canvas.focus?.({preventScroll:true});
  pending.add(canvas);
  try {
    Promise.resolve(canvas.requestPointerLock()).catch(() => {}).finally(() => pending.delete(canvas));
  } catch {
    pending.delete(canvas);
  }
}
