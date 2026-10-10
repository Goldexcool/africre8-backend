"""Strict public request and response contracts for the ML service."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator

Identifier = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=10_000)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]


class StrictModel(BaseModel):
    # JSON necessarily represents dates and fixed-point money as strings; field
    # constraints and validators remain strict while permitting those parses.
    model_config = ConfigDict(extra="forbid")


class Money(StrictModel):
    amount: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    currency: Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
    normalized_usd: Decimal = Field(ge=0, max_digits=18, decimal_places=2)
    rate_version: ShortText
    purpose: ShortText | None = None


class Deliverable(StrictModel):
    platform: Code
    format: Code
    quantity: int = Field(ge=1, le=100)


class Capability(StrictModel):
    platform: Code
    format: Code


class RateMultipliers(StrictModel):
    organic_only: Decimal | None = Field(default=None, gt=0)
    six_months_paid: Decimal | None = Field(default=None, alias="6_months_paid", gt=0)
    ninety_days_paid: Decimal | None = Field(default=None, alias="90_days_paid", gt=0)
    twelve_months_paid: Decimal | None = Field(default=None, alias="12_months_paid", gt=0)


class CommercialRate(StrictModel):
    platform: Code
    format: Code
    base_rate: Money
    usage_rights_multiplier: RateMultipliers = Field(default_factory=RateMultipliers)
    category_exclusivity_30_days_multiplier: Decimal = Field(default=Decimal("1"), gt=0)
    includes: list[ShortText] = Field(default_factory=list, max_length=50)


class AudienceMarket(StrictModel):
    country_code: Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$")]
    share_percent: float = Field(ge=0, le=100)


class CreatorAudience(StrictModel):
    markets: list[AudienceMarket] = Field(default_factory=list, max_length=100)
    interests: list[ShortText] = Field(default_factory=list, max_length=100)


class CreatorProfile(StrictModel):
    """Allowlisted ML features; personal and popularity fields are intentionally absent."""

    id: Identifier
    bio: LongText = ""
    category: ShortText = ""
    portfolio_description: LongText = ""
    content_tone: ShortText = ""
    niches: list[ShortText] = Field(default_factory=list, max_length=100)
    audience_interests: list[ShortText] = Field(default_factory=list, max_length=100)
    creative_styles: list[ShortText] = Field(default_factory=list, max_length=100)
    production_capabilities: list[ShortText] = Field(default_factory=list, max_length=100)
    content_languages: list[Code] = Field(default_factory=list, max_length=50)
    deliverable_capabilities: list[Capability] = Field(default_factory=list, max_length=200)
    commercial_rates: list[CommercialRate] = Field(default_factory=list, max_length=200)
    audience: CreatorAudience = Field(default_factory=CreatorAudience)


class TargetAudience(StrictModel):
    description: LongText = ""
    interests: list[ShortText] = Field(default_factory=list, max_length=100)
    markets: list[Code] = Field(default_factory=list, max_length=100)


class UsageRights(StrictModel):
    paid_usage: bool = False
    category_exclusivity_days: int = Field(default=0, ge=0, le=3650)
    organic_days: int | None = Field(default=None, ge=0, le=3650)


class Campaign(StrictModel):
    id: Identifier | None = None
    title: ShortText = ""
    brief: LongText
    category: ShortText = ""
    industry: ShortText = ""
    product: ShortText = ""
    objective: ShortText = ""
    tone: ShortText = ""
    creative_concept: LongText = ""
    key_messages: list[ShortText] = Field(default_factory=list, max_length=100)
    compatible_niches: list[ShortText] = Field(default_factory=list, max_length=100)
    preferred_languages: list[Code] = Field(default_factory=list, max_length=50)
    required_languages: list[Code] = Field(default_factory=list, max_length=50)
    required_platforms: list[Code] = Field(default_factory=list, max_length=50)
    deliverables: list[Deliverable] = Field(min_length=1, max_length=100)
    budget: Money
    target_audience: TargetAudience = Field(default_factory=TargetAudience)
    usage_rights: UsageRights = Field(default_factory=UsageRights)


class RecommendationRequest(StrictModel):
    mode: Literal["structured", "tfidf_hybrid", "semantic_hybrid"]
    campaign: Campaign
    candidates: list[CreatorProfile] = Field(min_length=1, max_length=500)
    limit: int = Field(default=10, ge=1, le=100)
    include_excluded: bool = False

    @model_validator(mode="after")
    def unique_candidates(self):
        ids = [item.id for item in self.candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("candidate creator IDs must be unique")
        return self


class Signal(StrictModel):
    signal: str
    value: float


class Explanation(StrictModel):
    summary: str
    top_signals: list[Signal]
    components: dict[str, float]


class Recommendation(StrictModel):
    rank: int
    creator_id: str
    score: float
    eligible: bool
    estimated_fee_usd: str | None
    explanation: Explanation


class Exclusion(StrictModel):
    creator_id: str
    eligible: bool
    exclusion_reasons: list[str]
    estimated_fee_usd: str | None
    campaign_budget_usd: str


class RecommendationResponse(StrictModel):
    campaign_id: str | None
    ranker: Literal["structured", "tfidf_hybrid", "semantic_hybrid"]
    model_version: str
    candidate_count: int
    eligible_count: int
    excluded_count: int
    recommendations: list[Recommendation]
    exclusions: list[Exclusion]
    latency_ms: float
    warnings: list[str]


EventType = Literal[
    "invitation", "match", "negotiation", "withdrawal", "contract", "submission",
    "cancellation", "verification", "revision_requested", "revision_submitted",
    "dispute", "dispute_resolved", "completion", "rating",
]

DETAIL_FIELDS: dict[str, frozenset[str]] = {
    "invitation": frozenset({"availability_at_invitation", "direction"}),
    "match": frozenset({"exception_reason", "preference_reasons"}),
    "negotiation": frozenset({"result", "topics"}),
    "withdrawal": frozenset({"attribution", "party", "reason"}),
    "contract": frozenset({"agreed_fee", "deadline", "deliverables", "required_language", "usage_rights"}),
    "submission": frozenset({"deliverables_received", "evidence_asset_id", "late"}),
    "cancellation": frozenset({"attribution", "party", "reason"}),
    "verification": frozenset({"evidence_sufficient", "outcome", "requirements_checked", "requirements_passed", "source"}),
    "revision_requested": frozenset({"reason", "within_revision_limit"}),
    "revision_submitted": frozenset({"changes_made"}),
    "dispute": frozenset({"attribution", "reason", "status"}),
    "dispute_resolved": frozenset({"attribution", "resolution"}),
    "completion": frozenset({"accepted_fulfillment", "payment_status_excluded"}),
    "rating": frozenset({"review_text", "stars"}),
}

FORBIDDEN_PRIVATE_KEYS = frozenset({
    "generator_truth", "reliability", "delivery_consistency", "work_quality", "responsiveness",
})


def _all_keys(value: Any):
    if isinstance(value, dict):
        for key, child in value.items():
            yield str(key)
            yield from _all_keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _all_keys(child)


class HistoryEvent(StrictModel):
    id: Identifier
    journey_id: Identifier
    creator_id: Identifier
    opportunity_id: Identifier
    contract_id: Identifier | None = None
    event_type: EventType
    occurred_at: date
    previous_event_id: Identifier | None = None
    details: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_details(self):
        private = FORBIDDEN_PRIVATE_KEYS & set(_all_keys(self.details))
        if private:
            raise ValueError(f"private evidence fields are forbidden: {', '.join(sorted(private))}")
        unknown = set(self.details) - DETAIL_FIELDS[self.event_type]
        if unknown:
            raise ValueError(f"unsupported {self.event_type} detail fields: {', '.join(sorted(unknown))}")
        if self.event_type == "verification" and self.details.get("outcome") not in {
            "pass", "partial", "fail", "insufficient_evidence"
        }:
            raise ValueError("verification outcome is required and invalid")
        if self.event_type == "rating":
            stars = self.details.get("stars")
            if type(stars) is not int or not 1 <= stars <= 5:
                raise ValueError("rating stars must be an integer from 1 to 5")
        if self.event_type == "submission" and any(
            type(self.details.get(name)) is not bool for name in ("deliverables_received", "late")
        ):
            raise ValueError("submission requires boolean deliverables_received and late fields")
        if self.event_type == "verification" and type(self.details.get("evidence_sufficient")) is not bool:
            raise ValueError("verification requires boolean evidence_sufficient")
        if self.event_type == "completion" and type(self.details.get("accepted_fulfillment")) is not bool:
            raise ValueError("completion requires boolean accepted_fulfillment")
        if self.event_type in {"cancellation", "withdrawal"} and self.details.get("attribution") not in {"creator", "brand"}:
            raise ValueError(f"{self.event_type} attribution must be creator or brand")
        if self.event_type == "dispute_resolved" and self.details.get("attribution") not in {"creator", "brand", "shared", "neither"}:
            raise ValueError("resolved dispute attribution is invalid")
        return self


class CredibilityRequest(StrictModel):
    creator_id: Identifier
    events: list[HistoryEvent] = Field(default_factory=list, max_length=5000)

    @model_validator(mode="after")
    def validate_event_ownership(self):
        if any(event.creator_id != self.creator_id for event in self.events):
            raise ValueError("all history events must belong to creator_id")
        ids = [event.id for event in self.events]
        if len(ids) != len(set(ids)):
            raise ValueError("history event IDs must be unique")
        return self


class CredibilityBatchRequest(StrictModel):
    creators: list[CredibilityRequest] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_batch(self):
        ids = [item.creator_id for item in self.creators]
        if len(ids) != len(set(ids)):
            raise ValueError("batch creator IDs must be unique")
        if sum(len(item.events) for item in self.creators) > 10_000:
            raise ValueError("batch contains more than 10000 events")
        return self


class CredibilityResponse(BaseModel):
    """The model owns this stable public shape; private extras remain forbidden on input."""

    model_config = ConfigDict(extra="allow")
    creator_id: str
    status: str
    credibility_score: float | None
    evidence_tier: str
    model_version: str


class CredibilityBatchResponse(StrictModel):
    results: list[CredibilityResponse]


class HealthResponse(StrictModel):
    status: Literal["ok"]
    service: str
    api_version: str


class SemanticReadiness(StrictModel):
    status: Literal["disabled", "not_loaded", "ready", "error", "assets_missing"]
    assets_available: bool
    model_id: str
    revision: str
    detail: str | None = None


class ReadinessResponse(StrictModel):
    status: Literal["ready"]
    basic_models_ready: bool
    semantic: SemanticReadiness
