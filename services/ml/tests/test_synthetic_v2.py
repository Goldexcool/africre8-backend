import copy
import hashlib
import json
import unittest

from africre8_ml.schemas_v2 import validate_v2
from africre8_ml.synthetic import FIXTURE, encoded, generate as generate_v1
from africre8_ml.synthetic_v2 import ConfigV2, generate_v2, quality_report


class SyntheticV2Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_hash = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
        cls.data = generate_v2()
        cls.report = validate_v2(cls.data)

    def test_counts_uniqueness_and_relationships(self):
        self.assertTrue(self.report["valid"])
        self.assertEqual(self.report["counts"], {"creators": 500, "brands": 50, "opportunities": 150,
                         "interactions": 3000, "images": 500, "evaluation": 45, "generator_truth": 500})
        self.assertEqual(len({x["id"] for x in self.data["interactions"]}), 3000)

    def test_identity_and_fixture_preservation(self):
        source = json.loads(FIXTURE.read_text(encoding="utf-8"))
        v1 = generate_v1()
        self.assertEqual([x["id"] for x in self.data["creators"]], [x["id"] for x in v1["creators"]])
        self.assertEqual([x["display_name"] for x in self.data["creators"]], [x["display_name"] for x in v1["creators"]])
        self.assertEqual([x["image_asset_id"] for x in self.data["creators"]], [x["image_asset_id"] for x in v1["creators"]])
        self.assertEqual([x["id"] for x in self.data["creators"][:50]], [x["id"] for x in source])
        self.assertEqual(hashlib.sha256(FIXTURE.read_bytes()).hexdigest(), self.fixture_hash)

    def test_geography_language_and_campaign_quality(self):
        q = quality_report(self.data)
        self.assertEqual(q["countries"], 18)
        self.assertGreaterEqual(q["creators_without_english"], 100)
        self.assertGreaterEqual(q["creators_with_domestic_audience"], 400)
        self.assertEqual(q["unique_biographies"], 500)
        self.assertEqual(q["unique_briefs"], 150)
        self.assertGreater(q["cross_category_campaigns_with_rationale"], 0)

    def test_brand_reuse_and_platform_specific_pricing(self):
        uses = {}
        for o in self.data["opportunities"]:
            uses[o["brand_id"]] = uses.get(o["brand_id"], 0) + 1
        self.assertEqual(set(uses.values()), {3})
        for creator in self.data["creators"]:
            capabilities = {(x["platform"], x["format"]) for x in creator["deliverable_capabilities"]}
            rates = {(x["platform"], x["format"]) for x in creator["commercial_rates"]}
            self.assertEqual(capabilities, rates)

    def test_credibility_evidence_and_experience_diversity(self):
        q = quality_report(self.data)
        self.assertGreater(q["experience"]["zero_contracts"], 100)
        self.assertGreater(q["experience"]["four_plus_contracts"], 20)
        self.assertGreater(q["experience"]["creators_with_ratings"], 100)
        self.assertGreater(q["event_types"]["revision_requested"], 10)
        self.assertGreater(q["event_types"]["cancellation"], 10)
        self.assertGreater(q["event_types"]["withdrawal"], 10)
        self.assertGreater(q["event_types"]["dispute"], 5)
        self.assertGreater(q["verification_outcomes"]["fail"], 10)
        self.assertGreater(q["verification_outcomes"]["partial"], 20)

    def test_private_traits_are_isolated(self):
        private = {"reliability", "responsiveness", "delivery_consistency", "work_quality"}
        self.assertTrue(all(private <= set(x) for x in self.data["generator_truth"]))
        self.assertTrue(all(not (private & set(x)) for x in self.data["creators"]))
        self.assertTrue(all(not (private & set(j)) for s in self.data["evaluation"] for j in s["judgments"]))

    def test_evaluation_panels(self):
        production_ids = {x["id"] for x in self.data["opportunities"]}
        cold_scenarios = 0
        for scenario in self.data["evaluation"]:
            self.assertNotIn(scenario["campaign"]["id"], production_ids)
            grades = {x["grade"] for x in scenario["judgments"]}
            self.assertIn(0, grades)
            self.assertTrue(grades & {2, 3})
            cold_scenarios += any("cold_start_creator" in x["reason_codes"] for x in scenario["judgments"])
        self.assertGreaterEqual(cold_scenarios, 30)

    def test_deterministic_generation(self):
        self.assertEqual(encoded(self.data), encoded(generate_v2()))
        self.assertNotEqual(encoded(self.data), encoded(generate_v2(ConfigV2(seed=20261010))))

    def test_validation_rejects_integrity_and_leakage_errors(self):
        broken = copy.deepcopy(self.data)
        broken["interactions"][0]["creator_id"] = "missing"
        with self.assertRaises(ValueError): validate_v2(broken)
        leaked = copy.deepcopy(self.data)
        leaked["creators"][0]["reliability"] = .99
        with self.assertRaises(ValueError): validate_v2(leaked)
        bad_campaign = copy.deepcopy(self.data)
        bad_campaign["opportunities"][0]["cross_category_rationale"] = "unsupported exception"
        with self.assertRaises(ValueError): validate_v2(bad_campaign)


if __name__ == "__main__":
    unittest.main()
