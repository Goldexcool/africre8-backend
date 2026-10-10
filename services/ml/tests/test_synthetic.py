import copy
import hashlib
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from africre8_ml.currency import RATES, money, normalize
from africre8_ml.schemas import validate
from africre8_ml.synthetic import Config, FIXTURE, encoded, generate, write_dataset


class SyntheticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_hash = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
        cls.data = generate()

    def test_exact_counts_and_validation(self):
        report = validate(self.data)
        self.assertEqual(report["counts"], {"creators": 500, "opportunities": 150, "interactions": 3000, "images": 500})
        self.assertEqual(len(report["event_types"]), 8)
        self.assertLess(report["accepted_fulfillments"], report["contracted_campaigns"])
        self.assertGreater(report["creators_without_history"], 0)

    def test_fixture_preserved(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual([c["id"] for c in self.data["creators"][:50]], [c["id"] for c in fixture])
        self.assertEqual([c["display_name"] for c in self.data["creators"][:50]], [c["name"] for c in fixture])
        self.assertEqual(hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), self.original_hash)

    def test_reproducibility(self):
        self.assertEqual(encoded(self.data), encoded(generate()))
        self.assertNotEqual(encoded(self.data), encoded(generate(Config(seed=19))))

    def test_configurable_sizes_and_stable_creators(self):
        small = generate(Config(creators=50, opportunities=2, interactions=17))
        validate(small)
        large = generate(Config(creators=510, opportunities=151, interactions=5))
        validate(large)
        for a, b in zip(self.data["creators"], large["creators"]):
            a, b = dict(a), dict(b)
            a.pop("history_summary"); b.pop("history_summary")
            self.assertEqual(a, b)
        validate(generate(Config(creators=50, opportunities=1, interactions=0)))
        with self.assertRaises(ValueError): generate(Config(creators=49))
        with self.assertRaises(ValueError): generate(Config(interactions=-1))

    def test_currency(self):
        self.assertEqual(normalize("150000", "NGN"), "100.00")
        for currency in RATES:
            self.assertEqual(money(100, currency)["normalized_usd"], "100.00")
        for amount in ("0", "-1", "NaN", "Infinity"):
            with self.assertRaises(ValueError): normalize(amount, "USD")
        with self.assertRaises(ValueError): normalize("100", "BAD")

    def test_reject_duplicate_id(self):
        data = copy.deepcopy(self.data)
        data["creators"][1]["id"] = data["creators"][0]["id"]
        with self.assertRaises(ValueError): validate(data)

    def test_reject_broken_foreign_key(self):
        data = copy.deepcopy(self.data)
        data["interactions"][0]["creator_id"] = "missing"
        with self.assertRaises(ValueError): validate(data)

    def test_reject_invalid_chronology(self):
        data = copy.deepcopy(self.data)
        next(e for e in data["interactions"] if e["previous_event_id"])["occurred_at"] = "1900-01-01"
        with self.assertRaises(ValueError): validate(data)

    def test_reject_false_summary_and_statistics(self):
        for field, value in (("followers", -10), ("engagement_rate_percent", 1000)):
            data = copy.deepcopy(self.data)
            data["creators"][0]["socials"][0][field] = value
            with self.assertRaises(ValueError): validate(data)
        data = copy.deepcopy(self.data)
        data["creators"][0]["history_summary"]["completed_campaigns"] += 1
        with self.assertRaises(ValueError): validate(data)

    def test_production_separation(self):
        data = copy.deepcopy(self.data)
        data["interactions"][0]["synthetic"] = False
        with self.assertRaises(ValueError): validate(data)
        self.assertTrue(all(c["credibility_score"] is None for c in self.data["creators"]))
        self.assertTrue(all(i["status"] == "not_generated" for i in self.data["images"]))

    def test_files_checksums_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "first"
            write_dataset(self.data, output)
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            before = {p.name: p.read_bytes() for p in output.iterdir()}
            for filename, digest in manifest["files_sha256"].items():
                self.assertEqual(hashlib.sha256(before[filename]).hexdigest(), digest)
            with self.assertRaises(FileExistsError): write_dataset(self.data, output)
            self.assertEqual(before, {p.name: p.read_bytes() for p in output.iterdir()})
            second = Path(tmp) / "second"
            write_dataset(generate(), second)
            self.assertEqual(before, {p.name: p.read_bytes() for p in second.iterdir()})


if __name__ == "__main__":
    unittest.main()
