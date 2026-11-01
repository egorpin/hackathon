"""Build tiny hand-authored OBJ models from basic geometric primitives."""

from __future__ import annotations

import math
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assets" / "models" / "simple-energy"


class Obj:
    def __init__(self, name: str):
        self.name = name
        self.vertices: list[tuple[float, float, float]] = []
        self.faces: list[tuple[str, tuple[int, ...]]] = []

    def box(self, name, center, size, material="white"):
        cx, cy, cz = center
        sx, sy, sz = (v / 2 for v in size)
        base = len(self.vertices) + 1
        self.vertices += [
            (cx - sx, cy - sy, cz - sz), (cx + sx, cy - sy, cz - sz),
            (cx + sx, cy + sy, cz - sz), (cx - sx, cy + sy, cz - sz),
            (cx - sx, cy - sy, cz + sz), (cx + sx, cy - sy, cz + sz),
            (cx + sx, cy + sy, cz + sz), (cx - sx, cy + sy, cz + sz),
        ]
        for face in ((0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1),
                     (1, 5, 6, 2), (2, 6, 7, 3), (4, 0, 3, 7)):
            self.faces.append((material, tuple(base + i for i in face)))

    def cylinder(self, name, center, radius, depth, axis="z", material="gray", sides=12):
        cx, cy, cz = center
        base = len(self.vertices) + 1
        for end in (-depth / 2, depth / 2):
            for i in range(sides):
                a = 2 * math.pi * i / sides
                p, q = radius * math.cos(a), radius * math.sin(a)
                if axis == "x": self.vertices.append((cx + end, cy + p, cz + q))
                elif axis == "y": self.vertices.append((cx + p, cy + end, cz + q))
                else: self.vertices.append((cx + p, cy + q, cz + end))
        self.faces.append((material, tuple(base + i for i in range(sides - 1, -1, -1))))
        self.faces.append((material, tuple(base + sides + i for i in range(sides))))
        for i in range(sides):
            j = (i + 1) % sides
            self.faces.append((material, (base + i, base + j, base + sides + j, base + sides + i)))

    def blade(self, angle_deg, center=(0, -0.18, 2.75), material="white"):
        """Flat tapered wind-turbine blade in the XZ plane."""
        a = math.radians(angle_deg)
        ux, uz = math.cos(a), math.sin(a)
        vx, vz = -uz, ux
        cx, cy, cz = center
        root, tip, wr, wt, thick = 0.20, 1.10, 0.16, 0.07, 0.08
        pts = []
        for y in (cy - thick / 2, cy + thick / 2):
            for d, w in ((root, wr), (tip, wt)):
                pts.extend([(cx + ux*d + vx*w, y, cz + uz*d + vz*w),
                            (cx + ux*d - vx*w, y, cz + uz*d - vz*w)])
        base = len(self.vertices) + 1
        self.vertices += pts
        for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
                  (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.faces.append((material, tuple(base + i for i in f)))

    def save(self):
        OUT.mkdir(parents=True, exist_ok=True)
        lines = [f"mtllib simple-energy.mtl", f"o {self.name}"]
        lines += [f"v {x:.5f} {y:.5f} {z:.5f}" for x, y, z in self.vertices]
        current = None
        for material, face in self.faces:
            if material != current:
                lines.append(f"usemtl {material}")
                current = material
            lines.append("f " + " ".join(map(str, face)))
        (OUT / f"{self.name}.obj").write_text("\n".join(lines) + "\n", encoding="ascii")


def solar_panel():
    o = Obj("solar-panel")
    o.box("base", (0, 0, .15), (1.2, .75, .3), "orange")
    o.box("mast", (0, 0, .62), (.16, .16, .65), "gray")
    o.box("panel", (0, 0, 1.2), (1.9, .10, 1.05), "blue")
    o.box("frame_top", (0, 0, 1.75), (2.05, .15, .10), "white")
    o.box("frame_bottom", (0, 0, .65), (2.05, .15, .10), "white")
    o.box("frame_left", (-1, 0, 1.2), (.10, .15, 1.2), "white")
    o.box("frame_right", (1, 0, 1.2), (.10, .15, 1.2), "white")
    o.save()


def power_building():
    o = Obj("power-building")
    o.box("foundation", (0, 0, .15), (2.6, 2.0, .3), "gray")
    o.box("body", (0, 0, 1.05), (2.2, 1.7, 1.5), "white")
    o.box("door", (0, -.87, .85), (.75, .10, 1.15), "gray")
    o.box("canopy", (0, -1.05, 1.6), (1.15, .45, .18), "orange")
    o.box("side_unit", (1.2, .25, .9), (.45, 1.0, 1.15), "orange")
    o.cylinder("roof_unit", (0, 0, 1.98), .52, .40, "z", "orange", 10)
    o.save()


def wind_turbine():
    o = Obj("wind-turbine")
    o.box("base", (0, 0, .18), (1.55, 1.25, .36), "orange")
    o.box("tower", (0, 0, 1.35), (.38, .38, 2.0), "white")
    o.box("nacelle", (0, 0, 2.75), (.70, 1.05, .48), "orange")
    o.cylinder("hub", (0, -.60, 2.75), .25, .28, "y", "gray", 12)
    for angle in (90, 210, 330):
        o.blade(angle)
    o.save()


def robot_minion():
    o = Obj("robot-minion")
    o.box("torso", (0, 0, 1.15), (.9, .55, .75), "white")
    o.box("chest", (0, -.31, 1.18), (.55, .08, .42), "orange")
    o.box("head", (0, 0, 1.85), (.92, .62, .55), "white")
    o.box("face", (0, -.33, 1.86), (.62, .06, .30), "dark")
    o.box("eye_l", (-.18, -.37, 1.88), (.09, .03, .16), "blue")
    o.box("eye_r", (.18, -.37, 1.88), (.09, .03, .16), "blue")
    o.box("arm_l", (-.62, 0, 1.15), (.28, .30, .80), "orange")
    o.box("arm_r", (.62, 0, 1.15), (.28, .30, .80), "orange")
    o.box("leg_l", (-.25, 0, .48), (.32, .40, .65), "white")
    o.box("leg_r", (.25, 0, .48), (.32, .40, .65), "white")
    o.box("foot_l", (-.25, -.10, .12), (.43, .65, .22), "orange")
    o.box("foot_r", (.25, -.10, .12), (.43, .65, .22), "orange")
    o.box("backpack", (0, .40, 1.25), (.58, .28, .72), "orange")
    o.save()


def write_materials():
    OUT.mkdir(parents=True, exist_ok=True)
    colors = {"orange": (.95, .27, .03), "white": (.82, .80, .73),
              "gray": (.12, .14, .16), "dark": (.02, .03, .04), "blue": (.04, .34, .78)}
    text = []
    for name, color in colors.items():
        text += [f"newmtl {name}", f"Kd {color[0]} {color[1]} {color[2]}", "Ns 24", ""]
    (OUT / "simple-energy.mtl").write_text("\n".join(text), encoding="ascii")


if __name__ == "__main__":
    write_materials()
    solar_panel()
    wind_turbine()
    robot_minion()
    print(OUT)
