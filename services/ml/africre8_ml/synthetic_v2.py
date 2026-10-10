"""Commercially coherent, deterministic Phase 1B dataset generation."""
from __future__ import annotations

import hashlib
import json
import random
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

from .catalog_v2 import (AFRICAN_HQ, BRAND_WORDS, CAMPAIGN_ARCHETYPES, CITIES,
                         FORMATS, FORMAT_EFFORT, GLOBAL_HQ, NICHE_CATALOG, REGIONS)
from .currency import RATE_VERSION, RATES, money
from .synthetic import Config as V1Config
from .synthetic import FIXTURE, encoded, generate as generate_v1

NAMESPACE = "africre8-demo-v2"
ROOT = Path(__file__).resolve().parents[1]
V1_DATA = ROOT / "data/demo-v1"


@dataclass(frozen=True)
class ConfigV2:
    seed: int = 20261009
    creators: int = 500
    brands: int = 50
    opportunities: int = 150
    interactions: int = 3000
    evaluation_scenarios: int = 45
    reference_date: str = "2026-10-09"


def rng_for(seed: int, key: str) -> random.Random:
    return random.Random(int.from_bytes(hashlib.sha256(f"v2:{seed}:{key}".encode()).digest(), "big"))


def base(identifier: str) -> dict:
    return {"id": identifier, "synthetic": True, "namespace": NAMESPACE}


def _language_for_market(country: str) -> str:
    if country in REGIONS:
        return REGIONS[country][2][0]
    return {"FR":"fr", "BE":"fr", "CA":"en", "GB":"en", "US":"en", "AE":"ar", "SA":"ar", "BR":"pt", "PT":"pt", "ES":"es"}.get(country, "en")


def _currency_for_country(country: str) -> str:
    return {"NG":"NGN", "GH":"GHS", "KE":"KES", "ZA":"ZAR", "SN":"XOF", "CI":"XOF", "RW":"RWF", "UG":"UGX", "ET":"ETB", "EG":"EGP",
            "GB":"GBP", "FR":"EUR", "DE":"EUR", "BE":"EUR", "ES":"EUR", "PT":"EUR"}.get(country, "USD")


def _money_from_usd(value: int, currency: str) -> dict:
    return money(max(1, value), currency)


def _brands(config: ConfigV2) -> list[dict]:
    brands = []
    kinds = ["african_business"] * 16 + ["international_company"] * 12 + ["multinational"] * 12 + ["global_agency"] * 10
    for i in range(config.brands):
        r, kind = rng_for(config.seed, f"brand:{i}"), kinds[i % len(kinds)]
        archetype = CAMPAIGN_ARCHETYPES[i % len(CAMPAIGN_ARCHETYPES)]
        city, country = (AFRICAN_HQ if kind == "african_business" else GLOBAL_HQ)[i % len(AFRICAN_HQ if kind == "african_business" else GLOBAL_HQ)]
        home_markets = [country] if country in REGIONS else []
        operating = list(dict.fromkeys(home_markets + r.sample(list(REGIONS), 4) + r.sample(["GB", "US", "CA", "AE", "FR", "DE", "BR", "IN"], 2)))
        suffix = {"african_business":"Collective", "international_company":"Labs", "multinational":"Group", "global_agency":"Creative"}[kind]
        positioning = {
            "african_business":"an Africa-founded company building for regional and diaspora customers",
            "international_company":"an international growth company adapting products with local market partners",
            "multinational":"a multinational consumer group running market-specific creator programs",
            "global_agency":"an independent global agency managing creator work for disclosed fictional clients",
        }[kind]
        brands.append({**base(f"syn_brand_{i+1:03d}"), "name": f"{BRAND_WORDS[i % len(BRAND_WORDS)]} {suffix} {i//len(BRAND_WORDS)+1}",
                       "type": kind, "industry": archetype["industry"], "headquarters": {"city": city, "country_code": country},
                       "operating_markets": operating, "positioning": positioning, "products": archetype["products"],
                       "disclaimer": "Fictional demo brand; no real commercial partnership is implied."})
    return brands


def _creators(config: ConfigV2) -> tuple[list[dict], list[dict], list[dict]]:
    # V1 is invoked in memory only to preserve its stable 500 IDs/names/image IDs.
    old = generate_v1(V1Config(seed=config.seed, creators=config.creators, opportunities=1, interactions=0, reference_date=config.reference_date))["creators"]
    fixture_ids = {x["id"] for x in json.loads(FIXTURE.read_text(encoding="utf-8"))}
    creators, images, truth = [], [], []
    for i, prior in enumerate(old):
        r = rng_for(config.seed, f"creator-v2:{prior['id']}")
        country = prior["residence"]["country_code"]
        if country not in REGIONS:
            country = list(REGIONS)[i % len(REGIONS)]
        region, related, language_pool = REGIONS[country]
        city = prior["residence"]["city"] if prior["id"] in fixture_ids else r.choice(CITIES[country])
        category = prior["category"]
        niche_pool = NICHE_CATALOG[category]
        niches = r.sample(niche_pool, 3)
        primary = language_pool[0]
        spoken = [primary]
        for lang in language_pool[1:]:
            if r.random() < .58:
                spoken.append(lang)
        if "en" not in spoken and r.random() < .38:
            spoken.append("en")
        content_languages = spoken[:1] + ([spoken[1]] if len(spoken) > 1 and r.random() < .65 else [])
        cohort = rng_for(config.seed, f"audience-cohort:{prior['id']}").choices(["domestic", "regional", "diaspora", "global"], [38, 27, 21, 14])[0]
        if cohort == "domestic":
            markets, shares = [country, related[0], related[2], related[3]], [55, 20, 15, 10]
        elif cohort == "regional":
            markets, shares = [country, related[0], related[1], related[2]], [34, 28, 23, 15]
        elif cohort == "diaspora":
            markets, shares = [related[2], country, related[3], related[0]], [38, 27, 20, 15]
        else:
            globals_ = ["US", "GB", "CA", "AE", "FR", "DE", "BR", "IN"]
            markets = list(dict.fromkeys(r.sample(globals_, 3) + [country]))[:4]
            shares = [35, 27, 23, 15]
        audience = [{"country_code": m, "share_percent": s} for m, s in zip(markets, shares)]
        platform_names = list(dict.fromkeys([s["platform"] for s in prior["socials"]]))
        while len(platform_names) < r.choices([1, 2, 3, 4], [8, 40, 42, 10])[0]:
            p = r.choice(list(FORMATS))
            if p not in platform_names:
                platform_names.append(p)
        socials, capabilities, rate_cards = [], [], []
        reach_anchor = int(10 ** r.uniform(3.1, 5.9))
        quality_factor = r.uniform(.8, 1.2)
        for pidx, platform in enumerate(platform_names):
            followers = max(800, int(reach_anchor * r.uniform(.55, 1.35)))
            engagement = round(max(.7, min(13, (7.8 - 1.05 * (len(str(followers)) - 3)) * quality_factor + r.uniform(-1.4, 1.4))), 2)
            view_factor = {"tiktok": .72, "instagram": .42, "youtube": .28, "x": .18, "facebook": .32}[platform]
            views = max(100, int(followers * view_factor * r.uniform(.65, 1.55)))
            socials.append({"platform": platform, "handle": f"@fictional_{prior['id'].replace('-', '_')}_{platform}", "followers": followers,
                            "engagement_rate_percent": engagement, "average_views": views,
                            "posting_frequency_per_week": r.randint(1, 6), "statistics_source": "synthetic"})
            formats = r.sample(FORMATS[platform], min(len(FORMATS[platform]), r.randint(1, 3)))
            capabilities.extend({"platform": platform, "format": f} for f in formats)
            for fmt in formats:
                reach = max(views, int(followers * .2))
                base_usd = 35 + (reach ** .58) * 1.7 + engagement * 11
                usd = int(base_usd * FORMAT_EFFORT[fmt] * r.uniform(.85, 1.18))
                currency = r.choices([_currency_for_country(country), "USD", "EUR", "GBP"], [58, 25, 10, 7])[0]
                rate_cards.append({"platform": platform, "format": fmt, "base_rate": _money_from_usd(usd, currency),
                                   "includes": ["concept", "production", "one revision", "organic usage for 30 days"],
                                   "usage_rights_multiplier": {"90_days_paid": "1.50", "12_months_paid": "2.00"},
                                   "category_exclusivity_30_days_multiplier": "1.25"})
        tone = r.choice(["warm and conversational", "precise and educational", "playful and quick-witted", "cinematic and reflective", "energetic and direct", "calm and design-led"])
        production = r.sample(["mobile video production", "studio photography", "location sound", "motion graphics", "captioning", "live production", "product styling", "multilingual scripting"], r.randint(2, 4))
        interests = list(dict.fromkeys(niches + r.sample(["entrepreneurship", "sustainability", "culture and arts", "family life", "career development", "sport", "travel", "technology"], 2)))
        creator = {**base(prior["id"]), "display_name": prior["display_name"],
                   "residence": {"city": city, "country": prior["residence"]["country"], "country_code": country, "region": region},
                   "languages": [{"code": lang, "proficiency": "native_or_fluent" if lang == primary else r.choice(["fluent", "conversational"])} for lang in spoken],
                   "content_languages": content_languages, "category": category, "niches": niches, "audience_interests": interests,
                   "content_tone": tone, "creative_styles": r.sample(["tutorial", "documentary", "product demonstration", "interview", "humour", "cinematic", "live conversation"], 3),
                   "bio": f"{prior['display_name']} is a {city}-based creator focused on {niches[0]}, {niches[1]}, and {niches[2]}. Their {tone} work helps audiences make informed choices through {r.choice(['tested demonstrations', 'visual stories', 'step-by-step explainers', 'community conversations'])}.",
                   "portfolio_description": f"Recent fictional portfolio themes include {niches[0]} explainers, {niches[1]} collaborations, and a recurring {niches[2]} series produced for {r.choice(['mobile-first audiences', 'long-form viewers', 'multilingual communities', 'regional and diaspora audiences'])}.",
                   "production_capabilities": production, "deliverable_capabilities": capabilities, "audience": {"profile": cohort, "markets": audience, "interests": interests},
                   "socials": socials, "commercial_rates": rate_cards, "availability": r.choices(["available", "limited", "booked"], [68, 24, 8])[0],
                   "typical_lead_time_days": r.randint(4, 18), "commercial_experience": {"level": None, "years": r.randint(0, 8), "partnership_types": r.sample(["product launch", "always-on ambassador", "event coverage", "tutorial", "UGC licensing"], r.randint(1, 3))},
                   "image_asset_id": prior["image_asset_id"], "credibility_score": None,
                   "source": {"kind": "enriched_fixture" if prior["id"] in fixture_ids else "enriched_synthetic_v1", "preserved_id": True},
                   "history_summary": {"invitations": 0, "contracts": 0, "submissions": 0, "verified_outcomes": 0, "successful_deliveries": 0, "revisions": 0, "cancellations": 0, "withdrawals": 0, "ratings": 0, "disputes": 0}}
        creators.append(creator)
        images.append({**base(prior["image_asset_id"]), "creator_id": prior["id"], "asset_uri": f"synthetic-asset://africre8/portraits/{prior['id']}/v2",
                       "status": "not_generated", "public_url": None, "label": "Synthetic fictional creator; portrait pending", "exclude_from_ml_features": True})
        t = rng_for(config.seed, f"private-traits:{prior['id']}")
        percentile = int.from_bytes(hashlib.sha256(f"{config.seed}:{prior['id']}:experience".encode()).digest()[:2], "big") / 65535
        cohort_name = "new" if percentile < .25 else "developing" if percentile < .80 else "established"
        truth.append({**base(f"truth:{prior['id']}"), "creator_id": prior["id"], "experience_cohort": cohort_name,
                      "reliability": round(t.uniform(.55, .97), 4), "responsiveness": round(t.uniform(.52, .98), 4),
                      "delivery_consistency": round(t.uniform(.50, .97), 4), "work_quality": round(t.uniform(.52, .98), 4),
                      "privacy": "generator_only; prohibited as recommendation or credibility input"})
    return creators, images, truth


def _opportunities(config: ConfigV2, brands: list[dict], *, evaluation: bool = False) -> list[dict]:
    result, reference = [], date.fromisoformat(config.reference_date)
    objective_text = {"product_education":"explain how the product works", "qualified_traffic":"drive qualified product-page visits",
                      "launch_awareness":"build awareness for the launch", "app_signups":"generate verified app sign-ups",
                      "ugc_production":"produce reusable creator-led assets", "trial":"encourage product trials", "conversions":"drive attributable purchases",
                      "destination_awareness":"build destination awareness", "bookings":"generate completed bookings", "course_signups":"generate course enrolments",
                      "community_participation":"encourage community participation", "installs":"generate qualified installs"}
    calls_to_action = {"product_education":"visit the product guide", "qualified_traffic":"visit the product page", "launch_awareness":"learn more about the launch",
                       "app_signups":"start a verified sign-up", "ugc_production":"save and share the creator guide", "trial":"start a free trial",
                       "conversions":"shop the featured product", "destination_awareness":"save the destination guide", "bookings":"explore available dates",
                       "course_signups":"review the course curriculum", "community_participation":"register for the community event", "installs":"download the app from the official store"}
    count = config.evaluation_scenarios if evaluation else config.opportunities
    for i in range(count):
        r = rng_for(config.seed, f"{'eval' if evaluation else 'opportunity'}:{i}")
        brand = brands[(i * 7 + (3 if evaluation else 0)) % len(brands)]
        archetype = next(a for a in CAMPAIGN_ARCHETYPES if a["industry"] == brand["industry"])
        product = brand["products"][i % len(brand["products"])]
        category = archetype["category"]
        cross_category = bool(archetype.get("secondary_category") and i % 7 == 0)
        target_category = archetype.get("secondary_category") if cross_category else category
        objective = archetype["objectives"][i % len(archetype["objectives"])]
        platforms = {"long_video":"youtube", "integration":"youtube", "thread":"x", "reel":"instagram", "carousel":"instagram", "photo_post":"instagram", "live_audio":"x", "live_demo":"tiktok", "livestream":"youtube", "short_video":"tiktok"}
        fmt = archetype["formats"][i % len(archetype["formats"])]
        platform = platforms[fmt]
        markets = r.sample(brand["operating_markets"], min(3, len(brand["operating_markets"])))
        required_language = _language_for_market(markets[0])
        preferred_languages = [lang for lang in dict.fromkeys(_language_for_market(m) for m in markets[1:]) if lang != required_language]
        currency = _currency_for_country(brand["headquarters"]["country_code"])
        if currency not in RATES:
            currency = r.choice(["USD", "EUR", "GBP"])
        budget_usd = r.randint(700, 3500) if fmt not in {"long_video", "livestream"} else r.randint(1800, 7500)
        created = reference + timedelta(days=30+i) if evaluation else reference - timedelta(days=600-r.randint(0, 360))
        concept = r.choice(["a real-use diary", "a myth-versus-fact demonstration", "a creator-led challenge", "a day-in-the-life integration", "a practical before-and-after walkthrough", "a community question-and-answer story"])
        tone = r.choice(archetype["tones"])
        metric = r.choice(archetype["metrics"])
        call_to_action = calls_to_action[objective]
        rationale = f"The {target_category} perspective is intentional: connect {product} to {r.choice(archetype['niches'])} through {concept}." if cross_category else None
        quantity = 2 if budget_usd > 2500 and fmt not in {"long_video", "livestream"} else 1
        identifier = f"eval_campaign_{i+1:03d}" if evaluation else f"syn_opportunity_{i+1:04d}"
        brief = (f"{brand['name']} is introducing its fictional {product} to {', '.join(markets)} audiences. The campaign aims to {objective_text[objective]} among people interested in {', '.join(archetype['niches'][:2])}. "
                 f"Create {quantity} {fmt.replace('_', ' ')} deliverable{'s' if quantity > 1 else ''} for {platform} using {concept}. The work should feel {tone}, show a credible use case, and communicate transparent sponsorship. "
                 f"The key message is that the product supports a specific everyday need without exaggerated claims. Invite viewers to {call_to_action}. "
                 f"Content must be in {required_language}; {', '.join(preferred_languages) if preferred_languages else 'additional local-language adaptation'} is preferred. Success will be reviewed using {metric}. "
                 f"The fee includes concepting, production, one revision, and 30 days of organic usage. Paid usage or category exclusivity requires the stated multiplier."
                 + (f" {rationale}" if rationale else ""))
        result.append({**base(identifier), "held_out": evaluation, "brand_id": brand["id"], "brand_snapshot": {k: brand[k] for k in ("name", "type", "industry", "headquarters", "positioning", "disclaimer")},
                       "title": f"{product.title()} — {objective.replace('_',' ').title()} in {markets[0]}", "product": product, "industry": brand["industry"],
                       "category": target_category, "compatible_niches": archetype["niches"], "objective": objective,
                       "target_audience": {"description": f"Digitally active consumers interested in {archetype['niches'][0]} and {archetype['niches'][1]}", "interests": archetype["niches"][:3], "markets": markets},
                       "required_platforms": [platform], "preferred_platforms": r.sample([p for p in FORMATS if p != platform], 1),
                       "required_languages": [required_language], "preferred_languages": preferred_languages,
                       "deliverables": [{"platform": platform, "format": fmt, "quantity": quantity}], "creative_concept": concept, "tone": tone,
                       "key_messages": ["show a practical use case", "disclose sponsorship", "avoid unsupported claims"], "call_to_action": call_to_action,
                       "timeline": {"briefing_date": created.isoformat(), "first_draft_due": (created+timedelta(days=14)).isoformat(), "publication_window_end": (created+timedelta(days=35)).isoformat()},
                       "budget": _money_from_usd(budget_usd, currency), "budget_scope": "total_creator_fee_for_listed_deliverables",
                       "usage_rights": {"organic_days": 30, "paid_usage": False, "category_exclusivity_days": 0},
                       "success_metrics": [metric, "content quality review"], "cross_category_rationale": rationale, "brief": brief})
    return result


def _rate_for(creator: dict, deliverable: dict) -> dict | None:
    return next((x for x in creator["commercial_rates"] if x["platform"] == deliverable["platform"] and x["format"] == deliverable["format"]), None)


def _compatibility(creator: dict, opp: dict) -> tuple[bool, list[str], list[str]]:
    d = opp["deliverables"][0]
    rate = _rate_for(creator, d)
    required = []
    if d["platform"] not in {x["platform"] for x in creator["socials"]}: required.append("missing_required_platform")
    if d["format"] not in {x["format"] for x in creator["deliverable_capabilities"] if x["platform"] == d["platform"]}: required.append("missing_required_format")
    if not set(opp["required_languages"]) <= set(creator["content_languages"]): required.append("missing_required_content_language")
    if not rate or Decimal(rate["base_rate"]["normalized_usd"]) * d["quantity"] > Decimal(opp["budget"]["normalized_usd"]): required.append("over_budget")
    preferences = []
    if creator["category"] == opp["category"]: preferences.append("category_match")
    if set(creator["niches"]) & set(opp["compatible_niches"]): preferences.append("niche_match")
    if set(x["country_code"] for x in creator["audience"]["markets"]) & set(opp["target_audience"]["markets"]): preferences.append("audience_market_overlap")
    if set(creator["audience_interests"]) & set(opp["target_audience"]["interests"]): preferences.append("audience_interest_overlap")
    if set(opp["preferred_languages"]) & set(creator["content_languages"]): preferences.append("preferred_language")
    return not required, required, preferences


def _history(config: ConfigV2, creators: list[dict], opportunities: list[dict], truth: list[dict]) -> list[dict]:
    by_truth = {x["creator_id"]: x for x in truth}
    eligible = [c for c in creators if by_truth[c["id"]]["experience_cohort"] != "new"]
    pool = [c for c in eligible for _ in range(20 if by_truth[c["id"]]["experience_cohort"] == "established" else 2)]
    rng_for(config.seed, "history-pool").shuffle(pool)
    events, journey_index, cursor = [], 0, 0
    summaries = {c["id"]: c["history_summary"] for c in creators}

    def add(jid, creator, opp, kind, when, details, contract_id, previous):
        if len(events) >= config.interactions: return None
        eid = f"syn_event_{len(events)+1:06d}"
        events.append({**base(eid), "journey_id": jid, "creator_id": creator["id"], "opportunity_id": opp["id"], "contract_id": contract_id,
                       "previous_event_id": previous, "event_type": kind, "occurred_at": when.isoformat(), "details": details})
        return eid

    while len(events) < config.interactions:
        creator = pool[cursor % len(pool)]; cursor += 1; journey_index += 1
        r = rng_for(config.seed, f"history-v2:{journey_index}")
        ranked = []
        for opp in opportunities:
            mandatory, failures, prefs = _compatibility(creator, opp)
            if mandatory:
                score = len(prefs) + r.random() * .5
                ranked.append((score, opp, prefs))
        if not ranked:
            continue
        ranked.sort(key=lambda x: x[0], reverse=True)
        # Most histories are relevant; a controlled tail uses mandatory-compatible creative exceptions.
        imperfect = r.random() < .12
        choices = ranked[-max(1, len(ranked)//3):] if imperfect else ranked[:max(1, len(ranked)//3)]
        _, opp, prefs = r.choice(choices)
        cross_reason = None
        if creator["category"] != opp["category"]:
            cross_reason = r.choice(["creator format expertise fits the concept", "audience overlap supports a cross-category story", "brand requested a fresh adjacent-category perspective"])
        start = date.fromisoformat(opp["timeline"]["briefing_date"]) + timedelta(days=r.randint(0, 3))
        t = by_truth[creator["id"]]
        jid, previous, contract_id = f"syn_journey_{journey_index:05d}", None, None
        previous = add(jid, creator, opp, "invitation", start, {"direction": r.choice(["brand_invitation", "creator_application"]), "availability_at_invitation": r.choices(["available", "limited"], [82, 18])[0]}, None, previous)
        summaries[creator["id"]]["invitations"] += 1
        if len(events) >= config.interactions: break
        if r.random() > .95:
            continue
        previous = add(jid, creator, opp, "match", start+timedelta(days=1), {"preference_reasons": prefs, "exception_reason": cross_reason}, None, previous)
        if r.random() < (1 - t["responsiveness"]) * .20:
            previous = add(jid, creator, opp, "withdrawal", start+timedelta(days=3), {"party": "creator", "reason": "schedule changed before contracting", "attribution": "creator"}, None, previous)
            summaries[creator["id"]]["withdrawals"] += int(previous is not None)
            continue
        previous = add(jid, creator, opp, "negotiation", start+timedelta(days=2), {"topics": r.sample(["fee", "usage rights", "timeline", "creative scope", "exclusivity"], 2), "result": "agreed"}, None, previous)
        if r.random() < .07:
            previous = add(jid, creator, opp, "cancellation", start+timedelta(days=4), {"party": "brand", "reason": "campaign priority changed", "attribution": "brand"}, None, previous)
            summaries[creator["id"]]["cancellations"] += int(previous is not None)
            continue
        contract_id = f"syn_contract_{journey_index:05d}"
        rate = _rate_for(creator, opp["deliverables"][0])
        fee_usd = int(Decimal(rate["base_rate"]["normalized_usd"]) * opp["deliverables"][0]["quantity"])
        currency = opp["budget"]["currency"]
        deadline = start + timedelta(days=r.randint(12, 24))
        previous = add(jid, creator, opp, "contract", start+timedelta(days=4), {"agreed_fee": _money_from_usd(fee_usd, currency), "deadline": deadline.isoformat(),
                      "deliverables": opp["deliverables"], "required_language": opp["required_languages"][0], "usage_rights": opp["usage_rights"]}, contract_id, previous)
        summaries[creator["id"]]["contracts"] += int(previous is not None)
        if len(events) >= config.interactions: break
        if r.random() > t["reliability"] and r.random() < .24:
            previous = add(jid, creator, opp, "cancellation", start+timedelta(days=7), {"party": "creator", "reason": "capacity issue after contracting", "attribution": "creator"}, contract_id, previous)
            summaries[creator["id"]]["cancellations"] += int(previous is not None)
            continue
        late_probability = .05 + (1-t["delivery_consistency"]) * .50
        late = r.random() < late_probability
        submitted = deadline + timedelta(days=r.randint(1, 4)) if late else deadline - timedelta(days=r.randint(1, 4))
        previous = add(jid, creator, opp, "submission", submitted, {"late": late, "evidence_asset_id": f"synthetic-evidence:{jid}", "deliverables_received": True}, contract_id, previous)
        summaries[creator["id"]]["submissions"] += int(previous is not None)
        quality_roll = r.random() + (t["work_quality"]-.75) * .9
        outcome = "pass" if quality_roll > .23 else "partial" if quality_roll > .06 else "fail"
        if r.random() < .07: outcome = "insufficient_evidence"
        verified = submitted + timedelta(days=2)
        previous = add(jid, creator, opp, "verification", verified, {"outcome": outcome, "evidence_sufficient": outcome != "insufficient_evidence", "source": "simulated_review",
                      "requirements_checked": r.randint(2, 5), "requirements_passed": r.randint(1, 4) if outcome != "pass" else r.randint(3, 5)}, contract_id, previous)
        summaries[creator["id"]]["verified_outcomes"] += int(previous is not None)
        final = outcome
        if outcome in {"partial", "fail"} and r.random() < .72 and len(events) < config.interactions:
            previous = add(jid, creator, opp, "revision_requested", verified+timedelta(days=1), {"reason": "one or more brief requirements need correction", "within_revision_limit": True}, contract_id, previous)
            summaries[creator["id"]]["revisions"] += int(previous is not None)
            previous = add(jid, creator, opp, "revision_submitted", verified+timedelta(days=4), {"changes_made": ["clarified key message", "adjusted deliverable to brief"]}, contract_id, previous)
            final = "pass" if r.random() < t["work_quality"] else "partial"
            previous = add(jid, creator, opp, "verification", verified+timedelta(days=6), {"outcome": final, "evidence_sufficient": True, "source": "simulated_review", "requirements_checked": 4, "requirements_passed": 4 if final == "pass" else 3}, contract_id, previous)
            summaries[creator["id"]]["verified_outcomes"] += int(previous is not None)
        dispute_probability = .025 + (1-t["responsiveness"]) * .12 + (.08 if final in {"fail", "partial"} else 0)
        disputed = r.random() < dispute_probability and len(events) < config.interactions
        if disputed:
            previous = add(jid, creator, opp, "dispute", verified+timedelta(days=7), {"status": "open", "reason": r.choice(["scope disagreement", "usage-rights disagreement", "quality disagreement"]), "attribution": None}, contract_id, previous)
            summaries[creator["id"]]["disputes"] += int(previous is not None)
            attribution = r.choices(["creator", "brand", "shared", "neither"], [24, 24, 32, 20])[0]
            previous = add(jid, creator, opp, "dispute_resolved", verified+timedelta(days=12), {"resolution": r.choice(["revision agreed", "fee adjusted", "campaign closed", "work accepted"]), "attribution": attribution}, contract_id, previous)
        if final == "pass" and len(events) < config.interactions:
            previous = add(jid, creator, opp, "completion", verified+timedelta(days=14 if disputed else 8), {"accepted_fulfillment": True, "payment_status_excluded": True}, contract_id, previous)
            summaries[creator["id"]]["successful_deliveries"] += int(previous is not None)
        if r.random() < .78 and len(events) < config.interactions:
            mean = ({"pass": 2.2 + t["work_quality"] * 2.7, "partial": 2.7, "fail": 1.8, "insufficient_evidence": 2.5}[final]
                    + (.20 if not late else -.35))
            stars = max(1, min(5, round(mean + r.uniform(-.8, .8))))
            previous = add(jid, creator, opp, "rating", verified+timedelta(days=16 if disputed else 10), {"stars": stars, "review_text": None if r.random() < .45 else r.choice(["Clear communication and thoughtful execution.", "Good work with minor changes needed.", "The final delivery met the agreed brief.", "Synthetic campaign feedback for evaluation only."])}, contract_id, previous)
            summaries[creator["id"]]["ratings"] += int(previous is not None)
    for creator in creators:
        contracts = creator["history_summary"]["contracts"]
        creator["commercial_experience"]["level"] = "new" if contracts == 0 else "developing" if contracts < 4 else "established"
    return events


def _evaluation(config: ConfigV2, creators: list[dict], campaigns: list[dict]) -> list[dict]:
    scenarios = []
    for index, campaign in enumerate(campaigns):
        candidates = []
        for creator in creators:
            mandatory, failures, prefs = _compatibility(creator, campaign)
            market = "audience_market_overlap" in prefs
            topical = "category_match" in prefs or "niche_match" in prefs
            if not mandatory:
                grade, reasons = 0, ["mandatory_constraint_failure", *failures]
            elif topical and market and len(prefs) >= 3:
                grade, reasons = 3, ["strong_topical_fit", "target_audience_reach", "mandatory_constraints_satisfied"]
            elif topical or (market and "audience_interest_overlap" in prefs):
                grade, reasons = 2, ["credible_content_fit", "some_audience_alignment" if market else "audience_expansion_needed", "mandatory_constraints_satisfied"]
            else:
                grade, reasons = 1, ["mandatory_constraints_satisfied", "weak_topical_or_audience_fit"]
            if creator["history_summary"]["contracts"] == 0:
                reasons.append("cold_start_creator")
            if campaign["cross_category_rationale"] and mandatory and market:
                grade = max(grade, 2)
                reasons.append("legitimate_cross_category_concept")
            candidates.append((grade, len(prefs), creator["id"], reasons))
        if not any(x[0] >= 2 for x in candidates):
            # Some deliberately difficult language/format cases have no topical specialist.
            # A panel may still judge the best mandatory-compatible transferable creators partial matches.
            promotable = sorted((x for x in candidates if x[0] == 1), key=lambda x: (-x[1], x[2]))[:3]
            promote_ids = {x[2] for x in promotable}
            candidates = [(2, score, cid, reasons + ["transferable_format_expertise", "evaluation_panel_exception"])
                          if cid in promote_ids else (grade, score, cid, reasons)
                          for grade, score, cid, reasons in candidates]
        selected = []
        # Fixed panel composition produces positives, partials and hard negatives without using future ranking weights.
        for grade, take in ((3, 3), (2, 3), (1, 3), (0, 3)):
            bucket = [x for x in candidates if x[0] == grade]
            rr = rng_for(config.seed, f"eval-panel:{index}:{grade}"); rr.shuffle(bucket)
            selected.extend(bucket[:take])
        # Fill rare-grade gaps deterministically while retaining at least one hard negative.
        if len(selected) < 12:
            used = {x[2] for x in selected}
            remainder = [x for x in candidates if x[2] not in used]
            remainder.sort(key=lambda x: (abs(x[0]-2), -x[1], x[2]))
            selected.extend(remainder[:12-len(selected)])
        judgments = [{"creator_id": cid, "grade": grade, "label": {0:"not_relevant",1:"weak",2:"relevant",3:"highly_relevant"}[grade],
                      "reason_codes": reasons, "adjudication_note": "Synthetic rubric judgment; not observed user preference or real-world truth."} for grade, _, cid, reasons in selected]
        scenarios.append({"scenario_id": f"eval_scenario_{index+1:03d}", "campaign": campaign, "judgments": judgments,
                          "methodology": {"version": "synthetic-panel-rubric-v1", "independent_of_history_selection": True,
                                          "policy": "Mandatory failures are hard negatives; human-readable topical/audience/cross-category criteria determine graded relevance. No recommendation score is used.",
                                          "limitations": "Programmatic synthetic adjudication is useful for regression tests, not evidence of marketplace accuracy."}})
    return scenarios


def generate_v2(config: ConfigV2 = ConfigV2()) -> dict:
    if config.creators != 500 or config.brands < 40 or config.brands > 60 or config.opportunities != config.brands * 3 or config.interactions < 1:
        raise ValueError("Phase 1B requires 500 creators, 40-60 brands, three opportunities per brand, and positive interactions")
    creators, images, truth = _creators(config)
    brands = _brands(config)
    opportunities = _opportunities(config, brands)
    interactions = _history(config, creators, opportunities, truth)
    eval_campaigns = _opportunities(config, brands, evaluation=True)
    evaluation = _evaluation(config, creators, eval_campaigns)
    return {"creators": creators, "brands": brands, "opportunities": opportunities, "interactions": interactions,
            "images": images, "evaluation": evaluation, "generator_truth": truth,
            "manifest": {"schema_version": "2.0", "generator_version": "2.0", "synthetic": True, "namespace": NAMESPACE,
                         "config": asdict(config), "rate_version": RATE_VERSION, "source_fixture_sha256": hashlib.sha256(FIXTURE.read_bytes()).hexdigest(),
                         "identity_source": "v1 deterministic generator; IDs, names, and image IDs preserved",
                         "separation": {"public_features": "creators.json", "private_generator_traits": "generator_truth.json", "held_out_evaluation": "evaluation.json"},
                         "warnings": ["Fictional demo data; no real partnership, performance, payment quote, or accuracy claim.",
                                      "generator_truth.json is evaluation-only and prohibited as model input.", "Portraits are stable pending references; no images were generated."]}}


def write_v2(dataset: dict, output: Path) -> dict:
    from .schemas_v2 import validate_v2
    report = validate_v2(dataset)
    output.mkdir(parents=True, exist_ok=False)
    checksums = {}
    for name in ("creators", "brands", "opportunities", "interactions", "images", "evaluation", "generator_truth"):
        payload = encoded(dataset[name]); filename = f"{name}.json"
        with (output / filename).open("xb") as stream: stream.write(payload)
        checksums[filename] = hashlib.sha256(payload).hexdigest()
    manifest = {**dataset["manifest"], "files_sha256": checksums}
    quality = quality_report(dataset)
    for name, value in (("manifest", manifest), ("validation", report), ("quality", quality)):
        with (output / f"{name}.json").open("xb") as stream: stream.write(encoded(value))
    return report


def quality_report(data: dict) -> dict:
    creators, opps, events = data["creators"], data["opportunities"], data["interactions"]
    types = Counter(e["event_type"] for e in events)
    outcomes = Counter(e["details"]["outcome"] for e in events if e["event_type"] == "verification")
    histories = [c["history_summary"] for c in creators]
    eval_campaigns = [x["campaign"] for x in data["evaluation"]]
    return {"counts": {k: len(data[k]) for k in ("creators", "brands", "opportunities", "interactions", "images", "evaluation")},
            "countries": len(set(c["residence"]["country_code"] for c in creators)),
            "creators_without_english": sum("en" not in {x["code"] for x in c["languages"]} for c in creators),
            "creators_with_domestic_audience": sum(c["residence"]["country_code"] in {x["country_code"] for x in c["audience"]["markets"]} for c in creators),
            "unique_biographies": len(set(c["bio"] for c in creators)), "unique_briefs": len(set(o["brief"] for o in opps)),
            "cross_category_campaigns_with_rationale": sum(bool(o["cross_category_rationale"]) for o in opps),
            "brand_types": dict(sorted(Counter(b["type"] for b in data["brands"]).items())),
            "audience_profiles": dict(sorted(Counter(c["audience"]["profile"] for c in creators).items())),
            "opportunity_currencies": dict(sorted(Counter(o["budget"]["currency"] for o in opps).items())),
            "event_types": dict(sorted(types.items())), "verification_outcomes": dict(sorted(outcomes.items())),
            "experience": {"zero_contracts": sum(x["contracts"] == 0 for x in histories), "four_plus_contracts": sum(x["contracts"] >= 4 for x in histories),
                           "creators_with_ratings": sum(x["ratings"] > 0 for x in histories), "creators_with_disputes": sum(x["disputes"] > 0 for x in histories)},
            "credibility_evidence": {"late_submissions": sum(e["details"]["late"] for e in events if e["event_type"] == "submission"),
                                     "ratings": dict(sorted(Counter(e["details"]["stars"] for e in events if e["event_type"] == "rating").items())),
                                     "resolved_dispute_attribution": dict(sorted(Counter(e["details"]["attribution"] for e in events if e["event_type"] == "dispute_resolved").items()))},
            "evaluation_judgments": dict(sorted(Counter(j["label"] for s in data["evaluation"] for j in s["judgments"]).items())),
            "evaluation_coverage": {"currencies": sorted(set(c["budget"]["currency"] for c in eval_campaigns)),
                                    "required_languages": sorted(set(x for c in eval_campaigns for x in c["required_languages"])),
                                    "cross_category_scenarios": sum(bool(c["cross_category_rationale"]) for c in eval_campaigns),
                                    "cross_border_scenarios": sum(c["brand_snapshot"]["headquarters"]["country_code"] not in c["target_audience"]["markets"] for c in eval_campaigns),
                                    "cold_start_judgments": sum("cold_start_creator" in j["reason_codes"] for s in data["evaluation"] for j in s["judgments"])}}
