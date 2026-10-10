"""Synthetic-only validation. Hidden generator truth is confined to this module."""

from __future__ import annotations

import json
import copy
from pathlib import Path
from statistics import mean

import numpy as np

from .model import CredibilityModel


def _ranks(values: list[float]) -> np.ndarray:
    values_array = np.asarray(values, dtype=float)
    order = np.argsort(values_array, kind="mergesort")
    ranks = np.empty(len(values_array), dtype=float)
    index = 0
    while index < len(order):
        end = index + 1
        while end < len(order) and values_array[order[end]] == values_array[order[index]]:
            end += 1
        ranks[order[index:end]] = (index + end - 1) / 2 + 1
        index = end
    return ranks


def _spearman(left: list[float], right: list[float]) -> float:
    if len(left) < 2:
        return 0.0
    return float(np.corrcoef(_ranks(left), _ranks(right))[0, 1])


def evaluate_synthetic(
    creators: list[dict], events: list[dict], generator_truth: list[dict]
) -> dict:
    """Compare public-event scores with private traits without returning private rows."""
    model = CredibilityModel()
    results = {creator["id"]: model.score(creator["id"], events) for creator in creators}
    truth_by_creator = {row["creator_id"]: row for row in generator_truth}
    paired = []
    hidden_traits = {key: [] for key in ("reliability", "delivery_consistency", "work_quality", "responsiveness")}
    for creator_id, result in results.items():
        if result["credibility_score"] is None:
            continue
        truth = truth_by_creator[creator_id]
        hidden_composite = mean([
            truth["reliability"], truth["delivery_consistency"], truth["work_quality"]
        ])
        paired.append((result["credibility_score"], hidden_composite))
        for key in hidden_traits:
            hidden_traits[key].append(truth[key])

    scores = [row[0] for row in paired]
    hidden = [row[1] for row in paired]
    sorted_hidden = sorted(hidden)
    lower_cut = sorted_hidden[max(0, len(sorted_hidden) // 4 - 1)]
    upper_cut = sorted_hidden[min(len(sorted_hidden) - 1, (3 * len(sorted_hidden)) // 4)]
    lower_scores = [score for score, trait in paired if trait <= lower_cut]
    upper_scores = [score for score, trait in paired if trait >= upper_cut]

    first_contract_deltas = []
    events_by_journey: dict[str, list[dict]] = {}
    for event in events:
        events_by_journey.setdefault(event["journey_id"], []).append(event)
    for creator_id, result in results.items():
        if result["credibility_score"] is None:
            continue
        completed_journeys = [
            journey for journey in events_by_journey.values()
            if journey[0]["creator_id"] == creator_id
            and any(event["event_type"] == "contract" for event in journey)
            and any(event["event_type"] in {"completion", "verification", "cancellation"} for event in journey)
        ]
        if not completed_journeys:
            continue
        completed_journeys.sort(key=lambda journey: min(event["occurred_at"] for event in journey))
        first_score = model.score(creator_id, completed_journeys[0])["credibility_score"]
        if first_score is not None:
            first_contract_deltas.append(abs(first_score - result["credibility_score"]))

    deterministic = all(model.score(creator_id, events) == result for creator_id, result in results.items())
    disputed_journey = next(
        journey for journey in events_by_journey.values()
        if any(event["event_type"] == "dispute_resolved" for event in journey)
        and any(event["event_type"] == "completion" for event in journey)
    )
    dispute_creator_id = disputed_journey[0]["creator_id"]
    dispute_sensitivity = {}
    for attribution in ("creator", "brand", "shared", "neither"):
        variant = copy.deepcopy(disputed_journey)
        resolution = next(event for event in variant if event["event_type"] == "dispute_resolved")
        resolution["details"]["attribution"] = attribution
        result = model.score(dispute_creator_id, variant)
        dispute_sensitivity[attribution] = {
            "overall_score": result["credibility_score"],
            "fulfillment_score": result["components"]["fulfillment_reliability"]["score"],
        }
    unresolved = []
    for event in disputed_journey:
        unresolved.append(copy.deepcopy(event))
        if event["event_type"] == "dispute":
            break
    result = model.score(dispute_creator_id, unresolved)
    dispute_sensitivity["unresolved"] = {
        "overall_score": result["credibility_score"],
        "fulfillment_score": result["components"]["fulfillment_reliability"]["score"],
    }

    tier_counts: dict[str, int] = {}
    for result in results.values():
        key = result["evidence_tier"]
        tier_counts[key] = tier_counts.get(key, 0) + 1
    no_contract_creators = sum(
        result["evidence"]["contracted_campaigns"] == 0 for result in results.values()
    )
    contracted_but_inconclusive = sum(
        result["evidence"]["contracted_campaigns"] > 0
        and result["evidence"]["fulfillment_observations"] == 0
        for result in results.values()
    )
    return {
        "scope": {
            "creators": len(creators),
            "scored_creators": len(paired),
            "no_contract_creators": no_contract_creators,
            "contracted_but_inconclusive_creators": contracted_but_inconclusive,
            "total_insufficient_evidence": no_contract_creators + contracted_but_inconclusive,
        },
        "hidden_truth_validation": {
            "spearman_score_vs_hidden_composite": _spearman(scores, hidden),
            "spearman_by_trait": {
                key: _spearman(scores, values) for key, values in hidden_traits.items()
            },
            "lower_hidden_quartile_mean_score": mean(lower_scores) if lower_scores else None,
            "upper_hidden_quartile_mean_score": mean(upper_scores) if upper_scores else None,
            "separation_points": mean(upper_scores) - mean(lower_scores) if lower_scores and upper_scores else None,
            "private_truth_in_public_output": False,
        },
        "stability": {
            "mean_absolute_first_to_full_score_change": mean(first_contract_deltas) if first_contract_deltas else None,
            "creators_compared": len(first_contract_deltas),
            "deterministic": deterministic,
        },
        "evidence_robustness": {
            "evidence_tier_counts": dict(sorted(tier_counts.items())),
            "contracts_without_conclusive_fulfillment": sum(
                result["evidence"]["contracted_campaigns"] - result["evidence"]["fulfillment_observations"]
                for result in results.values()
            ),
            "creators_scored_without_ratings": sum(
                result["credibility_score"] is not None and result["evidence"]["ratings"] == 0
                for result in results.values()
            ),
            "missing_ratings_treated_as_failures": False,
        },
        "dispute_attribution_sensitivity": dispute_sensitivity,
        "shrinkage_examples": {
            "prior": "Beta(4,2), provisional pending audited production calibration",
            "prior_mean": round(4 / 6 * 100, 2),
            "one_success_posterior": round(5 / 7 * 100, 2),
            "one_failure_posterior": round(4 / 7 * 100, 2),
            "five_successes_posterior": round(9 / 11 * 100, 2),
        },
        "limitations": [
            "Generator truth is synthetic and is used only for this offline diagnostic.",
            "Correlation with hidden traits is not evidence of real-world predictive validity.",
            "Sparse histories and generator mechanics limit separation.",
        ],
    }


def load_and_evaluate(dataset_dir: Path) -> dict:
    with (dataset_dir / "creators.json").open(encoding="utf-8") as handle:
        creators = json.load(handle)
    with (dataset_dir / "interactions.json").open(encoding="utf-8") as handle:
        events = json.load(handle)
    # Private truth is never required in source control. A local copy is used when
    # present; otherwise the pinned deterministic generator recreates it in memory.
    truth_path = dataset_dir / "generator_truth.json"
    if truth_path.is_file():
        with truth_path.open(encoding="utf-8") as handle:
            truth = json.load(handle)
    else:
        from africre8_ml.synthetic_v2 import ConfigV2, generate_v2

        with (dataset_dir / "manifest.json").open(encoding="utf-8") as handle:
            manifest = json.load(handle)
        truth = generate_v2(ConfigV2(**manifest["config"]))["generator_truth"]
    return evaluate_synthetic(creators, events, truth)
