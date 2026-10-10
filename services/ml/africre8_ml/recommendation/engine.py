"""Candidate filtering, ranking, and stable explanation responses."""

from __future__ import annotations

from time import perf_counter

from .eligibility import check_eligibility
from .rankers import Ranker


def _top_signals(components: dict[str, float]) -> list[dict]:
    return [
        {"signal": key, "value": round(value, 6)}
        for key, value in sorted(components.items(), key=lambda item: (-item[1], item[0]))
        if value > 0
    ][:3]


class RecommendationEngine:
    def __init__(self, creators: list[dict], ranker: Ranker):
        self._creators = list(creators)
        self._ranker = ranker

    def recommend(
        self,
        campaign: dict,
        *,
        candidate_ids: set[str] | None = None,
        limit: int = 10,
        include_excluded: bool = False,
    ) -> dict:
        started = perf_counter()
        candidates = [
            creator for creator in self._creators
            if candidate_ids is None or creator["id"] in candidate_ids
        ]
        eligible: list[dict] = []
        exclusions: list[dict] = []
        eligibility_by_id = {}
        for creator in candidates:
            result = check_eligibility(creator, campaign)
            eligibility_by_id[creator["id"]] = result
            if result.eligible:
                eligible.append(creator)
            elif include_excluded:
                exclusions.append({"creator_id": creator["id"], **result.as_dict()})

        scored = self._ranker.score(campaign, eligible)
        scored.sort(key=lambda row: (-row["score"], row["creator_id"]))
        recommendations = []
        for rank, row in enumerate(scored[:limit], start=1):
            eligibility = eligibility_by_id[row["creator_id"]]
            recommendations.append({
                "rank": rank,
                "creator_id": row["creator_id"],
                "score": round(row["score"], 8),
                "eligible": True,
                "estimated_fee_usd": str(eligibility.estimated_fee_usd),
                "explanation": {
                    "summary": "Passed all mandatory constraints and ranked by campaign relevance.",
                    "top_signals": _top_signals(row["components"]),
                    "components": {key: round(value, 8) for key, value in row["components"].items()},
                },
            })

        return {
            "campaign_id": campaign["id"],
            "ranker": self._ranker.name,
            "candidate_count": len(candidates),
            "eligible_count": len(eligible),
            "recommendations": recommendations,
            "exclusions": sorted(exclusions, key=lambda row: row["creator_id"]),
            "latency_ms": round((perf_counter() - started) * 1000, 4),
        }
