from __future__ import annotations

import copy
import json
import shutil
import sys
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from africre8_ml.credibility import CredibilityModel
from africre8_ml.credibility.offline_evaluation import load_and_evaluate


def make_journey(
    ordinal: int,
    *,
    creator_id: str = "creator-test",
    verification: str = "pass",
    complete: bool = True,
    late: bool = False,
    rating: int | None = 5,
    revision: bool = False,
    cancellation: str | None = None,
    dispute: str | None = None,
) -> list[dict]:
    journey_id = f"journey-{ordinal}"
    contract_id = f"contract-{ordinal}"
    start = date(2026, 1, 1) + timedelta(days=ordinal * 20)
    events = []

    def add(kind: str, details: dict, *, contract: bool) -> None:
        event_id = f"event-{ordinal}-{len(events) + 1}"
        events.append({
            "id": event_id,
            "journey_id": journey_id,
            "creator_id": creator_id,
            "opportunity_id": f"opportunity-{ordinal}",
            "contract_id": contract_id if contract else None,
            "event_type": kind,
            "occurred_at": (start + timedelta(days=len(events))).isoformat(),
            "previous_event_id": events[-1]["id"] if events else None,
            "details": details,
        })

    add("invitation", {}, contract=False)
    add("match", {}, contract=False)
    add("negotiation", {}, contract=False)
    add("contract", {"deadline": (start + timedelta(days=5)).isoformat()}, contract=True)
    if cancellation:
        add("cancellation", {"attribution": cancellation, "party": cancellation}, contract=True)
        return events
    add("submission", {"deliverables_received": True, "late": late}, contract=True)
    add("verification", {
        "outcome": verification,
        "evidence_sufficient": verification != "insufficient_evidence",
    }, contract=True)
    if revision:
        add("revision_requested", {"within_revision_limit": True}, contract=True)
        add("revision_submitted", {"changes_made": ["corrected"]}, contract=True)
    if dispute:
        add("dispute", {"status": "open", "attribution": None}, contract=True)
        if dispute != "open":
            add("dispute_resolved", {"attribution": dispute}, contract=True)
    if complete:
        add("completion", {"accepted_fulfillment": True}, contract=True)
    if rating is not None:
        add("rating", {"stars": rating}, contract=True)
    return events


class CredibilityTests(unittest.TestCase):
    def setUp(self):
        self.model = CredibilityModel()

    def test_new_creator_has_insufficient_evidence(self):
        result = self.model.score("new", [])
        self.assertEqual("insufficient_evidence", result["status"])
        self.assertIsNone(result["credibility_score"])
        self.assertEqual("insufficient", result["evidence_tier"])
        self.assertEqual(0, result["evidence_coverage"]["component_weight_coverage"])
        self.assertIsNone(result["posterior_uncertainty"]["index_interval_90"])

    def test_one_success_is_smoothed_not_perfect(self):
        result = self.model.score("creator-test", make_journey(1))
        self.assertEqual("limited", result["evidence_tier"])
        self.assertGreater(result["credibility_score"], 66.67)
        self.assertLess(result["credibility_score"], 100)
        self.assertEqual(71.43, result["components"]["fulfillment_reliability"]["score"])

    def test_multiple_successes_build_evidence(self):
        events = sum((make_journey(index) for index in range(1, 7)), [])
        result = self.model.score("creator-test", events)
        self.assertEqual("substantial", result["evidence_tier"])
        self.assertGreater(result["components"]["fulfillment_reliability"]["score"], 80)

    def test_moderate_and_substantial_tier_thresholds(self):
        three = sum((make_journey(index) for index in range(1, 4)), [])
        six_without_feedback = sum((make_journey(index, rating=None) for index in range(1, 7)), [])
        self.assertEqual("moderate", self.model.score("creator-test", three)["evidence_tier"])
        self.assertEqual(
            "moderate", self.model.score("creator-test", six_without_feedback)["evidence_tier"]
        )

    def test_repeated_failed_fulfillment_lowers_score(self):
        events = sum((make_journey(index, verification="fail", complete=False, rating=2) for index in range(1, 5)), [])
        result = self.model.score("creator-test", events)
        self.assertLess(result["credibility_score"], 60)
        self.assertEqual(4, result["components"]["fulfillment_reliability"]["observations"])

    def test_single_failure_is_smoothed_but_not_hidden(self):
        result = self.model.score(
            "creator-test", make_journey(1, verification="fail", complete=False, rating=None)
        )
        self.assertEqual(57.14, result["components"]["fulfillment_reliability"]["score"])
        self.assertEqual("limited", result["evidence_tier"])

    def test_late_submission_reduces_timeliness(self):
        on_time = self.model.score("creator-test", make_journey(1, late=False))
        late = self.model.score("creator-test", make_journey(1, late=True))
        self.assertLess(late["components"]["timeliness"]["score"], on_time["components"]["timeliness"]["score"])

    def test_brand_attribution_does_not_penalize_fulfillment(self):
        clean = self.model.score("creator-test", make_journey(1))
        brand_dispute = self.model.score("creator-test", make_journey(1, dispute="brand"))
        creator_dispute = self.model.score("creator-test", make_journey(1, dispute="creator"))
        self.assertEqual(
            clean["components"]["fulfillment_reliability"]["score"],
            brand_dispute["components"]["fulfillment_reliability"]["score"],
        )
        self.assertLess(
            creator_dispute["components"]["fulfillment_reliability"]["score"],
            brand_dispute["components"]["fulfillment_reliability"]["score"],
        )

    def test_brand_related_lateness_is_not_inferred(self):
        result = self.model.score("creator-test", make_journey(1, late=True, dispute="brand"))
        self.assertEqual(57.14, result["components"]["timeliness"]["score"])
        self.assertTrue(any("does not attribute the cause" in item for item in result["explanations"]))
        self.assertTrue(any("brand-attributed" in item for item in result["explanations"]))

    def test_unresolved_dispute_is_treated_cautiously(self):
        unresolved = self.model.score(
            "creator-test", make_journey(1, dispute="open", complete=False, rating=None)
        )
        brand = self.model.score("creator-test", make_journey(1, dispute="brand"))
        self.assertLess(unresolved["credibility_score"], brand["credibility_score"])
        self.assertEqual(1, unresolved["attributable_disputes"]["open"])

    def test_successful_revision_is_counted_once(self):
        result = self.model.score("creator-test", make_journey(1, verification="partial", revision=True))
        self.assertEqual(1, result["evidence"]["successful_corrections"])
        self.assertEqual(1, result["components"]["fulfillment_reliability"]["observations"])

    def test_missing_rating_is_not_negative_feedback(self):
        missing = self.model.score("creator-test", make_journey(1, rating=None))
        five_star = self.model.score("creator-test", make_journey(1, rating=5))
        self.assertEqual(0, missing["components"]["campaign_feedback"]["observations"])
        self.assertAlmostEqual(missing["credibility_score"], five_star["credibility_score"], places=2)
        self.assertEqual(["fulfillment", "timeliness"], missing["evidence_coverage"]["observed_components"])
        self.assertEqual(["feedback"], missing["evidence_coverage"]["missing_components"])
        self.assertEqual(0.8, missing["evidence_coverage"]["component_weight_coverage"])
        sensitivity = missing["missing_component_sensitivity"]
        self.assertLess(sensitivity["index_range"][0], missing["credibility_score"])
        self.assertGreater(sensitivity["index_range"][1], missing["credibility_score"])

    def test_posterior_interval_narrows_with_more_evidence(self):
        one = self.model.score("creator-test", make_journey(1))
        six = self.model.score(
            "creator-test", sum((make_journey(index) for index in range(1, 7)), [])
        )
        one_interval = one["posterior_uncertainty"]["index_interval_90"]
        six_interval = six["posterior_uncertainty"]["index_interval_90"]
        self.assertLess(six_interval[1] - six_interval[0], one_interval[1] - one_interval[0])
        self.assertIn("not a future-success probability", six["posterior_uncertainty"]["interpretation"])

    def test_evidence_duplication_is_rejected(self):
        events = make_journey(1)
        duplicate = copy.deepcopy(events[-1])
        duplicate["id"] = "duplicate-rating"
        duplicate["occurred_at"] = "2026-02-01"
        duplicate["previous_event_id"] = events[-1]["id"]
        events.append(duplicate)
        with self.assertRaisesRegex(ValueError, "Duplicate rating"):
            self.model.score("creator-test", events)

    def test_inconsistent_event_sequence_is_rejected(self):
        events = make_journey(1)
        events[4]["previous_event_id"] = "missing-event"
        with self.assertRaisesRegex(ValueError, "Broken event chain"):
            self.model.score("creator-test", events)

    def test_private_truth_fields_are_ignored(self):
        events = make_journey(1)
        baseline = self.model.score("creator-test", events)
        altered = copy.deepcopy(events)
        for event in altered:
            event["reliability"] = 0.0
            event["generator_truth"] = {"work_quality": 0.0}
        self.assertEqual(baseline, self.model.score("creator-test", altered))

    def test_deterministic_output_and_explanations(self):
        events = make_journey(1, late=True, rating=3, revision=True)
        first = self.model.score("creator-test", events)
        second = self.model.score("creator-test", copy.deepcopy(events))
        self.assertEqual(first, second)
        self.assertEqual("bayesian-credibility-v2", first["model_version"])
        self.assertTrue(any("Bayesian-smoothed" in item for item in first["explanations"]))
        self.assertIn("not a calibrated probability", first["score_interpretation"])


class DemoV2CredibilityIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with (ROOT / "data" / "demo-v2" / "creators.json").open(encoding="utf-8") as handle:
            cls.creators = json.load(handle)
        with (ROOT / "data" / "demo-v2" / "interactions.json").open(encoding="utf-8") as handle:
            cls.events = json.load(handle)
        model = CredibilityModel()
        cls.results = [model.score(creator["id"], cls.events) for creator in cls.creators]

    def test_all_real_histories_validate_without_double_counting(self):
        self.assertEqual(360, sum(row["evidence"]["contracted_campaigns"] for row in self.results))
        self.assertEqual(149, sum(row["credibility_score"] is not None for row in self.results))
        # Forty revision re-verifications collapse to the final outcome of the
        # same contract, leaving 331 independent verified campaigns.
        self.assertEqual(331, sum(row["evidence"]["verification_outcomes"][key] for row in self.results for key in ("pass", "partial", "fail", "insufficient_evidence")))

    def test_public_results_contain_no_private_truth_fields(self):
        def keys(value):
            if isinstance(value, dict):
                return set(value) | set().union(*(keys(item) for item in value.values()))
            if isinstance(value, list):
                return set().union(*(keys(item) for item in value)) if value else set()
            return set()

        public_keys = keys(self.results)
        for forbidden in ("reliability", "delivery_consistency", "work_quality", "responsiveness", "generator_truth"):
            self.assertNotIn(forbidden, public_keys)

    def test_offline_evaluation_regenerates_unpublished_truth_in_memory(self):
        source = ROOT / "data" / "demo-v2"
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for filename in ("creators.json", "interactions.json", "manifest.json"):
                shutil.copyfile(source / filename, target / filename)
            report = load_and_evaluate(target)
            self.assertEqual(500, report["scope"]["creators"])
            self.assertFalse((target / "generator_truth.json").exists())


if __name__ == "__main__":
    unittest.main()
