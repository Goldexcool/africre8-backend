"""Mandatory campaign eligibility checks with machine-readable exclusions."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class EligibilityResult:
    eligible: bool
    exclusion_reasons: tuple[str, ...]
    estimated_fee_usd: Decimal | None
    campaign_budget_usd: Decimal

    def as_dict(self) -> dict:
        return {
            "eligible": self.eligible,
            "exclusion_reasons": list(self.exclusion_reasons),
            "estimated_fee_usd": (
                str(self.estimated_fee_usd) if self.estimated_fee_usd is not None else None
            ),
            "campaign_budget_usd": str(self.campaign_budget_usd),
        }


def _rate_index(creator: dict) -> dict[tuple[str, str], dict]:
    return {
        (rate["platform"], rate["format"]): rate
        for rate in creator.get("commercial_rates", [])
    }


def check_eligibility(creator: dict, campaign: dict) -> EligibilityResult:
    reasons: list[str] = []
    capabilities = {
        (item["platform"], item["format"])
        for item in creator.get("deliverable_capabilities", [])
    }
    capability_platforms = {platform for platform, _ in capabilities}
    content_languages = set(creator.get("content_languages", []))

    for language in campaign.get("required_languages", []):
        if language not in content_languages:
            reasons.append(f"missing_required_content_language:{language}")

    for platform in campaign.get("required_platforms", []):
        if platform not in capability_platforms:
            reasons.append(f"missing_required_platform:{platform}")

    rates = _rate_index(creator)
    fee = Decimal("0")
    fee_known = True
    for deliverable in campaign.get("deliverables", []):
        key = (deliverable["platform"], deliverable["format"])
        if key not in capabilities:
            reasons.append(
                f"missing_required_format:{deliverable['platform']}:{deliverable['format']}"
            )
            fee_known = False
            continue
        rate = rates.get(key)
        if rate is None:
            reasons.append(f"missing_commercial_rate:{key[0]}:{key[1]}")
            fee_known = False
            continue
        unit_fee = Decimal(rate["base_rate"]["normalized_usd"])
        rights = campaign.get("usage_rights", {})
        if rights.get("paid_usage"):
            # Demo-v2 currently has no paid-usage campaigns. The conservative 12-month
            # multiplier prevents underpricing when a future record omits a duration.
            multiplier = rate.get("usage_rights_multiplier", {}).get("12_months_paid", "1")
            unit_fee *= Decimal(multiplier)
        if rights.get("category_exclusivity_days", 0) > 0:
            unit_fee *= Decimal(rate.get("category_exclusivity_30_days_multiplier", "1"))
        fee += unit_fee * int(deliverable["quantity"])

    budget = Decimal(campaign["budget"]["normalized_usd"])
    if fee_known and fee > budget:
        reasons.append("over_budget")

    unique_reasons = tuple(dict.fromkeys(reasons))
    return EligibilityResult(
        eligible=not unique_reasons,
        exclusion_reasons=unique_reasons,
        estimated_fee_usd=fee if fee_known else None,
        campaign_budget_usd=budget,
    )
