from __future__ import annotations

import copy
import json
import sys
import time
import unittest
from decimal import Decimal
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from africre8_ml.recommendation.data import load_demo_v2, load_public_json
from africre8_ml.recommendation.eligibility import check_eligibility
from africre8_ml.recommendation.engine import RecommendationEngine
from africre8_ml.recommendation.evaluation import benchmark_ranker, evaluate_ranker
from africre8_ml.recommendation.rankers import (
    SEMANTIC_HYBRID_WEIGHTS,
    SemanticHybridRanker,
    StructuredRanker,
    TfidfRanker,
)


class RecordingEncoder:
    def __init__(self):
        self.calls = []

    def encode(self, sentences, **kwargs):
        self.calls.append((list(sentences), dict(kwargs)))
        vectors = []
        for sentence in sentences:
            values = np.array([
                len(sentence),
                sum(ord(char) for char in sentence) % 997,
                sentence.count(" ") + 1,
            ], dtype=np.float32)
            if kwargs.get("normalize_embeddings"):
                values /= np.linalg.norm(values)
            vectors.append(values)
        return np.asarray(vectors)


class RecommendationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data_dir = ROOT / "data" / "demo-v2"
        cls.creators, cls.scenarios = load_demo_v2(cls.data_dir)
        cls.creator_by_id = {creator["id"]: creator for creator in cls.creators}
        cls.structured = StructuredRanker()
        cls.tfidf = TfidfRanker(cls.creators)

    def test_dataset_contract(self):
        self.assertEqual(500, len(self.creators))
        self.assertEqual(45, len(self.scenarios))
        self.assertEqual(540, sum(len(row["judgments"]) for row in self.scenarios))

    def test_private_truth_loader_is_blocked(self):
        with self.assertRaises(ValueError):
            load_public_json(self.data_dir, "generator_truth.json")

    def test_eligibility_matches_all_mandatory_labels(self):
        mismatches = []
        for scenario in self.scenarios:
            for judgment in scenario["judgments"]:
                actual = check_eligibility(
                    self.creator_by_id[judgment["creator_id"]], scenario["campaign"]
                ).eligible
                expected = "mandatory_constraint_failure" not in judgment["reason_codes"]
                if actual != expected:
                    mismatches.append((scenario["scenario_id"], judgment["creator_id"]))
        self.assertEqual([], mismatches)

    def test_exclusion_reasons_are_specific(self):
        found = set()
        for scenario in self.scenarios:
            for judgment in scenario["judgments"]:
                result = check_eligibility(
                    self.creator_by_id[judgment["creator_id"]], scenario["campaign"]
                )
                found.update(reason.split(":", 1)[0] for reason in result.exclusion_reasons)
        self.assertTrue(
            {"missing_required_content_language", "missing_required_platform", "missing_required_format", "over_budget"}
            <= found
        )

    def test_budget_uses_normalized_fee_and_quantity(self):
        campaign = copy.deepcopy(self.scenarios[0]["campaign"])
        creator = next(
            self.creator_by_id[j["creator_id"]]
            for j in self.scenarios[0]["judgments"]
            if check_eligibility(self.creator_by_id[j["creator_id"]], campaign).eligible
        )
        original = check_eligibility(creator, campaign)
        self.assertIsNotNone(original.estimated_fee_usd)
        campaign["budget"]["normalized_usd"] = str(original.estimated_fee_usd - Decimal("0.01"))
        result = check_eligibility(creator, campaign)
        self.assertFalse(result.eligible)
        self.assertIn("over_budget", result.exclusion_reasons)

    def test_engine_never_returns_ineligible_candidate(self):
        response = RecommendationEngine(self.creators, self.structured).recommend(
            self.scenarios[0]["campaign"],
            candidate_ids={row["creator_id"] for row in self.scenarios[0]["judgments"]},
            include_excluded=True,
        )
        excluded = {row["creator_id"] for row in response["exclusions"]}
        returned = {row["creator_id"] for row in response["recommendations"]}
        self.assertFalse(excluded & returned)
        self.assertTrue(all(row["eligible"] for row in response["recommendations"]))

    def test_response_and_explanation_contract(self):
        response = RecommendationEngine(self.creators, self.tfidf).recommend(
            self.scenarios[0]["campaign"], limit=3
        )
        self.assertEqual("tfidf", response["ranker"])
        self.assertEqual(3, len(response["recommendations"]))
        self.assertEqual([1, 2, 3], [row["rank"] for row in response["recommendations"]])
        for row in response["recommendations"]:
            self.assertIn("text_cosine_similarity", row["explanation"]["components"])
            self.assertIn("estimated_fee_usd", row)

    def test_private_or_popularity_fields_do_not_affect_scores(self):
        creator = copy.deepcopy(self.creators[0])
        changed = copy.deepcopy(creator)
        changed["generator_truth"] = {"persistent_quality": 1.0}
        changed["credibility_score"] = 100
        changed["history_summary"] = {"successful_deliveries": 999999}
        for social in changed["socials"]:
            social["followers"] = 999999999
        campaign = self.scenarios[0]["campaign"]
        self.assertEqual(
            self.structured.score(campaign, [creator])[0]["score"],
            self.structured.score(campaign, [changed])[0]["score"],
        )
        self.assertEqual(
            TfidfRanker([creator]).score(campaign, [creator])[0]["score"],
            TfidfRanker([changed]).score(campaign, [changed])[0]["score"],
        )

    def test_evaluation_uses_only_judged_pool(self):
        report = evaluate_ranker(self.creators, self.scenarios[:2], self.structured)
        self.assertEqual(2, report["scenarios"])
        self.assertEqual(24, report["judgments"])
        self.assertEqual(0, report["metrics"]["eligibility_violations"])
        self.assertIn("Only explicitly judged candidate pools are evaluated.", report["notes"])

    def test_full_catalog_benchmark_contract(self):
        report = benchmark_ranker(self.creators, self.scenarios[:2], self.structured)
        self.assertEqual(2, report["runs"])
        self.assertEqual(500, report["candidates_per_run"])
        self.assertGreaterEqual(report["latency_ms_p95"], 0)

    def test_inference_benchmark_is_practical(self):
        engines = [
            RecommendationEngine(self.creators, self.structured),
            RecommendationEngine(self.creators, self.tfidf),
        ]
        for engine in engines:
            started = time.perf_counter()
            for scenario in self.scenarios[:5]:
                engine.recommend(scenario["campaign"], limit=10)
            elapsed = time.perf_counter() - started
            self.assertLess(elapsed, 5.0)

    def test_semantic_hybrid_uses_e5_prefixes_and_normalization(self):
        encoder = RecordingEncoder()
        ranker = SemanticHybridRanker(self.creators[:4], encoder=encoder, batch_size=2)
        scores = ranker.score(self.scenarios[0]["campaign"], self.creators[:4])
        passages, passage_options = encoder.calls[0]
        queries, query_options = encoder.calls[1]
        self.assertTrue(all(text.startswith("passage: ") for text in passages))
        self.assertTrue(all(text.startswith("query: ") for text in queries))
        self.assertTrue(passage_options["normalize_embeddings"])
        self.assertTrue(query_options["normalize_embeddings"])
        self.assertEqual(4, len(scores))
        self.assertEqual({"semantic": 0.65, "structured": 0.35}, SEMANTIC_HYBRID_WEIGHTS)

    def test_local_e5_cpu_inference_when_assets_present(self):
        model_path = ROOT / "huggingface" / "intfloat--multilingual-e5-small"
        if not model_path.exists():
            self.skipTest("Ignored local E5 assets are not present")
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(
            str(model_path), device="cpu", local_files_only=True, trust_remote_code=False
        )
        embeddings = model.encode(
            ["query: sustainable fashion", "passage: créatrice de mode durable"],
            convert_to_numpy=True,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        self.assertEqual((2, 384), embeddings.shape)
        np.testing.assert_allclose(np.linalg.norm(embeddings, axis=1), [1.0, 1.0], atol=1e-5)

    def test_all_rankers_share_the_same_engine_filter(self):
        encoder = RecordingEncoder()
        semantic = SemanticHybridRanker(self.creators, encoder=encoder)
        candidate_ids = {row["creator_id"] for row in self.scenarios[0]["judgments"]}
        rankers = [self.structured, self.tfidf, semantic]
        returned = []
        excluded = []
        for ranker in rankers:
            response = RecommendationEngine(self.creators, ranker).recommend(
                self.scenarios[0]["campaign"],
                candidate_ids=candidate_ids,
                limit=20,
                include_excluded=True,
            )
            returned.append({row["creator_id"] for row in response["recommendations"]})
            excluded.append({row["creator_id"] for row in response["exclusions"]})
        self.assertTrue(all(group == returned[0] for group in returned[1:]))
        self.assertTrue(all(group == excluded[0] for group in excluded[1:]))


if __name__ == "__main__":
    unittest.main()
