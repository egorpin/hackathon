# Astronaut GLB import and rig

`rig_astronaut.py` prepares the supplied low-poly character in Blender 4.5. It
normalizes Blender's imported Z-up mesh to 1.8 units high with feet at zero,
keeps the source PBR maps and vertex color attributes, creates a 15-bone rig,
and exports four glTF NLA clips: `Idle`, `Walk`, `Run`, and `Jump`.

The six skinned arm mesh nodes are separate, non-overlapping triangle
partitions: `LeftArm`, `LeftForearm`, `LeftHand`, `RightArm`, `RightForearm`,
and `RightHand`. The suit body is `AstronautSuit`. The character faces glTF +Z
(Blender -Y); subject-left is +X. Original material panels remain in the source
white, graphite, and orange colors.

```powershell
blender -b --python tools/astronaut/rig_astronaut.py -- input.glb output.glb
blender -b --python tools/astronaut/render_clips.py -- output.glb review-frames
python tools/astronaut/validate_import.py output.glb
```

`render_clips.py` mutes all but one NLA track and renders four poses per clip.
The output GLB must pass `validate_import.py`, and its clip renders should be
visually reviewed for deformation before integration.
