from __future__ import annotations

import json
import gc
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

try:
    from fastapi.testclient import TestClient
except ImportError:  # Keeps the failure readable in environments missing declared API dependencies.
    TestClient = None

from africre8_ml.api.app import create_app
from africre8_ml.api.service import DEFAULT_MODEL_PATH, ModelServices


def money(amount: str) -> dict:
    return {
        "amount": amount,
        "currency": "USD",
        "normalized_usd": amount,
        "rate_version": "test-v1",
        "purpose": "test",
    }


def creator(identifier: str, *, language: str = "en", rate: str = "100.00") -> dict:
    return {
        "id": identifier,
        "bio": "A food creator explaining practical recipes.",
        "category": "Food",
        "niches": ["home cooking"],
        "audience_interests": ["recipes"],
        "content_languages": [language],
        "deliverable_capabilities": [{"platform": "tiktok", "format": "short_video"}],
        "commercial_rates": [{
            "platform": "tiktok",
            "format": "short_video",
            "base_rate": money(rate),
        }],
        "audience": {"markets": [{"country_code": "NG", "share_percent": 70.0}]},
    }


def campaign() -> dict:
    return {
        "id": "campaign-1",
        "brief": "Show a useful weeknight recipe for families.",
        "category": "Food",
        "compatible_niches": ["home cooking"],
        "required_languages": ["en"],
        "required_platforms": ["tiktok"],
        "deliverables": [{"platform": "tiktok", "format": "short_video", "quantity": 1}],
        "budget": money("500.00"),
        "target_audience": {"interests": ["recipes"], "markets": ["NG"]},
    }


def event(kind: str, number: int, previous: str | None, details: dict, *, contract=True) -> dict:
    return {
        "id": f"event-{number}",
        "journey_id": "journey-1",
        "creator_id": "creator-1",
        "opportunity_id": "opportunity-1",
        "contract_id": "contract-1" if contract else None,
        "event_type": kind,
        "occurred_at": f"2026-01-{number:02d}",
        "previous_event_id": previous,
        "details": details,
    }


def successful_history() -> list[dict]:
    rows = [
        ("invitation", {}, False),
        ("match", {}, False),
        ("negotiation", {}, False),
        ("contract", {"deadline": "2026-01-10"}, True),
        ("submission", {"deliverables_received": True, "late": False}, True),
        ("verification", {"outcome": "pass", "evidence_sufficient": True}, True),
        ("completion", {"accepted_fulfillment": True}, True),
        ("rating", {"stars": 5}, True),
    ]
    result = []
    for index, (kind, details, contracted) in enumerate(rows, 1):
        result.append(event(kind, index, result[-1]["id"] if result else None, details, contract=contracted))
    return result


def established_history() -> list[dict]:
    combined = []
    for journey in range(1, 7):
        rows = successful_history()
        for index, row in enumerate(rows, 1):
            row["id"] = f"event-{journey}-{index}"
            row["journey_id"] = f"journey-{journey}"
            row["opportunity_id"] = f"opportunity-{journey}"
            row["contract_id"] = f"contract-{journey}" if row["contract_id"] else None
            row["occurred_at"] = f"2026-{journey:02d}-{index:02d}"
            row["previous_event_id"] = f"event-{journey}-{index - 1}" if index > 1 else None
        combined.extend(rows)
    return combined


@unittest.skipIf(TestClient is None, "FastAPI test dependencies are unavailable")
class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app(ModelServices(semantic_enabled=False)))

    def test_health_does_not_load_semantic_model(self):
        response = self.client.get("/health")
        self.assertEqual(200, response.status_code)
        self.assertEqual("ok", response.json()["status"])
        ready = self.client.get("/ready").json()
        self.assertEqual("disabled", ready["semantic"]["status"])

    def test_structured_recommendation_preserves_eligibility_and_exclusions(self):
        payload = {
            "mode": "structured",
            "campaign": campaign(),
            "candidates": [creator("eligible"), creator("wrong-language", language="fr")],
            "limit": 10,
            "include_excluded": True,
        }
        response = self.client.post("/v1/recommendations", json=payload)
        self.assertEqual(200, response.status_code, response.text)
        body = response.json()
        self.assertEqual(2, body["candidate_count"])
        self.assertEqual(1, body["eligible_count"])
        self.assertEqual(1, body["excluded_count"])
        self.assertEqual("structured-v1", body["model_version"])
        self.assertEqual("eligible", body["recommendations"][0]["creator_id"])
        self.assertIn("missing_required_content_language:en", body["exclusions"][0]["exclusion_reasons"])

    def test_tfidf_mode_and_explanation_contract(self):
        payload = {"mode": "tfidf_hybrid", "campaign": campaign(), "candidates": [creator("one")]}
        response = self.client.post("/v1/recommendations", json=payload)
        self.assertEqual(200, response.status_code, response.text)
        body = response.json()
        self.assertEqual("tfidf_hybrid", body["ranker"])
        self.assertIn("text_cosine_similarity", body["recommendations"][0]["explanation"]["components"])

    def test_duplicate_candidates_and_private_fields_are_rejected(self):
        duplicate = {"mode": "structured", "campaign": campaign(), "candidates": [creator("same"), creator("same")]}
        self.assertEqual(422, self.client.post("/v1/recommendations", json=duplicate).status_code)
        private = creator("one")
        private["generator_truth"] = {"reliability": 1.0}
        payload = {"mode": "structured", "campaign": campaign(), "candidates": [private]}
        self.assertEqual(422, self.client.post("/v1/recommendations", json=payload).status_code)

    def test_invalid_enum_and_oversized_candidate_limit_are_rejected(self):
        payload = {"mode": "unknown", "campaign": campaign(), "candidates": [creator("one")]}
        self.assertEqual(422, self.client.post("/v1/recommendations", json=payload).status_code)
        payload["mode"] = "structured"
        payload["limit"] = 101
        self.assertEqual(422, self.client.post("/v1/recommendations", json=payload).status_code)

    def test_empty_oversized_and_invalid_campaigns_are_rejected(self):
        payload = {"mode": "structured", "campaign": campaign(), "candidates": []}
        self.assertEqual(422, self.client.post("/v1/recommendations", json=payload).status_code)
        payload["candidates"] = [creator(f"creator-{index}") for index in range(501)]
        self.assertEqual(422, self.client.post("/v1/recommendations", json=payload).status_code)
        payload = {"mode": "structured", "campaign": {"brief": "missing budget"}, "candidates": [creator("one")]}
        self.assertEqual(422, self.client.post("/v1/recommendations", json=payload).status_code)

    def test_cold_start_credibility_returns_http_200_and_null_score(self):
        response = self.client.post("/v1/credibility/score", json={"creator_id": "new", "events": []})
        self.assertEqual(200, response.status_code, response.text)
        self.assertIsNone(response.json()["credibility_score"])
        self.assertEqual("insufficient", response.json()["evidence_tier"])

    def test_established_creator_reaches_substantial_evidence(self):
        response = self.client.post(
            "/v1/credibility/score",
            json={"creator_id": "creator-1", "events": established_history()},
        )
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("substantial", response.json()["evidence_tier"])
        self.assertEqual(6, response.json()["evidence_coverage"]["independent_fulfillment_observations"])

    def test_credibility_success_and_invalid_chronology(self):
        payload = {"creator_id": "creator-1", "events": successful_history()}
        response = self.client.post("/v1/credibility/score", json=payload)
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("bayesian-credibility-v2", response.json()["model_version"])
        payload["events"][4]["previous_event_id"] = "wrong"
        response = self.client.post("/v1/credibility/score", json=payload)
        self.assertEqual(422, response.status_code)
        self.assertNotIn("Traceback", response.text)

    def test_credibility_uncertainty_missing_feedback_and_determinism(self):
        history = successful_history()[:-1]
        payload = {"creator_id": "creator-1", "events": history}
        first = self.client.post("/v1/credibility/score", json=payload)
        second = self.client.post("/v1/credibility/score", json=payload)
        self.assertEqual(200, first.status_code, first.text)
        self.assertEqual(first.json(), second.json())
        body = first.json()
        self.assertIn("feedback", body["evidence_coverage"]["missing_components"])
        self.assertIsNotNone(body["posterior_uncertainty"]["index_interval_90"])
        self.assertIsNotNone(body["missing_component_sensitivity"])

    def test_credibility_private_truth_and_unknown_detail_rejected(self):
        history = successful_history()
        history[0]["generator_truth"] = {"reliability": 1.0}
        response = self.client.post("/v1/credibility/score", json={"creator_id": "creator-1", "events": history})
        self.assertEqual(422, response.status_code)
        history = successful_history()
        history[0]["details"]["private_reliability"] = 1.0
        response = self.client.post("/v1/credibility/score", json={"creator_id": "creator-1", "events": history})
        self.assertEqual(422, response.status_code)

    def test_batch_preserves_order_and_is_atomic_for_invalid_history(self):
        payload = {"creators": [
            {"creator_id": "new", "events": []},
            {"creator_id": "creator-1", "events": successful_history()},
        ]}
        response = self.client.post("/v1/credibility/batch", json=payload)
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual(["new", "creator-1"], [row["creator_id"] for row in response.json()["results"]])
        payload["creators"][1]["events"][4]["previous_event_id"] = "broken"
        self.assertEqual(422, self.client.post("/v1/credibility/batch", json=payload).status_code)


@unittest.skipUnless(TestClient is not None and DEFAULT_MODEL_PATH.is_dir(), "cached semantic model unavailable")
class RealSemanticApiTest(unittest.TestCase):
    def test_real_cached_model_inference(self):
        client = TestClient(create_app(ModelServices()))
        payload = {"mode": "semantic_hybrid", "campaign": campaign(), "candidates": [creator("one")]}
        response = client.post("/v1/recommendations", json=payload)
        self.assertEqual(200, response.status_code, response.text)
        self.assertEqual("semantic_hybrid", response.json()["ranker"])
        self.assertEqual("ready", client.get("/ready").json()["semantic"]["status"])
        client.app.state.services._ranker_cache.clear()
        client.app.state.services._encoder = None
        client.close()
        del client
        gc.collect()


if __name__ == "__main__":
    unittest.main()
