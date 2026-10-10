"""Executable contract and quality safeguards for demo-v2."""
from collections import Counter, defaultdict
from datetime import date
from decimal import Decimal

from .catalog_v2 import FORMATS, NICHE_CATALOG, REGIONS
from .currency import RATES, normalize
from .synthetic_v2 import NAMESPACE, _compatibility


def require(value, message):
    if not value:
        raise ValueError(message)


def _money(value):
    require(value["currency"] in RATES and Decimal(value["amount"]) > 0, "Invalid money")
    require(value["purpose"] == "synthetic_comparison_only", "Money is not comparison-only")
    require(value["normalized_usd"] == normalize(value["amount"], value["currency"]), "Incorrect normalization")


def validate_v2(data: dict) -> dict:
    manifest, cfg = data["manifest"], data["manifest"]["config"]
    require(manifest["namespace"] == NAMESPACE and manifest["synthetic"] is True and manifest["schema_version"] == "2.0", "Wrong dataset identity")
    expected = {"creators": cfg["creators"], "brands": cfg["brands"], "opportunities": cfg["opportunities"],
                "interactions": cfg["interactions"], "images": cfg["creators"], "evaluation": cfg["evaluation_scenarios"], "generator_truth": cfg["creators"]}
    indexes = {}
    for table, count in expected.items():
        rows = data[table]
        require(len(rows) == count, f"Incorrect {table} count")
        key = "scenario_id" if table == "evaluation" else "id"
        require(len({x[key] for x in rows}) == count, f"Duplicate {table} ID")
        if table != "evaluation":
            require(all(x.get("synthetic") is True and x.get("namespace") == NAMESPACE for x in rows), f"Unsafe {table} row")
        indexes[table] = {x[key]: x for x in rows}
    creators, brands, opps, images, truths = (indexes[x] for x in ("creators", "brands", "opportunities", "images", "generator_truth"))
    fixture_ids = [x["id"] for x in __import__("json").loads(__import__("pathlib").Path(__file__).resolve().parents[3].joinpath("prisma/seed-data/creators.json").read_text(encoding="utf-8"))]
    require(list(creators)[:50] == fixture_ids, "Original fixture IDs changed or reordered")
    require(len({c["display_name"] for c in list(creators.values())[:50]}) == 50, "Fixture names unexpectedly duplicated")
    for c in creators.values():
        require(c["residence"]["country_code"] in REGIONS and c["residence"]["city"], "Invalid residence")
        language_codes = {x["code"] for x in c["languages"]}
        require(c["content_languages"] and set(c["content_languages"]) <= language_codes, "Invalid content language")
        require(c["category"] in NICHE_CATALOG and len(c["niches"]) == 3 and set(c["niches"]) <= set(NICHE_CATALOG[c["category"]]), "Invalid niches")
        require(len(c["bio"]) >= 150 and len(c["portfolio_description"]) >= 120, "Creator text too weak")
        require(len(c["production_capabilities"]) >= 2 and len(c["deliverable_capabilities"]) >= 1, "Missing production capabilities")
        shares = c["audience"]["markets"]
        require(sum(x["share_percent"] for x in shares) == 100 and len({x["country_code"] for x in shares}) == len(shares), "Invalid audience distribution")
        require(len(c["audience"]["interests"]) >= 4, "Audience interests too weak")
        social_keys = set()
        for social in c["socials"]:
            require(social["platform"] in FORMATS and social["followers"] >= 800 and 0 < social["engagement_rate_percent"] <= 15, "Invalid social metrics")
            require(0 < social["average_views"] <= social["followers"] * 3 and 1 <= social["posting_frequency_per_week"] <= 7, "Implausible platform metrics")
            require(social["platform"] not in social_keys, "Duplicate platform")
            social_keys.add(social["platform"])
        cap_keys = {(x["platform"], x["format"]) for x in c["deliverable_capabilities"]}
        rate_keys = {(x["platform"], x["format"]) for x in c["commercial_rates"]}
        require(cap_keys == rate_keys and all(p in social_keys and f in FORMATS[p] for p, f in cap_keys), "Rate/capability mismatch")
        for rate in c["commercial_rates"]:
            _money(rate["base_rate"])
            require(Decimal(rate["usage_rights_multiplier"]["90_days_paid"]) > 1 and Decimal(rate["category_exclusivity_30_days_multiplier"]) > 1, "Missing rights uplift")
        require(c["image_asset_id"] in images and images[c["image_asset_id"]]["creator_id"] == c["id"], "Broken image reference")
        require(c["credibility_score"] is None and not ({"reliability", "responsiveness", "work_quality", "delivery_consistency"} & c.keys()), "Hidden trait leaked")
    for t in truths.values():
        require(t["creator_id"] in creators and t["privacy"].startswith("generator_only"), "Invalid generator truth")
        require(t["experience_cohort"] in {"new", "developing", "established"}, "Invalid cohort")
        require(all(.5 <= t[x] <= 1 for x in ("reliability", "responsiveness", "delivery_consistency", "work_quality")), "Invalid latent trait")
    require(len({b["name"] for b in brands.values()}) == len(brands), "Duplicate brand names")
    require(40 <= len(brands) <= 60 and len({b["type"] for b in brands.values()}) == 4, "Poor brand diversity")
    for b in brands.values():
        require(b["industry"] and len(b["operating_markets"]) >= 5 and len(b["products"]) >= 4, "Weak brand")
        require("Fictional" in b["disclaimer"], "Missing brand disclaimer")
    brand_use = Counter(o["brand_id"] for o in opps.values())
    require(set(brand_use) == set(brands) and set(brand_use.values()) == {3}, "Brands must be reusable across three opportunities")
    for o in opps.values():
        require(o["brand_id"] in brands and o["brand_snapshot"]["industry"] == o["industry"], "Broken brand snapshot")
        require(len(o["brief"]) >= 700 and len(o["target_audience"]["markets"]) >= 2, "Brief lacks commercial specificity")
        require(o["required_platforms"] and o["required_languages"] and o["deliverables"], "Missing mandatory constraints")
        require(all(d["platform"] in o["required_platforms"] and d["format"] in FORMATS[d["platform"]] and d["quantity"] > 0 for d in o["deliverables"]), "Invalid deliverable")
        require(date.fromisoformat(o["timeline"]["briefing_date"]) < date.fromisoformat(o["timeline"]["first_draft_due"]) < date.fromisoformat(o["timeline"]["publication_window_end"]), "Invalid campaign timeline")
        _money(o["budget"])
        require(bool(o["cross_category_rationale"]) == (o["category"] != next(a["category"] for a in __import__("africre8_ml.catalog_v2", fromlist=["CAMPAIGN_ARCHETYPES"]).CAMPAIGN_ARCHETYPES if a["industry"] == o["industry"])), "Unexplained cross-category campaign")
    events, seen, last_by_journey, contracts = data["interactions"], {}, {}, {}
    summary_keys = ("invitations", "contracts", "submissions", "verified_outcomes", "successful_deliveries", "revisions", "cancellations", "withdrawals", "ratings", "disputes")
    rebuilt = {cid: {k: 0 for k in summary_keys} for cid in creators}
    order = {"invitation":0, "match":1, "negotiation":2, "contract":3, "submission":4, "verification":5,
             "revision_requested":6, "revision_submitted":7, "dispute":8, "dispute_resolved":9, "completion":10, "rating":11,
             "withdrawal":2, "cancellation":4}
    for e in events:
        require(e["creator_id"] in creators and e["opportunity_id"] in opps and e["event_type"] in order, "Bad event reference/type")
        when = date.fromisoformat(e["occurred_at"])
        previous = e["previous_event_id"]
        if previous is None:
            require(e["event_type"] == "invitation" and e["journey_id"] not in last_by_journey, "Bad journey root")
        else:
            require(previous in seen and last_by_journey[e["journey_id"]] == previous, "Broken event chain")
            require(seen[previous]["creator_id"] == e["creator_id"] and seen[previous]["opportunity_id"] == e["opportunity_id"], "Journey identity changed")
            require(date.fromisoformat(seen[previous]["occurred_at"]) < when, "Nonchronological event")
        kind, cid = e["event_type"], e["creator_id"]
        if kind == "invitation": rebuilt[cid]["invitations"] += 1
        if kind == "contract":
            require(e["contract_id"] and e["contract_id"] not in contracts, "Duplicate contract")
            mandatory, failures, _ = _compatibility(creators[cid], opps[e["opportunity_id"]])
            require(mandatory, f"Contract violates mandatory constraint: {failures}")
            _money(e["details"]["agreed_fee"])
            require(Decimal(e["details"]["agreed_fee"]["normalized_usd"]) <= Decimal(opps[e["opportunity_id"]]["budget"]["normalized_usd"]), "Contract over budget")
            contracts[e["contract_id"]] = e; rebuilt[cid]["contracts"] += 1
        elif order[kind] >= 4 and kind != "cancellation":
            require(e["contract_id"] in contracts, "Post-contract evidence lacks contract")
        if kind == "cancellation" and e["contract_id"] is not None:
            require(e["contract_id"] in contracts, "Post-contract cancellation lacks contract")
        if kind == "submission":
            deadline = date.fromisoformat(contracts[e["contract_id"]]["details"]["deadline"])
            require(e["details"]["late"] == (when > deadline), "Incorrect late flag")
            rebuilt[cid]["submissions"] += 1
        if kind == "verification":
            require(e["details"]["outcome"] in {"pass", "partial", "fail", "insufficient_evidence"}, "Bad verification")
            rebuilt[cid]["verified_outcomes"] += 1
        if kind == "completion": rebuilt[cid]["successful_deliveries"] += 1
        if kind == "revision_requested": rebuilt[cid]["revisions"] += 1
        if kind == "cancellation": rebuilt[cid]["cancellations"] += 1
        if kind == "withdrawal": rebuilt[cid]["withdrawals"] += 1
        if kind == "rating":
            require(1 <= e["details"]["stars"] <= 5, "Bad rating"); rebuilt[cid]["ratings"] += 1
        if kind == "dispute":
            require(e["details"]["status"] == "open" and e["details"]["attribution"] is None, "Open dispute attributed"); rebuilt[cid]["disputes"] += 1
        if kind == "dispute_resolved": require(e["details"]["attribution"] in {"creator", "brand", "shared", "neither"}, "Bad dispute attribution")
        seen[e["id"]] = e; last_by_journey[e["journey_id"]] = e["id"]
    for cid, summary in rebuilt.items():
        require(creators[cid]["history_summary"] == summary, "History summary mismatch")
        level = "new" if summary["contracts"] == 0 else "developing" if summary["contracts"] < 4 else "established"
        require(creators[cid]["commercial_experience"]["level"] == level, "Experience label mismatch")
    grades = Counter()
    eval_currencies, eval_languages, cold_judgments = set(), set(), 0
    cross_category_eval = cross_border_eval = 0
    eval_campaign_ids = set()
    for scenario in data["evaluation"]:
        campaign, judgments = scenario["campaign"], scenario["judgments"]
        require(campaign["held_out"] is True and campaign["id"] not in opps and campaign["id"] not in eval_campaign_ids, "Evaluation leakage")
        eval_campaign_ids.add(campaign["id"])
        eval_currencies.add(campaign["budget"]["currency"]); eval_languages.update(campaign["required_languages"])
        cross_category_eval += bool(campaign["cross_category_rationale"])
        cross_border_eval += campaign["brand_snapshot"]["headquarters"]["country_code"] not in campaign["target_audience"]["markets"]
        require(10 <= len(judgments) <= 15 and len({j["creator_id"] for j in judgments}) == len(judgments), "Invalid evaluation panel")
        require(scenario["methodology"]["independent_of_history_selection"] is True, "Evaluation not independent")
        local = set()
        for j in judgments:
            require(j["creator_id"] in creators and j["grade"] in {0,1,2,3} and j["reason_codes"], "Invalid judgment")
            require(j["label"] == {0:"not_relevant",1:"weak",2:"relevant",3:"highly_relevant"}[j["grade"]], "Label/grade mismatch")
            if j["grade"] == 0: require("mandatory_constraint_failure" in j["reason_codes"], "Hard negative lacks reason")
            cold_judgments += "cold_start_creator" in j["reason_codes"]
            local.add(j["grade"]); grades[j["label"]] += 1
        require(0 in local and any(x in local for x in (2,3)), "Panel lacks positive or hard negative")
    require(len(set(c["bio"] for c in creators.values())) >= 490, "Biographies too repetitive")
    require(len(set(o["brief"] for o in opps.values())) == len(opps), "Campaign briefs duplicated")
    require(sum("en" not in {x["code"] for x in c["languages"]} for c in creators.values()) >= 100, "Language distribution implausibly Anglophone")
    require(sum(c["residence"]["country_code"] in {x["country_code"] for x in c["audience"]["markets"]} for c in creators.values()) >= 400, "Audience geography incoherent")
    truth_names = {"reliability", "responsiveness", "delivery_consistency", "work_quality"}
    require(not any(truth_names & set(j) for s in data["evaluation"] for j in s["judgments"]), "Hidden truth leaked into evaluation")
    require(len(eval_currencies) >= 7 and len(eval_languages) >= 5, "Evaluation lacks currency/language coverage")
    require(cross_category_eval >= 2 and cross_border_eval >= 25 and cold_judgments >= 40, "Evaluation scenario coverage too weak")
    return {"valid": True, "counts": expected, "journeys": len(last_by_journey), "contracts": len(contracts),
            "event_types": dict(sorted(Counter(e["event_type"] for e in events).items())),
            "verification_outcomes": dict(sorted(Counter(e["details"]["outcome"] for e in events if e["event_type"] == "verification").items())),
            "evaluation_labels": dict(sorted(grades.items()))}
