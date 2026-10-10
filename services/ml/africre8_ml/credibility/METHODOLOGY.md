# Credibility methodology

`bayesian-credibility-v2` is an explainable index of demonstrated campaign fulfillment. It is separate from recommendation relevance and is not a calibrated probability of future success. The production scorer accepts only a creator ID and public campaign events; private generator truth is confined to `offline_evaluation.py`.

## Evidence model

Events are reconstructed into validated journeys and reduced to at most one observation per contract and component. Forty re-verifications after revisions therefore remain part of their original contracts rather than becoming independent evidence.

- **Fulfillment:** accepted completion `1.0`; verified pass without completion `0.90`; partial verification with a submitted correction `0.65`; partial without correction `0.50`; verified failure or creator-attributed post-contract cancellation `0.0`. Insufficient evidence contributes no observation.
- **Disputes:** creator attribution caps fulfillment at `0.25`, shared attribution at `0.60`, and an unresolved dispute at `0.50`. Brand or neither-party attribution causes no creator penalty.
- **Timeliness:** an on-time submission contributes `1.0` and a late submission `0.0`. Demo-v2 has no delay-cause field, so the scorer does not infer responsibility for lateness.
- **Feedback:** a campaign-linked 1–5 star rating maps to `(stars - 1) / 4`. Missing ratings contribute no observation.
- Pre-contract withdrawals and brand cancellations do not count against credibility. A successful correction is reported but is not counted again after final fulfillment.

## Bayesian smoothing and combination

Each component provisionally uses a `Beta(4, 2)` prior: mean `0.6667`, strength six pseudo-observations. This policy assumption must eventually be replaced or confirmed using audited production evidence. For contract-level values `x_i` in `[0,1]`:

`alpha = 4 + sum(x_i)`, `beta = 2 + sum(1 - x_i)`, and `component score = 100 * alpha / (alpha + beta)`.

The overall index uses fulfillment `0.55`, timeliness `0.25`, and feedback `0.20`. Components with no observations are excluded and remaining weights are normalized. No overall score is issued until at least one conclusive fulfillment observation exists.

Evidence tier is `insufficient` with no conclusive fulfillment, `limited` with one or two independent fulfillment observations or fewer than two observed components, `moderate` with three or more fulfillment observations, and `substantial` only with at least six fulfillment observations and all three components represented.

Component intervals use a normal approximation to each Beta posterior. Fractional fulfillment and rating values act as fractional pseudo-counts. The overall 90% index interval uses the weighted sum of component posterior standard deviations, a conservative perfect-positive-dependence bound because observations from the same campaign are related. It is conditional model-index uncertainty, not a future-success probability or prediction interval.

The official score continues to use observed evidence only. For missing timeliness or feedback, a separate sensitivity range fills the missing component solely for analysis with the provisional prior-only approximate 90% bounds. Those hypothetical values never enter the official score. Results expose independent fulfillment count, total component observations, observed and missing components, and weight coverage so differently covered scores can be compared cautiously.

## Prohibited inputs and limitations

The model ignores identity, nationality, appearance, audience size, followers, popularity, rates, income, recommendation scores, legacy credibility values, and hidden generator traits. Synthetic validation checks implementation behavior only. Real calibration requires policy review, representative production outcomes, appeal and correction processes, monitoring for reporting bias, and validation across markets and campaign types.
