"""Allowlisted public feature extraction for recommendation relevance."""

from __future__ import annotations

import re

TOKEN_RE = re.compile(r"[^\W_]+", re.UNICODE)


def normalized_set(values: list[str] | tuple[str, ...]) -> set[str]:
    return {value.strip().casefold() for value in values if value and value.strip()}


def jaccard(left: set[str], right: set[str]) -> float:
    return len(left & right) / len(left | right) if left or right else 0.0


def token_jaccard(left: str, right: str) -> float:
    return jaccard(set(TOKEN_RE.findall(left.casefold())), set(TOKEN_RE.findall(right.casefold())))


def creator_document(creator: dict) -> str:
    """Build text from a strict allowlist; unknown/private fields are ignored."""
    audience = creator.get("audience", {})
    parts = [
        creator.get("bio", ""),
        creator.get("category", ""),
        creator.get("portfolio_description", ""),
        creator.get("content_tone", ""),
        *creator.get("niches", []),
        *creator.get("audience_interests", []),
        *audience.get("interests", []),
        *creator.get("creative_styles", []),
        *creator.get("production_capabilities", []),
    ]
    return " ".join(str(part) for part in parts if part)


def campaign_document(campaign: dict) -> str:
    audience = campaign.get("target_audience", {})
    parts = [
        campaign.get("title", ""),
        campaign.get("brief", ""),
        campaign.get("category", ""),
        campaign.get("industry", ""),
        campaign.get("product", ""),
        campaign.get("objective", "").replace("_", " "),
        campaign.get("tone", ""),
        campaign.get("creative_concept", ""),
        audience.get("description", ""),
        *campaign.get("compatible_niches", []),
        *audience.get("interests", []),
        *campaign.get("key_messages", []),
    ]
    return " ".join(str(part) for part in parts if part)
