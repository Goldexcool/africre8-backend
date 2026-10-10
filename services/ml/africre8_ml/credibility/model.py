"""Bayesian-smoothed, evidence-based credibility model.

The score is an index, not a calibrated probability of future success. Each
contract contributes at most once per component. The provisional Beta(4, 2)
prior has mean 2/3 and strength six pseudo-observations. It must eventually be
replaced or confirmed using audited production evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import sqrt

from .evidence import ContractEvidence, EvidenceBundle, build_evidence

MODEL_VERSION = "bayesian-credibility-v2"
PRIORS = {
    "fulfillment": (4.0, 2.0),
    "timeliness": (4.0, 2.0),
    "feedback": (4.0, 2.0),
}
COMPONENT_WEIGHTS = {"fulfillment": 0.55, "timeliness": 0.25, "feedback": 0.20}


@dataclass(frozen=True)
class Observation:
    value: float
    explanation: str


def _fulfillment(contract: ContractEvidence) -> Observation | None:
    if contract.creator_cancelled:
        value, explanation = 0.0, "creator-attributed post-contract cancellation"
    elif contract.accepted_fulfillment:
        value, explanation = 1.0, "accepted campaign fulfillment"
    elif contract.verification_outcome == "pass" and contract.evidence_sufficient:
        value, explanation = 0.90, "verified pass without recorded campaign completion"
    elif contract.verification_outcome == "partial" and contract.evidence_sufficient:
        if contract.revisions_submitted:
            value, explanation = 0.65, "partial verification followed by a submitted correction"
        else:
            value, explanation = 0.50, "partial verification without a recorded correction"
    elif contract.verification_outcome == "fail" and contract.evidence_sufficient:
        value, explanation = 0.0, "verified fulfillment failure"
    else:
        return None

    if contract.dispute_opened and contract.dispute_attribution is None:
        value = min(value, 0.50)
        explanation += "; unresolved dispute limits credit"
    elif contract.dispute_attribution == "creator":
        value = min(value, 0.25)
        explanation += "; resolved dispute attributed to creator"
    elif contract.dispute_attribution == "shared":
        value = min(value, 0.60)
        explanation += "; resolved dispute had shared attribution"
    elif contract.dispute_attribution == "brand":
        explanation += "; brand-attributed dispute caused no creator penalty"
    elif contract.dispute_attribution == "neither":
        explanation += "; dispute attributed to neither party caused no creator penalty"
    return Observation(value, explanation)


def _posterior(name: str, observations: list[Observation]) -> dict:
    alpha_prior, beta_prior = PRIORS[name]
    success = sum(item.value for item in observations)
    failure = sum(1.0 - item.value for item in observations)
    alpha, beta = alpha_prior + success, beta_prior + failure
    mean = alpha / (alpha + beta)
    variance = alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1))
    interval = (max(0.0, mean - 1.645 * sqrt(variance)), min(1.0, mean + 1.645 * sqrt(variance)))
    return {
        "score": round(mean * 100, 2),
        "observations": len(observations),
        "observed_mean": round(success / len(observations) * 100, 2) if observations else None,
        "prior": {
            "alpha": alpha_prior,
            "beta": beta_prior,
            "mean": round(alpha_prior / (alpha_prior + beta_prior) * 100, 2),
            "status": "provisional_pending_audited_production_calibration",
        },
        "posterior": {"alpha": round(alpha, 4), "beta": round(beta, 4)},
        "interval_90": [round(interval[0] * 100, 2), round(interval[1] * 100, 2)],
        "interval_method": "Normal approximation to the Beta posterior; fractional outcomes act as fractional pseudo-counts.",
    }


def _evidence_tier(fulfillment_observations: int, observed_components: int) -> str:
    if fulfillment_observations == 0:
        return "insufficient"
    if fulfillment_observations < 3 or observed_components < 2:
        return "limited"
    if fulfillment_observations >= 6 and observed_components == 3:
        return "substantial"
    return "moderate"


def _beta_variance(alpha: float, beta: float) -> float:
    return alpha * beta / ((alpha + beta) ** 2 * (alpha + beta + 1))


def _prior_interval(name: str) -> tuple[float, float]:
    alpha, beta = PRIORS[name]
    center = alpha / (alpha + beta)
    half_width = 1.645 * sqrt(_beta_variance(alpha, beta))
    return max(0.0, center - half_width), min(1.0, center + half_width)


class CredibilityModel:
    """Scores one creator from public campaign events only."""

    version = MODEL_VERSION

    def score(self, creator_id: str, events: list[dict]) -> dict:
        bundle = build_evidence(creator_id, events)
        fulfillment_observations: list[Observation] = []
        timeliness_observations: list[Observation] = []
        feedback_observations: list[Observation] = []
        verification_counts = {key: 0 for key in ("pass", "partial", "fail", "insufficient_evidence")}
        dispute_counts = {key: 0 for key in ("open", "creator", "brand", "shared", "neither")}
        corrections = 0

        for contract in bundle.contracts:
            fulfillment = _fulfillment(contract)
            if fulfillment is not None:
                fulfillment_observations.append(fulfillment)
            if contract.submitted and contract.late is not None:
                timeliness_observations.append(Observation(
                    0.0 if contract.late else 1.0,
                    "late submission observed; cause is not available in demo-v2"
                    if contract.late else "submission recorded on or before the contract deadline",
                ))
            if contract.rating is not None:
                feedback_observations.append(Observation(
                    (contract.rating - 1) / 4,
                    f"campaign-linked rating of {contract.rating}/5",
                ))
            if contract.verification_outcome:
                verification_counts[contract.verification_outcome] += 1
            if contract.revisions_requested and contract.revisions_submitted:
                corrections += 1
            if contract.dispute_opened:
                dispute_counts[contract.dispute_attribution or "open"] += 1

        components = {
            "fulfillment_reliability": _posterior("fulfillment", fulfillment_observations),
            "timeliness": _posterior("timeliness", timeliness_observations),
            "campaign_feedback": _posterior("feedback", feedback_observations),
        }
        sufficient_components = {
            "fulfillment": bool(fulfillment_observations),
            "timeliness": bool(timeliness_observations),
            "feedback": bool(feedback_observations),
        }
        active_weight = sum(
            weight for name, weight in COMPONENT_WEIGHTS.items() if sufficient_components[name]
        )
        score = None
        if fulfillment_observations and active_weight:
            score = sum(
                COMPONENT_WEIGHTS[name]
                * components[{"fulfillment": "fulfillment_reliability", "timeliness": "timeliness", "feedback": "campaign_feedback"}[name]]["score"]
                for name in COMPONENT_WEIGHTS if sufficient_components[name]
            ) / active_weight

        verified = sum(verification_counts.values())
        observed_components = [name for name, present in sufficient_components.items() if present]
        missing_components = [name for name, present in sufficient_components.items() if not present]
        total_component_observations = (
            len(fulfillment_observations) + len(timeliness_observations) + len(feedback_observations)
        )
        evidence_tier = _evidence_tier(len(fulfillment_observations), len(observed_components))

        overall_interval = None
        if score is not None:
            # Components from the same campaign are dependent. Summing weighted
            # standard deviations is the perfect-positive-dependence upper bound,
            # deliberately wider than an independence-based variance sum.
            conservative_sd = 0.0
            component_key = {
                "fulfillment": "fulfillment_reliability",
                "timeliness": "timeliness",
                "feedback": "campaign_feedback",
            }
            for name, weight in COMPONENT_WEIGHTS.items():
                if not sufficient_components[name]:
                    continue
                posterior = components[component_key[name]]["posterior"]
                conservative_sd += (weight / active_weight) * sqrt(
                    _beta_variance(posterior["alpha"], posterior["beta"])
                )
            half_width = 1.645 * conservative_sd * 100
            overall_interval = [
                round(max(0.0, score - half_width), 2),
                round(min(100.0, score + half_width), 2),
            ]

        sensitivity = None
        if score is not None:
            if missing_components:
                prior_low, prior_high = _prior_interval("fulfillment")
                prior_mean = PRIORS["fulfillment"][0] / sum(PRIORS["fulfillment"])
                component_key = {
                    "fulfillment": "fulfillment_reliability",
                    "timeliness": "timeliness",
                    "feedback": "campaign_feedback",
                }

                def assumed_index(missing_value: float) -> float:
                    return 100 * sum(
                        weight * (
                            components[component_key[name]]["score"] / 100
                            if sufficient_components[name] else missing_value
                        )
                        for name, weight in COMPONENT_WEIGHTS.items()
                    )

                sensitivity = {
                    "official_observed_only_score": round(score, 2),
                    "missing_components": missing_components,
                    "assumption_source": "Provisional Beta(4,2) prior-only approximate 90% interval.",
                    "assumed_missing_component_values": {
                        "low": round(prior_low * 100, 2),
                        "reference": round(prior_mean * 100, 2),
                        "high": round(prior_high * 100, 2),
                    },
                    "index_range": [
                        round(assumed_index(prior_low), 2),
                        round(assumed_index(prior_high), 2),
                    ],
                    "reference_index": round(assumed_index(prior_mean), 2),
                    "interpretation": "Sensitivity analysis only; hypothetical values are not inserted into the official score.",
                }
            else:
                sensitivity = {
                    "official_observed_only_score": round(score, 2),
                    "missing_components": [],
                    "index_range": [round(score, 2), round(score, 2)],
                    "reference_index": round(score, 2),
                    "interpretation": "All components are observed; no missing-component sensitivity adjustment is needed.",
                }
        explanations = []
        if not bundle.contracts:
            explanations.append("No contracted campaign history is available; no credibility score is assigned.")
        elif not fulfillment_observations:
            explanations.append("Contracts exist, but no conclusive fulfillment evidence is available.")
        else:
            explanations.append(
                f"{len(fulfillment_observations)} contract-level fulfillment outcomes were Bayesian-smoothed toward the provisional 66.67-point prior."
            )
        if timeliness_observations:
            late = sum(item.value == 0 for item in timeliness_observations)
            explanations.append(f"{len(timeliness_observations)} submissions provide timeliness evidence; {late} were late.")
            if late:
                explanations.append("Late flags record timing only; demo-v2 does not attribute the cause of delay.")
        else:
            explanations.append("No submission-timeliness evidence contributes to the score.")
        if feedback_observations:
            explanations.append(f"{len(feedback_observations)} campaign-linked ratings contribute to feedback.")
        else:
            explanations.append("Missing ratings are excluded rather than treated as negative feedback.")
        if dispute_counts["brand"]:
            explanations.append(f"{dispute_counts['brand']} brand-attributed disputes caused no creator penalty.")
        if dispute_counts["open"]:
            explanations.append(f"{dispute_counts['open']} unresolved disputes conservatively limited fulfillment credit.")
        if missing_components and score is not None:
            explanations.append(
                "The official score uses observed components only; compare it cautiously with scores having different component coverage."
            )

        return {
            "creator_id": creator_id,
            "status": "scored" if score is not None else "insufficient_evidence",
            "credibility_score": round(score, 2) if score is not None else None,
            "score_interpretation": "Evidence-weighted credibility index; not a calibrated probability of future success.",
            "evidence_tier": evidence_tier,
            "evidence_coverage": {
                "independent_fulfillment_observations": len(fulfillment_observations),
                "total_component_observations": total_component_observations,
                "observed_components": observed_components,
                "missing_components": missing_components,
                "component_weight_coverage": round(active_weight, 2),
                "dependence_warning": "Component observations from the same campaign are related and must not be interpreted as fully independent evidence.",
            },
            "evidence": {
                "contracted_campaigns": len(bundle.contracts),
                "verified_campaigns": verified,
                "accepted_fulfillments": sum(contract.accepted_fulfillment for contract in bundle.contracts),
                "fulfillment_observations": len(fulfillment_observations),
                "submission_observations": len(timeliness_observations),
                "ratings": len(feedback_observations),
                "successful_corrections": corrections,
                "verification_outcomes": verification_counts,
                "brand_cancellations_excluded": bundle.brand_cancellations_excluded,
                "precontract_withdrawals_excluded": bundle.precontract_withdrawals_excluded,
            },
            "components": components,
            "component_weights": COMPONENT_WEIGHTS,
            "attributable_disputes": dispute_counts,
            "posterior_uncertainty": {
                "index_interval_90": overall_interval,
                "method": "Conservative normal approximation using the weighted sum of component posterior standard deviations (perfect-positive-dependence bound).",
                "fractional_observations": "Fractional fulfillment and rating values update Beta parameters as fractional pseudo-counts.",
                "interpretation": "Conditional model-index uncertainty, not a future-success probability or prediction interval.",
            },
            "missing_component_sensitivity": sensitivity,
            "explanations": explanations,
            "model_version": MODEL_VERSION,
        }


def score_creator(creator_id: str, events: list[dict]) -> dict:
    return CredibilityModel().score(creator_id, events)
