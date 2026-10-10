# AfriCre8 ML HTTP contract

The service is a private, stateless inference boundary for NestJS. NestJS remains responsible for authentication, authorization, database access, currency-rate governance, and mapping domain records into the allowlisted DTOs below. OpenAPI is available at `/docs` in development.

## Operations

- `GET /health` is a lightweight liveness check and never loads the semantic model.
- `GET /ready` reports basic model readiness separately from semantic state (`disabled`, `not_loaded`, `ready`, `assets_missing`, or `error`). A lazy semantic model does not make structured, TF-IDF, or credibility inference unready.

## Recommendations

`POST /v1/recommendations` accepts `mode`, one campaign, 1–500 candidate feature profiles, `limit` (1–100), and `include_excluded`. Modes are `structured`, `tfidf_hybrid`, and `semantic_hybrid`; all reuse the existing mandatory eligibility filter. The response includes candidate and eligible counts, ranked scores, component explanations, and optional exclusion reasons.

The creator DTO intentionally excludes demographics, follower counts, existing credibility, earnings, private synthetic truth, and free-form domain fields. The campaign DTO requires versioned USD-normalized budget data. Nested or top-level unknown fields are rejected. NestJS should supply only public ML features and should calculate or validate currency normalization through the platform's governed rate table before calling this service.

Semantic assets are loaded from `AFRICRE8_ML_MODEL_PATH` (default `huggingface/intfloat--multilingual-e5-small`) on first semantic request. `AFRICRE8_ML_SEMANTIC_ENABLED=false` disables that mode. Each worker loads one encoder and retains a two-entry in-memory cache of candidate embeddings; the cache key is a SHA-256 digest of allowlisted candidate data. Model initialization and CPU inference are serialized per worker to prevent duplicate initialization and unsafe concurrent encoder use.

## Credibility

`POST /v1/credibility/score` accepts a creator ID and up to 5,000 ordered-chain campaign events. A creator with no conclusive fulfillment evidence returns HTTP 200 with `credibility_score: null` and `evidence_tier: insufficient`. Invalid event chronology, duplicate evidence, unsupported detail fields, and invalid enumerations return HTTP 422.

`POST /v1/credibility/batch` accepts 1–50 unique creators and at most 10,000 total events. Results preserve input order. Batch validation is atomic: one invalid creator history returns HTTP 422 and no partial result. The endpoint calls the same single-creator model for every entry.

Credibility remains separate from recommendation relevance. History requests reject unknown fields, including generator truth. Outputs are the existing `bayesian-credibility-v2` contract with evidence tiers, component observations, uncertainty, missing-component sensitivity, disputes, and explanations.

## Failure behavior and deployment

Validation failures return 422 without tracebacks. Semantic mode returns 503 when disabled or when local assets cannot load. No permissive CORS middleware is configured because calls are server-to-server. Phase 5 should add private-network controls, service identity/authentication, request IDs, structured logs, timeouts, worker sizing, and resource limits at the deployment boundary.
