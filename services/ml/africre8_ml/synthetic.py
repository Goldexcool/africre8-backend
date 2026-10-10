"""Seeded, offline generation. This module never imports application or DB code."""
import hashlib
import json
import random
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

from .catalog import COMMUNITIES, MARKETS, PLATFORMS, PRODUCTS, STYLES, TOPICS
from .currency import RATE_VERSION, RATES, money

FIXTURE = Path(__file__).resolve().parents[3] / "prisma/seed-data/creators.json"


@dataclass(frozen=True)
class Config:
    seed: int = 20261009
    creators: int = 500
    opportunities: int = 150
    interactions: int = 3000
    reference_date: str = "2026-10-09"


def encoded(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")


def rng_for(seed, key):
    return random.Random(int.from_bytes(hashlib.sha256(f"{seed}:{key}".encode()).digest(), "big"))


def base(identifier):
    return {"id": identifier, "synthetic": True, "namespace": "africre8-demo-v1"}


def audit_fixture(rows):
    issues = []
    for field in ("id", "name", "avatarUrl"):
        duplicates = {k: n for k, n in Counter(r.get(field) for r in rows).items() if n > 1}
        if duplicates:
            issues.append({"kind": f"duplicate_{field}", "values": duplicates})
    issues.extend([
        {"kind": "unverified_aggregates", "resolution": "Legacy credibility/completion values retained only in source metadata; new summaries derive from events."},
        {"kind": "external_photos", "resolution": "Legacy photo URLs retained as provenance only; portrait assets remain ungenerated."},
        {"kind": "language_unknown", "resolution": "Enriched languages are synthetic assumptions, not inferred personal facts."},
    ])
    return issues


def generate(config=Config(), fixture_path=FIXTURE):
    source_bytes = fixture_path.read_bytes()
    source = json.loads(source_bytes)
    if config.creators < len(source) or config.opportunities < 1 or config.interactions < 0:
        raise ValueError("Preserve every fixture: creators >= fixture count, opportunities >= 1, interactions >= 0")
    reference = date.fromisoformat(config.reference_date)
    origin = reference - timedelta(days=720)
    creators, portraits, opportunities, events = [], [], [], []
    used_ids, used_names = set(), set()
    issues = audit_fixture(source)
    for i in range(config.creators):
        r = rng_for(config.seed, f"creator:{i}")
        old = source[i] if i < len(source) else None
        community = COMMUNITIES[(i - len(source)) % len(COMMUNITIES)]
        city, country, country_code, local_currency, languages, first, last = community
        identifier = old["id"] if old else f"syn_creator_{i + 1:04d}"
        if identifier in used_ids:
            identifier = f"{identifier}__duplicate_{i + 1}"
        used_ids.add(identifier)
        name = old["name"] if old else f"{first[((i - len(source)) // len(COMMUNITIES)) % len(first)]} {last[((i - len(source)) // (len(COMMUNITIES) * len(first))) % len(last)]}"
        if name in used_names:
            # Identity is the ID, not the display name. Shared names are valid.
            issues.append({"kind": "shared_display_name", "creator_id": identifier, "resolution": "Distinct stable ID retained; no person merged."})
        used_names.add(name)
        if old:
            city, country = old["location"].split(", ", 1)
            match = next((c for c in COMMUNITIES if c[1] == country), None)
            if match:
                country_code, local_currency, languages = match[2:5]
        category = old["category"] if old else r.choice(list(TOPICS))
        niches = r.sample(TOPICS[category], 2)
        style = r.choice(STYLES)
        language = r.choice(languages)
        creator_languages = list(dict.fromkeys([language, "en"]))
        markets = r.sample(MARKETS, 3)
        a, b = r.randint(35, 65), r.randint(15, 25)
        audience = [{"country": m, "share_percent": w} for m, w in zip(markets, [a, b, 100-a-b])]
        socials = []
        for p in (old["platforms"] if old else [{"platform": p} for p in r.sample(PLATFORMS, r.randint(1, 3))]):
            followers = p.get("followers", int(10 ** r.uniform(3, 6)))
            engagement = old["engagementRate"] if old else round(r.uniform(1, 10), 2)
            socials.append({"platform": p["platform"], "handle": p.get("handle", f"@fictional_{identifier}_{p['platform']}"),
                            "followers": followers, "engagement_rate_percent": engagement,
                            "average_views": int(followers * r.uniform(.15, 1.8)), "statistics_source": "synthetic"})
        currency = "USD" if old else r.choice([local_currency, "USD", "EUR", "GBP"])
        low, high = old["budgetRangeUsd"] if old else (r.randint(75, 600), r.randint(650, 3000))
        image_id = f"portrait:{identifier}"
        creators.append({**base(identifier), "display_name": name,
            "bio": old["bio"] if old else f"{name} creates {style} content about {niches[0]} and {niches[1]}, working with brands on practical, audience-focused stories.",
            "residence": {"city": city, "country": country, "country_code": country_code},
            "category": category, "niches": niches, "content_style": style,
            "content_description": f"{style.capitalize()} series on {niches[0]} and {niches[1]}; product integrations tailored to the brief.",
            "languages": creator_languages, "audience_markets": audience, "socials": socials,
            "availability": old["availability"] if old else r.choices(["available", "busy", "booked"], [7, 2, 1])[0],
            "commercial_rate": {"scope": "one sponsored content deliverable; usage rights negotiated separately", "minimum": money(low, currency), "maximum": money(high, currency)},
            "image_asset_id": image_id, "credibility_score": None,
            "source": {"kind": "enriched_fixture" if old else "generated", "fixture_id": old["id"] if old else None,
                       "legacy_unverified_aggregates": {k: old[k] for k in ("credibilityScore", "completedCampaigns")} if old else None},
            "history_summary": {"contracted_campaigns": 0, "verified_outcomes": 0, "completed_campaigns": 0}})
        portraits.append({**base(image_id), "creator_id": identifier,
            "asset_uri": f"synthetic-asset://africre8/portraits/{identifier}/v1",
            "status": "not_generated", "public_url": None, "label": "Synthetic fictional creator; portrait pending",
            "legacy_photo_reference": old.get("avatarUrl") if old else None,
            "portrait_brief": {"fictional_adult": True, "appearance": "Black African", "style": "realistic editorial photography",
                "skin_tone": None, "hairstyle": None, "wardrobe": None,
                "instructions": "Future curated diversity across skin tones, hair textures, hairstyles and visual styles. Never infer appearance from name or residence. Human review required."},
            "exclude_from_ml_features": True})

    brand_types = ["african_business", "international_company", "multinational", "global_agency"]
    global_hq = [("London", "GB"), ("New York", "US"), ("Paris", "FR"), ("Tokyo", "JP"), ("São Paulo", "BR"), ("Dubai", "AE")]
    for i in range(config.opportunities):
        r = rng_for(config.seed, f"opportunity:{i}")
        kind = brand_types[i % 4]
        c = r.choice(COMMUNITIES)
        hq = (c[0], c[2]) if kind == "african_business" else r.choice(global_hq)
        product, category, currency = r.choice(PRODUCTS), r.choice(list(TOPICS)), list(RATES)[i % len(RATES)]
        created = origin + timedelta(days=r.randint(0, 450))
        opportunities.append({**base(f"syn_opportunity_{i+1:04d}"),
            "brand": {"id": f"syn_brand_{i+1:04d}", "name": f"Fictional {r.choice(['Orbit', 'Cedar', 'Horizon', 'Mosaic', 'Nova'])} {i+1:03d}", "type": kind,
                      "headquarters": {"city": hq[0], "country_code": hq[1]}, "synthetic": True},
            "title": f"{product.capitalize()}: {r.choice(['launch stories', 'creator demonstrations', 'audience discovery'])}",
            "product": product, "category": category, "objective": r.choice(["awareness", "qualified_traffic", "product_education", "conversions", "ugc_production"]),
            "brief": f"Introduce our {product} through useful {category.lower()} content. Explain practical benefits honestly and disclose the sponsorship.",
            "target_markets": r.sample(MARKETS, r.randint(2, 5)),
            "required_platforms": [r.choice(PLATFORMS)], "required_languages": [r.choice(["en", "fr", "ar", "pt", "sw"])],
            "preferred_styles": r.sample(STYLES, 2), "deliverables": [{"quantity": 1, "format": "sponsored content"}],
            "budget": money(r.randint(300, 5000), currency), "budget_scope": "per_creator_one_deliverable",
            "created_at": created.isoformat(), "closes_at": (created + timedelta(days=200)).isoformat(),
            "mandatory_constraints": ["platform", "language", "budget"], "synthetic_historical_brief": True})

    # One row is one event, not one campaign. Partial histories are intentional.
    profiles = {c["id"]: c for c in creators}
    # Select cold-start cohort independently of geography, appearance and row order.
    eligible_history = sorted(creators, key=lambda c: hashlib.sha256(f"{config.seed}:{c['id']}:history".encode()).digest())[:max(1, int(len(creators) * .85))]
    compatible = {}
    for o in opportunities:
        compatible[o["id"]] = [c for c in eligible_history
            if set(o["required_platforms"]) <= {s["platform"] for s in c["socials"]}
            and set(o["required_languages"]) <= set(c["languages"])
            and Decimal(c["commercial_rate"]["minimum"]["normalized_usd"]) <= Decimal(o["budget"]["normalized_usd"])]
    journey = 0
    while len(events) < config.interactions:
        r = rng_for(config.seed, f"journey:{journey}")
        creator, opportunity = r.choice(eligible_history), r.choice(opportunities)
        journey_id = f"syn_journey_{journey+1:05d}"
        start = date.fromisoformat(opportunity["created_at"]) + timedelta(days=r.randint(1, 120))
        route = r.choices(["invitation", "match", "negotiation", "contract", "submission", "verified", "rated", "dispute"], [20, 10, 10, 10, 10, 15, 15, 10])[0]
        pool = compatible[opportunity["id"]]
        if route != "invitation":
            if pool:
                # Niche compatibility is a preference; mandatory platform/language/budget hold.
                creator = r.choices(pool, [4 if c["category"] == opportunity["category"] else 1 for c in pool])[0]
            else:
                route = "invitation"
        stages = ["invitation", "match", "negotiation", "contract", "submission", "verified_outcome", "rating"]
        stop = {"invitation": 1, "match": 2, "negotiation": 3, "contract": 4, "submission": 5, "verified": 6, "rated": 7, "dispute": 6}[route]
        stages = stages[:stop]
        if route == "dispute":
            stages[-1] = "dispute"
        contracted_id = f"syn_contract_{journey+1:05d}"
        submission_day = r.randint(20, 38)
        offsets = {"invitation": 0, "match": 2, "negotiation": 4, "contract": 6, "submission": submission_day,
                   "verified_outcome": submission_day+3, "rating": submission_day+5, "dispute": submission_day+4}
        previous = None
        evidence_available = r.random() > .15
        outcome = None
        for stage in stages:
            if len(events) == config.interactions:
                break
            event_id = f"syn_event_{len(events)+1:06d}"
            details = {}
            contract_id = contracted_id if stage in stages[3:] else None
            if stage == "invitation": details = {"direction": r.choice(["brand_invitation", "creator_application"]),
                "response": "accepted" if len(stages) > 1 else r.choice(["pending", "declined", "expired"])}
            if stage == "match": details = {"mutually_accepted": True}
            if stage == "negotiation": details = {"topic": r.choice(["usage_rights", "deliverable_scope", "schedule", "rate"])}
            if stage == "contract":
                minimum = int(Decimal(creator["commercial_rate"]["minimum"]["normalized_usd"]))
                ceiling = min(int(Decimal(creator["commercial_rate"]["maximum"]["normalized_usd"])), int(Decimal(opportunity["budget"]["normalized_usd"])))
                details = {"agreed_amount": money(r.randint(minimum, ceiling), opportunity["budget"]["currency"]), "deadline": (start+timedelta(days=30)).isoformat(), "deliverable_count": 1,
                           "platform": opportunity["required_platforms"][0], "language": opportunity["required_languages"][0]}
                profiles[creator["id"]]["history_summary"]["contracted_campaigns"] += 1
            if stage == "submission": details = {"late": submission_day > 30, "evidence_asset_id": f"synthetic-evidence:{journey_id}" if evidence_available else None}
            if stage == "verified_outcome":
                outcome = r.choices(["pass", "partial", "fail", "insufficient_evidence"], [70, 15, 5, 10])[0] if evidence_available else "insufficient_evidence"
                details = {"outcome": outcome, "verification_source": "simulated_review", "evidence_sufficient": outcome != "insufficient_evidence",
                           "fulfillment_accepted": outcome == "pass", "reach": r.randint(500, 100000) if r.random() > .25 else None,
                           "conversions": r.randint(0, 200) if r.random() > .5 else None}
                profiles[creator["id"]]["history_summary"]["verified_outcomes"] += 1
                if outcome == "pass": profiles[creator["id"]]["history_summary"]["completed_campaigns"] += 1
            if stage == "rating":
                weights = {"pass": [1, 2, 7, 40, 50], "partial": [5, 15, 40, 30, 10], "fail": [40, 30, 20, 8, 2], "insufficient_evidence": [10, 15, 35, 25, 15]}
                details = {"stars": r.choices([1, 2, 3, 4, 5], weights[outcome])[0], "review_text": None if r.random() < .5 else "Synthetic campaign-linked feedback."}
            if stage == "dispute":
                resolved = r.random() > .4
                details = {"status": "resolved" if resolved else "open", "reason": r.choice(["scope_disagreement", "delivery_quality", "usage_rights"]),
                           "attribution": r.choice(["creator", "brand", "shared", "neither"]) if resolved else None,
                           "resolved_at": (start+timedelta(days=submission_day+14)).isoformat() if resolved else None}
            events.append({**base(event_id), "journey_id": journey_id, "creator_id": creator["id"], "opportunity_id": opportunity["id"],
                           "contract_id": contract_id, "previous_event_id": previous, "event_type": stage,
                           "occurred_at": (start+timedelta(days=offsets[stage])).isoformat(), "details": details})
            previous = event_id
        journey += 1
    return {"creators": creators, "opportunities": opportunities, "interactions": events, "images": portraits,
            "manifest": {"schema_version": "1.0", "generator_version": "1.0", "synthetic": True, "namespace": "africre8-demo-v1",
                         "config": asdict(config), "source_fixture_sha256": hashlib.sha256(source_bytes).hexdigest(),
                         "source_fixture_count": len(source), "fixture_issues": issues, "rate_version": RATE_VERSION,
                         "currency_units_per_usd": {k: str(v) for k, v in RATES.items()},
                         "limitations": ["Synthetic demonstration, not real performance or real-world accuracy evidence.",
                                        "No payment quotes, transactions or production identifiers.",
                                        "Language and audience enrichment is fictional; appearance is excluded from ML inputs.",
                                        "Completed means accepted simulated fulfillment, not payout settlement.",
                                        "Interactions are event rows; histories can stop before completion."]}}


def write_dataset(dataset, output: Path):
    from .schemas import validate
    report = validate(dataset)
    # Refuse even an existing empty directory: never overwrite fixtures or prior runs.
    output.mkdir(parents=True, exist_ok=False)
    checksums = {}
    for name in ("creators", "opportunities", "interactions", "images"):
        payload = encoded(dataset[name])
        with (output / f"{name}.json").open("xb") as stream:
            stream.write(payload)
        checksums[f"{name}.json"] = hashlib.sha256(payload).hexdigest()
    manifest = {**dataset["manifest"], "files_sha256": checksums}
    for name, value in (("manifest", manifest), ("validation", report)):
        with (output / f"{name}.json").open("xb") as stream:
            stream.write(encoded(value))
    return report
