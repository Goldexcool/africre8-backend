"""Validate public campaign histories and aggregate each contract exactly once."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

EVENT_ORDER = {
    "invitation": 0,
    "match": 1,
    "negotiation": 2,
    "withdrawal": 2,
    "contract": 3,
    "submission": 4,
    "cancellation": 4,
    "verification": 5,
    "revision_requested": 6,
    "revision_submitted": 7,
    "dispute": 8,
    "dispute_resolved": 9,
    "completion": 10,
    "rating": 11,
}

SINGLETON_CONTRACT_EVENTS = frozenset({
    "invitation", "match", "negotiation", "withdrawal", "contract", "submission", "verification", "revision_requested",
    "revision_submitted", "dispute", "dispute_resolved", "completion",
    "rating", "cancellation",
})

# Verification may repeat after a submitted revision; transitions express the
# actual lifecycle more accurately than a single monotonic numeric ordering.
SINGLETON_CONTRACT_EVENTS = SINGLETON_CONTRACT_EVENTS - {"verification"}
ALLOWED_NEXT = {
    "invitation": {"match"},
    "match": {"negotiation", "withdrawal"},
    "negotiation": {"contract", "cancellation"},
    "contract": {"submission", "cancellation"},
    "submission": {"verification"},
    "verification": {"revision_requested", "dispute", "completion", "rating"},
    "revision_requested": {"revision_submitted"},
    "revision_submitted": {"verification", "dispute", "completion", "rating"},
    "dispute": {"dispute_resolved"},
    "dispute_resolved": {"completion", "rating"},
    "completion": {"rating"},
    "rating": set(),
    "withdrawal": set(),
    "cancellation": set(),
}


@dataclass
class ContractEvidence:
    contract_id: str
    journey_id: str
    submitted: bool = False
    late: bool | None = None
    verification_outcome: str | None = None
    evidence_sufficient: bool | None = None
    completed: bool = False
    accepted_fulfillment: bool = False
    rating: int | None = None
    revisions_requested: int = 0
    revisions_submitted: int = 0
    creator_cancelled: bool = False
    dispute_opened: bool = False
    dispute_attribution: str | None = None


@dataclass(frozen=True)
class EvidenceBundle:
    creator_id: str
    contracts: tuple[ContractEvidence, ...]
    brand_cancellations_excluded: int
    precontract_withdrawals_excluded: int


def _validate_and_group(creator_id: str, events: list[dict]) -> dict[str, list[dict]]:
    selected = [event for event in events if event.get("creator_id") == creator_id]
    ids: dict[str, dict] = {}
    for event in selected:
        event_id = event.get("id")
        if not event_id or event_id in ids:
            raise ValueError("Duplicate or missing event ID")
        if event.get("event_type") not in EVENT_ORDER:
            raise ValueError(f"Unsupported event type: {event.get('event_type')!r}")
        ids[event_id] = event

    journeys: dict[str, list[dict]] = {}
    for event in selected:
        journey_id = event.get("journey_id")
        if not journey_id:
            raise ValueError("Event lacks journey ID")
        journeys.setdefault(journey_id, []).append(event)

    for journey_id, journey in journeys.items():
        journey.sort(key=lambda event: (date.fromisoformat(event["occurred_at"]), event["id"]))
        seen_types: set[str] = set()
        previous_id = None
        previous_kind = None
        creator_ids = {event["creator_id"] for event in journey}
        opportunity_ids = {event["opportunity_id"] for event in journey}
        if creator_ids != {creator_id} or len(opportunity_ids) != 1:
            raise ValueError(f"Journey identity changed: {journey_id}")
        for index, event in enumerate(journey):
            kind = event["event_type"]
            if index == 0:
                if kind != "invitation" or event.get("previous_event_id") is not None:
                    raise ValueError(f"Invalid journey root: {journey_id}")
            elif event.get("previous_event_id") != previous_id:
                raise ValueError(f"Broken event chain: {journey_id}")
            if kind in SINGLETON_CONTRACT_EVENTS and kind in seen_types:
                raise ValueError(f"Duplicate {kind} evidence: {journey_id}")
            if previous_kind is not None and kind not in ALLOWED_NEXT[previous_kind]:
                raise ValueError(f"Inconsistent event sequence: {journey_id}")
            seen_types.add(kind)
            previous_id = event["id"]
            previous_kind = kind
    return journeys


def build_evidence(creator_id: str, events: list[dict]) -> EvidenceBundle:
    journeys = _validate_and_group(creator_id, events)
    contracts: list[ContractEvidence] = []
    brand_cancellations = 0
    withdrawals = 0
    contract_ids: set[str] = set()

    for journey_id, journey in sorted(journeys.items()):
        contract_event = next((event for event in journey if event["event_type"] == "contract"), None)
        if contract_event is None:
            if any(event["event_type"] not in {"invitation", "match", "negotiation", "withdrawal", "cancellation"} for event in journey):
                raise ValueError(f"Post-contract evidence without a contract: {journey_id}")
            brand_cancellations += sum(
                event["event_type"] == "cancellation"
                and event.get("details", {}).get("attribution") == "brand"
                for event in journey
            )
            withdrawals += sum(event["event_type"] == "withdrawal" for event in journey)
            continue
        contract_id = contract_event.get("contract_id")
        if not contract_id or contract_id in contract_ids:
            raise ValueError("Duplicate or missing contract ID")
        contract_ids.add(contract_id)
        evidence = ContractEvidence(contract_id=contract_id, journey_id=journey_id)
        for event in journey:
            kind = event["event_type"]
            if EVENT_ORDER[kind] >= EVENT_ORDER["contract"] and kind != "cancellation":
                if event.get("contract_id") != contract_id:
                    raise ValueError(f"Contract reference changed: {journey_id}")
            details = event.get("details", {})
            if kind == "submission":
                evidence.submitted = bool(details.get("deliverables_received"))
                evidence.late = bool(details.get("late"))
            elif kind == "verification":
                outcome = details.get("outcome")
                if outcome not in {"pass", "partial", "fail", "insufficient_evidence"}:
                    raise ValueError(f"Invalid verification outcome: {outcome!r}")
                evidence.verification_outcome = outcome
                evidence.evidence_sufficient = bool(details.get("evidence_sufficient"))
            elif kind == "revision_requested":
                evidence.revisions_requested += 1
            elif kind == "revision_submitted":
                evidence.revisions_submitted += 1
            elif kind == "completion":
                evidence.completed = True
                evidence.accepted_fulfillment = bool(details.get("accepted_fulfillment"))
            elif kind == "rating":
                stars = details.get("stars")
                if not isinstance(stars, int) or not 1 <= stars <= 5:
                    raise ValueError(f"Invalid rating: {stars!r}")
                evidence.rating = stars
            elif kind == "cancellation":
                attribution = details.get("attribution")
                if event.get("contract_id") != contract_id or attribution not in {"creator", "brand"}:
                    raise ValueError(f"Invalid post-contract cancellation: {journey_id}")
                evidence.creator_cancelled = attribution == "creator"
                if attribution == "brand":
                    brand_cancellations += 1
            elif kind == "dispute":
                evidence.dispute_opened = True
            elif kind == "dispute_resolved":
                attribution = details.get("attribution")
                if attribution not in {"creator", "brand", "shared", "neither"}:
                    raise ValueError(f"Invalid dispute attribution: {attribution!r}")
                evidence.dispute_attribution = attribution
        if evidence.dispute_attribution and not evidence.dispute_opened:
            raise ValueError(f"Resolved dispute without open dispute: {journey_id}")
        contracts.append(evidence)

    return EvidenceBundle(
        creator_id=creator_id,
        contracts=tuple(contracts),
        brand_cancellations_excluded=brand_cancellations,
        precontract_withdrawals_excluded=withdrawals,
    )
