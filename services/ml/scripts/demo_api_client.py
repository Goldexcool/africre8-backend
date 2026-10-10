"""Development-only demo-v2 client. The production application never imports this module."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "demo-v2"
CREATOR_FIELDS = {
    "id", "bio", "category", "portfolio_description", "content_tone", "niches",
    "audience_interests", "creative_styles", "production_capabilities", "content_languages",
    "deliverable_capabilities", "commercial_rates", "audience",
}
CAMPAIGN_FIELDS = {
    "id", "title", "brief", "category", "industry", "product", "objective", "tone",
    "creative_concept", "key_messages", "compatible_niches", "preferred_languages",
    "required_languages", "required_platforms", "deliverables", "budget", "target_audience",
    "usage_rights",
}


def allowlist(record: dict, fields: set[str]) -> dict:
    result = {key: value for key, value in record.items() if key in fields}
    if fields is CREATOR_FIELDS and "audience" in result:
        result["audience"] = {
            key: value for key, value in result["audience"].items() if key in {"markets", "interests"}
        }
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8001")
    parser.add_argument("--mode", choices=("structured", "tfidf_hybrid", "semantic_hybrid"), default="structured")
    args = parser.parse_args()
    creators = json.loads((DATA / "creators.json").read_text(encoding="utf-8"))
    campaigns = json.loads((DATA / "opportunities.json").read_text(encoding="utf-8"))
    payload = {
        "mode": args.mode,
        "campaign": allowlist(campaigns[0], CAMPAIGN_FIELDS),
        "candidates": [allowlist(row, CREATOR_FIELDS) for row in creators[:100]],
        "limit": 5,
        "include_excluded": True,
    }
    response = httpx.post(f"{args.base_url}/v1/recommendations", json=payload, timeout=120)
    response.raise_for_status()
    print(json.dumps(response.json(), indent=2))


if __name__ == "__main__":
    main()
