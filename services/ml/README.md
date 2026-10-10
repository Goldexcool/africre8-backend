# AfriCre8 ML service

This Python 3.12 service exposes the accepted recommendation and credibility models to the NestJS backend through a private FastAPI boundary. It performs no database, payment, authentication, or campaign-management work and never reads demo datasets in production code.

## Local setup

Activate the existing environment from `services/ml`:

```powershell
.\.venv\Scripts\Activate.ps1
python -m uvicorn africre8_ml.api.app:app --host 127.0.0.1 --port 8001
```

For a clean Windows checkout, create Python 3.12 environment and install the declared project requirements before starting:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
```

Use `GET /health` for liveness and `GET /ready` for basic and semantic readiness. Semantic inference lazy-loads the pinned local `intfloat/multilingual-e5-small` assets; set `AFRICRE8_ML_MODEL_PATH` to override their location or `AFRICRE8_ML_SEMANTIC_ENABLED=false` to disable semantic mode.

## API and development

See [API_CONTRACT.md](API_CONTRACT.md) and the generated `/docs` page. The service supports structured, TF-IDF hybrid, and semantic hybrid recommendation modes plus single and atomic batch credibility scoring. All inputs use strict allowlists and size limits; generator truth and popularity fields are rejected.

Minimal recommendation request:

```json
{"mode":"structured","campaign":{"id":"campaign-1","brief":"Practical family recipe","required_languages":["en"],"required_platforms":["tiktok"],"deliverables":[{"platform":"tiktok","format":"short_video","quantity":1}],"budget":{"amount":"500.00","currency":"USD","normalized_usd":"500.00","rate_version":"platform-fx-v1"}},"candidates":[{"id":"creator-1","content_languages":["en"],"deliverable_capabilities":[{"platform":"tiktok","format":"short_video"}],"commercial_rates":[{"platform":"tiktok","format":"short_video","base_rate":{"amount":"100.00","currency":"USD","normalized_usd":"100.00","rate_version":"platform-fx-v1"}}]}]}
```

Its response includes `model_version`, original compatibility `score`, component explanations, candidate/eligible/excluded counts, and structured exclusions. A new creator credibility request is `{"creator_id":"creator-new","events":[]}` and returns HTTP 200 with `{"creator_id":"creator-new","status":"insufficient_evidence","credibility_score":null,"evidence_tier":"insufficient",...}`.

With the service running, exercise synthetic data only through the isolated helper:

```powershell
python scripts/demo_api_client.py --mode structured
```

Production modules do not import the helper or read `data/demo-v2`. NestJS should map database records to the documented DTOs and remains responsible for service authorization and governed currency normalization.

Swagger UI is available at `http://127.0.0.1:8001/docs`. To run beside NestJS later, bind this service to a private host/port, configure the NestJS server with that internal base URL, and have NestJS make authenticated service calls. Do not expose this API directly to browsers; add private-network policy and service credentials in Phase 5.

## Tests

```powershell
python -m unittest discover -s tests -v
```

The API suite covers validation, eligibility parity, explanations, cold start, malformed history, private-field rejection, batch ordering, and the cached real semantic model when its ignored local assets are present. The credibility index uses the provisional Beta(4,2) prior and is not a calibrated future-success probability; synthetic evaluation does not establish real-world performance.

Private generator truth is excluded from Git. Offline validation and credibility diagnostics deterministically recreate it in memory from the versioned manifest when no local ignored copy is available; it is never accepted by production request schemas or returned in public output.

Structured, TF-IDF, and credibility calls do not initialize E5. The first semantic request loads roughly 493 MB of model assets and creates candidate embeddings; later requests with identical candidates reuse a two-entry per-worker cache. Plan about 1.5–2 GB RAM per semantic worker on CPU, start with one worker, and measure under deployment load. Expensive calls run in worker threads so they do not block the event loop, though each worker serializes semantic initialization and cache creation to prevent duplicate loads.

## Render deployment

Create a separate Render private service with `services/ml` as its root directory and the Docker runtime. The service-scoped Dockerfile installs Python 3.12 dependencies and downloads only the pinned `intfloat/multilingual-e5-small` safetensors, tokenizer, configuration, and pooling files during the image build. It does not copy demo datasets or connect to a database.

Allocate at least 2 GB RAM with one worker. Render supplies `PORT`; the container binds it on `0.0.0.0`. Private services use Render's TCP health check; `/health` and `/ready` remain available for application-level checks from the private network. Set `AFRICRE8_ML_SEMANTIC_ENABLED=true` unless semantic ranking should be intentionally disabled. Set the NestJS service's `ML_SERVICE_URL` to the internal service address shown by Render, including `http://` and the port, without a trailing slash (for example, `http://africre8-ml-xxxx:10000`). Keep both services in the same Render workspace and region. If the ML service is exposed publicly, add service-to-service authentication first.
