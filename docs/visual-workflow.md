# Visual iteration and approval

Current branch: `codex/planet-visuals-terrain`.

## Approval stages

1. Show generated reference images to the user and collect corrections. No multiview or 3D generation before reference approval.
2. Process approved references using the Tesla server ComfyUI pipeline. Show every resulting model as rendered previews and provide its GLB. No game integration before model approval.
3. Show the astronaut's skeleton and idle, walk, run and jump animations for review.
4. Show the integrated scene and interface, then run the user's laptop performance checks.

Check generation completion at intervals of at least five minutes. Stage review artifacts under `artifacts/model-review/`. Only approved models are copied to `client/public/assets/models/`; list approved model names in `manifest.json`. An empty list deliberately retains existing temporary shapes.

Concept board v5 and paired front 0° / side 90° references are approved for six assets (astronaut, drill, oxygen generator, warehouse, dome, robot rover). The user explicitly excluded every resource, including ice, from generation. Iron, sulfur, stone and ice retain the procedural rock scatter geometry; ice uses the same shape family as iron with a different material.

## Art direction

Broad faceted low-poly shapes, simple matte white/graphite equipment with recolorable accent panels. No tiny details on any asset. No ground, floor, backdrop geometry or pedestal in generated objects. The astronaut has an opaque visor and mitten gloves without separate fingers. The drill has a simple conical bit, never a threaded screw. The rover is a six-wheel scientific robot and has no gameplay in this iteration.

The drill has four support legs. Storage is a walk-in building, not a chest. The latest resource direction supersedes painted veins: small scattered ore rocks and chips above the middle of each cell, with a clear border margin and no dominant central boulder. The procedural deposit is a review prototype, not an approved ComfyUI asset. The initial character scale was reduced by 1.5. The latest request additionally halves the current character height and eye height; width, hands and collision footprint retain their previous scale.

## Runtime changes

Game and assets run locally; generation services are not runtime dependencies. Terrain is procedurally generated from a stable seed derived from the world ID, sent as world.terrain_seed. JavaScript and Python share the same generator: four broad hills (1.2–1.6 m) and three craters (0.8–1.1 m deep), with randomized positions and widths. Both camera modes display this surface. Logical cell IDs and adjacency remain unchanged. Server movement follows this surface, applies sprint and jump physics, and continues landing after input timeout. Existing building/mountain collision discs remain active during jumps.

`player.input` retains `seq` and `move` and accepts optional `heading`, `jump` and `running`. Jump is edge-triggered and server-authoritative. Player DTOs contain `heading`, `altitude`, `vertical_speed`, `moving`, `running`, and `color`. Snapshot/delta `simulation_time` drives the shared sky cycle; it pauses in the lobby. Terrain is advertised as `world.terrain`.

`F` toggles the flashlight, `Space` jumps and `Shift` runs. Graphics quality controls render resolution and bounded atmospheric particles. The HUD reports FPS, p95 frame time, draw calls and triangle count. These are measurements from the running browser, not a promise of 60 FPS.

Player color is server-validated and persisted. Building color comes from its creator, so changing a player's color also changes previously placed buildings. Generated models expose an `Accent` material; neutral surfaces stay readable.

See [visual-testing.md](visual-testing.md) for safe size experiments and real laptop acceptance.
