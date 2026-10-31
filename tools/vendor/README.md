# Vendored Goldberg generator

Source: https://github.com/guillochon/goldberg-hexgrid
Commit: 51d110bb15e59c94afbf926729e6baf90f78fd6d
Copyright (c) 2026 James Guillochon. MIT; see LICENSE.goldberg-hexgrid.

goldberg_hexgrid/__init__.py, hex_grid.py and goldberg_polyhedron.py are copied unchanged.
Upstream credits https://github.com/shwuandwing/Goldberg-Polyhedron-Earth.
No upstream scripts, notebooks or plotting dependencies are executed.

Our adapter ../generate_world.py calls generate_goldberg_hex_sphere directly.
Polygon boundaries and adjacency are derived from a shared spherical Voronoi mesh:
upstream rendering.py estimates independent polygon radii, which can leave seams.
The upstream generator itself is unchanged. Only configurations passing topology
validation are exported. Full geometry is server/build-tool data, never a client import.
