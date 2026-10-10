"""Thread-safe adapters around the existing recommendation and credibility models."""

from __future__ import annotations

import hashlib
import json
import os
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from africre8_ml.credibility import CredibilityModel
from africre8_ml.recommendation import (
    RecommendationEngine,
    SemanticHybridRanker,
    StructuredRanker,
    TfidfRanker,
)
from africre8_ml.recommendation.rankers import E5_MODEL_ID, E5_MODEL_REVISION

SERVICE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL_PATH = SERVICE_ROOT / "huggingface" / "intfloat--multilingual-e5-small"
RANKER_VERSIONS = {
    "structured": "structured-v1",
    "tfidf_hybrid": "tfidf-v1",
    "semantic_hybrid": f"multilingual-e5-small-hybrid-v1@{E5_MODEL_REVISION}",
}


class SemanticUnavailable(RuntimeError):
    pass


class ModelServices:
    """One instance per worker; lazy model init and bounded candidate-embedding cache."""

    def __init__(self, *, model_path: Path | None = None, semantic_enabled: bool | None = None):
        self.model_path = model_path or Path(os.getenv("AFRICRE8_ML_MODEL_PATH", DEFAULT_MODEL_PATH))
        configured = os.getenv("AFRICRE8_ML_SEMANTIC_ENABLED", "true").casefold() not in {"0", "false", "no"}
        self.semantic_enabled = configured if semantic_enabled is None else semantic_enabled
        self._encoder = None
        self._semantic_error: str | None = None
        self._semantic_lock = Lock()
        self._inference_lock = Lock()
        self._ranker_cache: OrderedDict[str, SemanticHybridRanker] = OrderedDict()
        self._credibility = CredibilityModel()

    def readiness(self) -> dict:
        assets = self.model_path.is_dir()
        if not self.semantic_enabled:
            status = "disabled"
        elif self._semantic_error:
            status = "error"
        elif self._encoder is not None:
            status = "ready"
        elif not assets:
            status = "assets_missing"
        else:
            status = "not_loaded"
        return {
            "status": "ready",
            "basic_models_ready": True,
            "semantic": {
                "status": status,
                "assets_available": assets,
                "model_id": E5_MODEL_ID,
                "revision": E5_MODEL_REVISION,
                "detail": "Semantic inference is lazy-loaded on first use." if status == "not_loaded" else self._semantic_error,
            },
        }

    @staticmethod
    def _fingerprint(creators: list[dict]) -> str:
        payload = json.dumps(creators, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _semantic_ranker(self, creators: list[dict]) -> SemanticHybridRanker:
        if not self.semantic_enabled:
            raise SemanticUnavailable("semantic ranking is disabled")
        if not self.model_path.is_dir():
            raise SemanticUnavailable("semantic model assets are unavailable")
        key = self._fingerprint(creators)
        with self._semantic_lock:
            cached = self._ranker_cache.get(key)
            if cached is not None:
                self._ranker_cache.move_to_end(key)
                return cached
            try:
                if self._encoder is None:
                    from sentence_transformers import SentenceTransformer

                    self._encoder = SentenceTransformer(
                        str(self.model_path), device="cpu", local_files_only=True, trust_remote_code=False
                    )
                ranker = SemanticHybridRanker(creators, encoder=self._encoder)
            except Exception as exc:
                self._semantic_error = f"local semantic model failed to load: {type(exc).__name__}"
                raise SemanticUnavailable(self._semantic_error) from exc
            self._ranker_cache[key] = ranker
            while len(self._ranker_cache) > 2:
                self._ranker_cache.popitem(last=False)
            return ranker

    def recommend(self, request: dict) -> dict:
        creators = request["candidates"]
        mode = request["mode"]
        if mode == "structured":
            ranker = StructuredRanker()
        elif mode == "tfidf_hybrid":
            ranker = TfidfRanker(creators)
        else:
            ranker = self._semantic_ranker(creators)
        campaign = dict(request["campaign"])
        public_id = campaign.get("id")
        campaign["id"] = public_id or "request-campaign"
        engine = RecommendationEngine(creators, ranker)
        if mode == "semantic_hybrid":
            # SentenceTransformer does not promise concurrent encode safety on
            # one CPU model instance; serialize inference within each worker.
            with self._inference_lock:
                result = engine.recommend(
                    campaign, limit=request["limit"], include_excluded=request["include_excluded"]
                )
        else:
            result = engine.recommend(
                campaign, limit=request["limit"], include_excluded=request["include_excluded"]
            )
        result["campaign_id"] = public_id
        if mode == "tfidf_hybrid":
            result["ranker"] = mode
        result["model_version"] = RANKER_VERSIONS[mode]
        result["excluded_count"] = result["candidate_count"] - result["eligible_count"]
        result["warnings"] = [
            "Scores express relative synthetic-feature compatibility, not predicted campaign success."
        ]
        return result

    def credibility(self, creator_id: str, events: list[dict]) -> dict:
        return self._credibility.score(creator_id, events)
