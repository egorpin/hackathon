"""Run: PYTHONPATH=server python -m app.world.export --output world/generated."""
import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path

from .geometry import generate_planet


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def export_planet(planet, output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for chunk_id, cell_ids in planet.chunks.items():
        data = encode({"chunk_id": chunk_id, "map_version": planet.version,
                       "cells": [asdict(planet.cells[cell_id]) for cell_id in cell_ids]})
        filename = f"{chunk_id}.json"
        (output / filename).write_bytes(data)
        records.append({"chunk_id": chunk_id, "path": filename, "byte_size": len(data),
                        "sha256": hashlib.sha256(data).hexdigest()})
    manifest = {"map_version": planet.version, "radius": planet.radius,
                "landing_sites": planet.landing_sites, "encoding": "canonical-json-utf8",
                "total_chunk_bytes": sum(record["byte_size"] for record in records), "chunks": records}
    (output / "manifest.json").write_bytes(encode(manifest))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("world/generated"))
    args = parser.parse_args()
    manifest = export_planet(generate_planet(), args.output)
    print(f"{manifest['map_version']}: {len(manifest['chunks'])} chunks, {manifest['total_chunk_bytes']} bytes")
