# Astronaut rig preparation

`rig_astronaut.py` is a Blender batch entry point for the generated GLB. It imports the mesh, normalizes feet to Y=0 and height to 1 Blender unit, creates a compact armature (`Root`, `Spine`, `Head`, left/right arm, forearm, hand, thigh, shin, foot), assigns bounded region weights and adds `Idle`, `Walk`, `Run`, and `Jump` actions as NLA strips before exporting GLB.

Run after the generation agent supplies the actual mesh:

```powershell
blender -b --python tools/astronaut/rig_astronaut.py -- <generated.glb> artifacts/model-review/astronaut-rigged.glb
```

Do not treat the command line as proof of completion. Inspect Blender's exit code and output GLB, reopen it, verify node/bone/action names, view front and side, then render animation contact sheets for review. The current script is a scaffold pending calibration against that actual mesh. It assumes upright Y-up input and frontal +Z; it has not been run because Blender is not installed on the Windows PATH and the generated model has not arrived. It does not yet provide separately extracted arm mesh nodes: face-level segmentation must be calibrated to the real model to avoid cutting through the suit or leaving holes. Those nodes are required before claiming first-person extraction works.

## Review requirements

- Preserve the opaque dark visor and mitten hands; do not infer fingers or add finger bones.
- Check that Left/Right labels correspond to the character's own sides when viewed from the front.
- Check broad deformations at shoulders, elbows, wrists, hips, knees and ankles in all four clips. Region-based weights can bind the backpack or torso incorrectly and need mesh-specific adjustment.
- Export test clips separately if the installed Blender glTF exporter does not preserve the four NLA strips as expected. Validate in the target Three.js runtime, including its existing 2/3 scale conversion.
- Render review frames with transparent/no background and no floor. User approval and public release remain separate steps.
