"""Evaluate Phase 2 rankers against immutable demo-v2 judged pools."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .data import load_demo_v2
from .engine import RecommendationEngine
from .evaluation import benchmark_ranker, evaluate_ranker
from .rankers import SemanticHybridRanker, StructuredRanker, TfidfRanker


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path, default=Path("data/demo-v2"))
    parser.add_argument("--sample-scenario", action="append")
    parser.add_argument("--model", type=Path)
    args = parser.parse_args()
    creators, scenarios = load_demo_v2(args.data)
    rankers = [StructuredRanker(), TfidfRanker(creators)]
    if args.model:
        rankers.append(SemanticHybridRanker(creators, model_path=args.model))
    reports = [evaluate_ranker(creators, scenarios, ranker) for ranker in rankers]
    benchmarks = [benchmark_ranker(creators, scenarios, ranker) for ranker in rankers]
    sample_ids = args.sample_scenario or ["eval_scenario_001"]
    samples = []
    for sample_id in sample_ids:
        scenario = next(row for row in scenarios if row["scenario_id"] == sample_id)
        grades = {row["creator_id"]: row["grade"] for row in scenario["judgments"]}
        for ranker in rankers:
            response = RecommendationEngine(creators, ranker).recommend(
                scenario["campaign"],
                candidate_ids=set(grades),
                limit=3,
            )
            for row in response["recommendations"]:
                row["synthetic_grade"] = grades[row["creator_id"]]
            samples.append({
                "scenario_id": sample_id,
                "campaign": {
                    "title": scenario["campaign"]["title"],
                    "required_languages": scenario["campaign"]["required_languages"],
                    "target_markets": scenario["campaign"]["target_audience"]["markets"],
                    "cross_category_rationale": scenario["campaign"]["cross_category_rationale"],
                },
                **response,
            })
    performance = [
        {
            "ranker": ranker.name,
            "model_load_ms": getattr(ranker, "model_load_ms", None),
            "creator_encoding_ms": getattr(ranker, "creator_encoding_ms", None),
        }
        for ranker in rankers
    ]
    print(json.dumps({
        "evaluation": reports,
        "full_catalog_benchmarks": benchmarks,
        "performance": performance,
        "samples": samples,
    }, indent=2))


if __name__ == "__main__":
    main()
