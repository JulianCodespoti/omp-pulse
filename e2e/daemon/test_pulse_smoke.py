#!/usr/bin/env python3
"""Exercise the smoke suite's real offline fixture function without a daemon."""
import ast
import json
import os
from pathlib import Path
import tempfile
import unittest


class OfflineFixtureTests(unittest.TestCase):
    def test_fresh_root_and_repeat_seed(self):
        source = Path(__file__).with_name("pulse-smoke.py")
        tree = ast.parse(source.read_text())
        # Importing the script runs the network suite. Compile only its actual
        # fixture factory, so this test cannot contact services or invoke OMP.
        function = next(node for node in tree.body
                        if isinstance(node, ast.FunctionDef)
                        and node.name == "seed_fixtures_on_disk")
        module = ast.Module(body=[function], type_ignores=[])
        with tempfile.TemporaryDirectory(prefix="pulse-fixture-test-") as root:
            namespace = {"ROOT": root, "os": os, "json": json, "time": __import__("time")}
            exec(compile(module, str(source), "exec"), namespace)
            seed = namespace["seed_fixtures_on_disk"]
            for _ in range(2):
                entries = seed(root)
                self.assertEqual(len(entries), 3)
                files = list(Path(root).rglob("*.jsonl"))
                self.assertEqual(len(files), 3)
                for file in files:
                    self.assertTrue(file.is_relative_to(root))
                    lines = [json.loads(line) for line in file.read_text().splitlines()]
                    self.assertEqual(lines[0]["type"], "session")
                    self.assertEqual(lines[0]["cwd"], root)


if __name__ == "__main__":
    unittest.main()
