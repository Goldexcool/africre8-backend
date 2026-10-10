"""Held-out judged-pool evaluation without labeling unjudged creators."""

from __future__ import annotations

from math import log2
from statistics import mean, median
from time import perf_counter

import numpy as np

from .engine import RecommendationEngine
from .rankers import Ranker


def _dcg(grades: list[int], k: int) -> float:
    return sum((2**grade - 1) / log2(index + 2) for index, grade in enumerate(grades[:k]))


def evaluate_ranker(
    creators: list[dict], scenarios: list[dict], ranker: Ranker, *, k: int = 10
) -> dict:
    """Evaluate only each scenario's explicitly judged creator pool."""
    engine = RecommendationEngine(creators, ranker)
    per_scenario = []
    latencies = []
    violations = 0
    for scenario in scenarios:
        judgments = {row["creator_id"]: int(row["grade"]) for row in scenario["judgments"]}
        started = perf_counter()
        response = engine.recommend(
            scenario["campaign"], candidate_ids=set(judgments), limit=k, include_excluded=True
        )
        latencies.append((perf_counter() - started) * 1000)
        ranked_ids = [row["creator_id"] for row in response["recommendations"]]
        grades = [judgments[creator_id] for creator_id in ranked_ids]
        ideal = sorted(
            (grade for creator_id, grade in judgments.items()
             if creator_id not in {row["creator_id"] for row in response["exclusions"]}),
            reverse=True,
        )
        ideal_dcg = _dcg(ideal, k)
        relevant_total = sum(grade >= 2 for grade in judgments.values())
        relevant_retrieved = sum(grade >= 2 for grade in grades[:k])
        violations += sum(not row["eligible"] for row in response["recommendations"])
        per_scenario.append({
            "scenario_id": scenario["scenario_id"],
            "ndcg_at_10": _dcg(grades, k) / ideal_dcg if ideal_dcg else 0.0,
            "precision_at_10": relevant_retrieved / k,
            "recall_at_10": relevant_retrieved / relevant_total if relevant_total else 0.0,
            "eligible_candidates": response["eligible_count"],
            "returned": len(ranked_ids),
        })

    return {
        "ranker": ranker.name,
        "scenarios": len(scenarios),
        "judgments": sum(len(scenario["judgments"]) for scenario in scenarios),
        "relevance_threshold": 2,
        "metrics": {
            "ndcg_at_10": mean(row["ndcg_at_10"] for row in per_scenario),
            "precision_at_10": mean(row["precision_at_10"] for row in per_scenario),
            "recall_at_10": mean(row["recall_at_10"] for row in per_scenario),
            "eligibility_violations": violations,
            "latency_ms_mean": mean(latencies),
            "latency_ms_median": median(latencies),
            "latency_ms_p95": float(np.percentile(latencies, 95)),
        },
        "per_scenario": per_scenario,
        "notes": [
            "Only explicitly judged candidate pools are evaluated.",
            "Unjudged creators are never assigned a relevance grade.",
            "Synthetic rubric labels measure fixture agreement, not real-world accuracy.",
        ],
    }


def benchmark_ranker(
    creators: list[dict], scenarios: list[dict], ranker: Ranker, *, k: int = 10
) -> dict:
    """Measure warm end-to-end ranking across the full creator catalog."""
    engine = RecommendationEngine(creators, ranker)
    # Warm one query so import/setup noise is not presented as steady-state latency.
    engine.recommend(scenarios[0]["campaign"], limit=k)
    latencies = []
    for scenario in scenarios:
        started = perf_counter()
        engine.recommend(scenario["campaign"], limit=k)
        latencies.append((perf_counter() - started) * 1000)
    return {
        "ranker": ranker.name,
        "runs": len(latencies),
        "candidates_per_run": len(creators),
        "latency_ms_mean": mean(latencies),
        "latency_ms_median": median(latencies),
        "latency_ms_p95": float(np.percentile(latencies, 95)),
    }
