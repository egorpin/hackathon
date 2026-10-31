import unittest
from collections import Counter, defaultdict
import numpy as np
from generate_world import build_world, geometry

class GoldbergTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.world=build_world()
        cls.cells=[c for chunk in cls.world["chunks"] for c in chunk["cells"]]
        cls.by_id={c["cell_id"]:c for c in cls.cells}

    def test_face_counts(self):
        self.assertEqual(Counter(len(c["vertices"]) for c in self.cells),{5:12,6:1430})

    def test_closed_surface_and_shared_edges(self):
        edges=defaultdict(list); vertices=set()
        for cell in self.cells:
            polygon=[tuple(v) for v in cell["vertices"]];vertices.update(polygon)
            for a,b in zip(polygon,polygon[1:]+polygon[:1]):
                edges[tuple(sorted((a,b)))].append(cell["cell_id"])
            for vertex in polygon:self.assertAlmostEqual(np.linalg.norm(vertex),100,places=6)
            a,b,c=map(np.array,polygon[:3])
            self.assertGreater(np.dot(np.cross(b-a,c-a),cell["center"]),0)
        self.assertTrue(all(len(owners)==2 for owners in edges.values()))
        self.assertEqual(len(vertices)-len(edges)+len(self.cells),2)
        for a,b in edges.values():
            self.assertIn(a,self.by_id[b]["neighbors"])
            self.assertIn(b,self.by_id[a]["neighbors"])
        for cell in self.cells:
            self.assertEqual(len(cell["neighbors"]),len(cell["vertices"]))

    def test_landing_cells_and_unused_mountains(self):
        landing=[c for c in self.cells if c["landing_slot"] is not None]
        self.assertEqual(len(landing),4)
        self.assertTrue(all(len(c["vertices"])==5 for c in landing))
        self.assertEqual(sum(c["surface"]=="landing" for c in landing),1)
        self.assertEqual(sum(c["surface"]=="mountain" and not c["buildable"] for c in landing),3)

    def test_chunks_are_connected_and_cells_unique(self):
        self.assertEqual(len(self.cells),len(self.by_id))
        for chunk in self.world["chunks"]:
            ids={c["cell_id"] for c in chunk["cells"]};seen=set();todo=[next(iter(ids))]
            while todo:
                cell=todo.pop()
                if cell in seen:continue
                seen.add(cell);todo.extend(n for n in self.by_id[cell]["neighbors"] if n in ids and n not in seen)
            self.assertEqual(ids,seen);self.assertLessEqual(len(ids),8)

    def test_stable_ids_geometry_and_four_players(self):
        other=build_world(occupied=4)
        cells=[c for chunk in other["chunks"] for c in chunk["cells"]]
        self.assertEqual([(c["cell_id"],c["vertices"],c["neighbors"]) for c in cells],
                         [(c["cell_id"],c["vertices"],c["neighbors"]) for c in self.cells])
        self.assertEqual(sum(c["surface"]=="landing" for c in cells),4)
        self.assertFalse(any(c["surface"]=="mountain" for c in cells))

    def test_shell_has_no_gameplay_map(self):
        shell=self.world["state"]["world"]["shell"]
        self.assertEqual(set(shell),{"radius","detail","vertices","faces"})
        self.assertEqual(len(shell["faces"]),92)
        self.assertLess(len(shell["faces"]),len(self.cells)/10)

if __name__=="__main__":unittest.main()
