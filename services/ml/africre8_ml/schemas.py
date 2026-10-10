"""Phase 1 executable dataset contract, using standard-library validation.

Validation errors raise ValueError (not assertions, which Python can disable).
JSON amounts are decimal strings. All IDs are scoped by the dataset namespace.
"""
from collections import Counter
from datetime import date
from decimal import Decimal

from .catalog import MARKETS, PLATFORMS
from .currency import RATE_VERSION, RATES, normalize

NAMESPACE = "africre8-demo-v1"
TRANSITIONS = {"invitation": {"match"}, "match": {"negotiation"}, "negotiation": {"contract"},
               "contract": {"submission"}, "submission": {"verified_outcome", "dispute"}, "verified_outcome": {"rating"}, "rating": set(), "dispute": set()}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_money(value):
    require(value["currency"] in RATES, "Unsupported currency")
    require(value["purpose"] == "synthetic_comparison_only" and value["rate_version"] == RATE_VERSION, "Unsafe money provenance")
    require(value["normalized_usd"] == normalize(value["amount"], value["currency"]), "Incorrect currency normalization")
    require(Decimal(value["normalized_usd"]) > 0, "Nonpositive normalized amount")


def validate(data):
    manifest = data["manifest"]
    require(manifest["synthetic"] is True and manifest["namespace"] == NAMESPACE, "Not a synthetic dataset")
    config = manifest["config"]
    cutoff = date.fromisoformat(config["reference_date"])
    indexed = {}
    for table in ("creators", "opportunities", "interactions", "images"):
        rows = data[table]
        expected = config["creators" if table == "images" else table]
        require(len(rows) == expected, f"Incorrect {table} count")
        indexed[table] = {r["id"]: r for r in rows}
        require(len(indexed[table]) == len(rows), f"Duplicate {table} IDs")
        for row in rows:
            require(row["synthetic"] is True and row["namespace"] == NAMESPACE, f"Unsafe {table} record")
    creators, opportunities, events, images = (indexed[k] for k in ("creators", "opportunities", "interactions", "images"))
    for c in creators.values():
        require(bool(c["display_name"] and c["bio"] and c["content_description"] and c["niches"] and c["languages"]), "Missing creator features")
        require(c["residence"]["country_code"] in MARKETS, "Unknown residence")
        require(c["availability"] in {"available", "busy", "booked"}, "Unknown availability")
        require(c["credibility_score"] is None, "Phase 1 must not score credibility")
        require(not ({"skin_tone", "ethnicity", "appearance"} & c.keys()), "Appearance leaked into creator features")
        require(len({s["platform"] for s in c["socials"]}) == len(c["socials"]) > 0, "Duplicate/missing social platform")
        for s in c["socials"]:
            require(s["platform"] in PLATFORMS and isinstance(s["followers"], int) and 0 <= s["followers"] <= 100_000_000, "Invalid social statistics")
            require(0 <= s["engagement_rate_percent"] <= 30 and 0 <= s["average_views"] <= max(1, s["followers"]) * 10, "Implausible engagement/views")
        require(sum(a["share_percent"] for a in c["audience_markets"]) == 100, "Audience shares must total 100")
        require(all(a["country"] in MARKETS and 0 < a["share_percent"] <= 100 for a in c["audience_markets"]), "Invalid audience market")
        require(len({a["country"] for a in c["audience_markets"]}) == len(c["audience_markets"]), "Duplicate audience market")
        rates = c["commercial_rate"]
        validate_money(rates["minimum"])
        validate_money(rates["maximum"])
        require(Decimal(rates["minimum"]["normalized_usd"]) <= Decimal(rates["maximum"]["normalized_usd"]), "Reversed rate range")
        image = images.get(c["image_asset_id"])
        require(image is not None and image["creator_id"] == c["id"], "Broken creator image reference")
    require(len({o["brand"]["id"] for o in opportunities.values()}) == len(opportunities), "Duplicate brand IDs")
    for o in opportunities.values():
        validate_money(o["budget"])
        require(o["brand"]["synthetic"] is True, "Non-synthetic brand")
        require(date.fromisoformat(o["created_at"]) < date.fromisoformat(o["closes_at"]) <= cutoff, "Invalid opportunity dates")
        require(all(m in MARKETS for m in o["target_markets"]), "Invalid campaign markets")
        require(bool(o["required_languages"]) and all(p in PLATFORMS for p in o["required_platforms"]), "Invalid requirements")
    for image in images.values():
        require(image["creator_id"] in creators and image["status"] == "not_generated" and image["public_url"] is None, "Invalid image lifecycle")
        require(image["asset_uri"].startswith("synthetic-asset://") and image["exclude_from_ml_features"] is True, "Unsafe image metadata")
    seen, contracts, journeys = {}, {}, {}
    summaries = {cid: {"contracted_campaigns": 0, "verified_outcomes": 0, "completed_campaigns": 0} for cid in creators}
    for event in data["interactions"]:
        cid, oid, kind = event["creator_id"], event["opportunity_id"], event["event_type"]
        require(cid in creators and oid in opportunities and kind in TRANSITIONS, "Invalid event reference/type")
        occurred = date.fromisoformat(event["occurred_at"])
        require(date.fromisoformat(opportunities[oid]["created_at"]) <= occurred <= cutoff, "Event outside history window")
        prior = event["previous_event_id"]
        if prior is None:
            require(kind == "invitation" and event["journey_id"] not in journeys, "Invalid journey start")
        else:
            require(prior in seen, "Missing prior event")
            p = seen[prior]
            require(journeys.get(event["journey_id"]) == prior, "History branches or repeats")
            require(all(p[key] == event[key] for key in ("journey_id", "creator_id", "opportunity_id")), "History identity changed")
            require(kind in TRANSITIONS[p["event_type"]] and p["occurred_at"] < event["occurred_at"], "Invalid chronology/transition")
        details = event["details"]
        contract = event["contract_id"]
        if kind in {"invitation", "match", "negotiation"}:
            require(contract is None, "Pre-contract event has contract")
        elif kind == "contract":
            require(contract and contract not in contracts, "Duplicate/missing contract")
            require(occurred < date.fromisoformat(details["deadline"]), "Invalid contract deadline")
            validate_money(details["agreed_amount"])
            profile, opportunity = creators[cid], opportunities[oid]
            agreed = Decimal(details["agreed_amount"]["normalized_usd"])
            require(Decimal(profile["commercial_rate"]["minimum"]["normalized_usd"]) <= agreed <= Decimal(profile["commercial_rate"]["maximum"]["normalized_usd"]), "Contract outside creator rate range")
            require(agreed <= Decimal(opportunity["budget"]["normalized_usd"]), "Contract exceeds opportunity budget")
            require(details["platform"] in {s["platform"] for s in profile["socials"]} and details["platform"] in opportunity["required_platforms"], "Contract platform mismatch")
            require(details["language"] in profile["languages"] and details["language"] in opportunity["required_languages"], "Contract language mismatch")
            contracts[contract] = event
            summaries[cid]["contracted_campaigns"] += 1
        else:
            require(contract in contracts, "Missing contract")
            require(contracts[contract]["journey_id"] == event["journey_id"], "Wrong contract")
        if kind == "submission":
            require(details["late"] == (occurred > date.fromisoformat(contracts[contract]["details"]["deadline"])), "Wrong late flag")
        if kind == "verified_outcome":
            require(details["outcome"] in {"pass", "partial", "fail", "insufficient_evidence"}, "Invalid verification")
            require(details["fulfillment_accepted"] == (details["outcome"] == "pass"), "Inconsistent fulfillment")
            require(details["evidence_sufficient"] == (details["outcome"] != "insufficient_evidence"), "Inconsistent evidence")
            require(seen[prior]["details"]["evidence_asset_id"] is not None or not details["evidence_sufficient"], "Missing submission evidence treated as verified")
            summaries[cid]["verified_outcomes"] += 1
            summaries[cid]["completed_campaigns"] += int(details["fulfillment_accepted"])
        if kind == "rating": require(isinstance(details["stars"], int) and 1 <= details["stars"] <= 5, "Invalid rating")
        if kind == "dispute":
            require(details["status"] in {"open", "resolved"}, "Invalid dispute state")
            if details["status"] == "open": require(details["resolved_at"] is None and details["attribution"] is None, "Open dispute attributed")
            else:
                require(occurred <= date.fromisoformat(details["resolved_at"]) <= cutoff, "Invalid resolution date")
                require(details["attribution"] in {"creator", "brand", "shared", "neither"}, "Invalid dispute attribution")
        seen[event["id"]] = event
        journeys[event["journey_id"]] = event["id"]
    for cid, summary in summaries.items():
        require(creators[cid]["history_summary"] == summary, "History aggregate mismatch")
    return {"valid": True, "counts": {k: len(v) for k, v in indexed.items()}, "journeys": len(journeys),
            "contracted_campaigns": len(contracts), "accepted_fulfillments": sum(s["completed_campaigns"] for s in summaries.values()),
            "event_types": dict(sorted(Counter(e["event_type"] for e in events.values()).items())),
            "creators_without_history": sum(all(e["creator_id"] != c for e in events.values()) for c in creators)}
