"""Structured and TF-IDF relevance rankers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path
from time import perf_counter
from typing import Protocol

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

from .features import campaign_document, creator_document, jaccard, normalized_set, token_jaccard

STRUCTURED_WEIGHTS = {
    "niche": 0.35,
    "audience_interest": 0.25,
    "audience_market": 0.20,
    "category": 0.15,
    "preferred_language": 0.05,
}

SEMANTIC_HYBRID_WEIGHTS = {"semantic": 0.65, "structured": 0.35}
E5_MODEL_ID = "intfloat/multilingual-e5-small"
E5_MODEL_REVISION = "fd1525a9fd15316a2d503bf26ab031a61d056e98"


class TextEncoder(Protocol):
    def encode(self, sentences, **kwargs): ...


class Ranker(ABC):
    name: str

    @abstractmethod
    def score(self, campaign: dict, creators: list[dict]) -> list[dict]:
        """Return one score record per creator in input order."""


class StructuredRanker(Ranker):
    name = "structured"

    def score(self, campaign: dict, creators: list[dict]) -> list[dict]:
        wanted_niches = normalized_set(campaign.get("compatible_niches", []))
        wanted_interests = normalized_set(campaign.get("target_audience", {}).get("interests", []))
        wanted_markets = normalized_set(campaign.get("target_audience", {}).get("markets", []))
        preferred_languages = normalized_set(campaign.get("preferred_languages", []))
        results = []
        for creator in creators:
            creator_niches = normalized_set(creator.get("niches", []))
            creator_interests = normalized_set(creator.get("audience_interests", []))
            market_shares = {
                item["country_code"].casefold(): float(item["share_percent"]) / 100.0
                for item in creator.get("audience", {}).get("markets", [])
            }
            components = {
                "niche": jaccard(creator_niches, wanted_niches),
                "audience_interest": jaccard(creator_interests, wanted_interests),
                "audience_market": min(1.0, sum(market_shares.get(market, 0.0) for market in wanted_markets)),
                "category": (
                    1.0 if creator.get("category", "").casefold() == campaign.get("category", "").casefold()
                    else token_jaccard(creator.get("category", ""), campaign.get("category", ""))
                ),
                "preferred_language": (
                    len(normalized_set(creator.get("content_languages", [])) & preferred_languages)
                    / len(preferred_languages) if preferred_languages else 0.0
                ),
            }
            total = sum(STRUCTURED_WEIGHTS[key] * value for key, value in components.items())
            results.append({"creator_id": creator["id"], "score": total, "components": components})
        return results


class TfidfRanker(Ranker):
    name = "tfidf"

    def __init__(self, creators: list[dict]):
        self._creator_ids = [creator["id"] for creator in creators]
        self._vectorizer = TfidfVectorizer(
            lowercase=True,
            strip_accents="unicode",
            ngram_range=(1, 2),
            min_df=1,
            sublinear_tf=True,
            norm="l2",
        )
        self._matrix = self._vectorizer.fit_transform(creator_document(c) for c in creators)
        self._row = {creator_id: index for index, creator_id in enumerate(self._creator_ids)}

    def score(self, campaign: dict, creators: list[dict]) -> list[dict]:
        query = self._vectorizer.transform([campaign_document(campaign)])
        rows = [self._row[creator["id"]] for creator in creators]
        similarities = cosine_similarity(query, self._matrix[rows]).ravel()
        return [
            {
                "creator_id": creator["id"],
                "score": float(score),
                "components": {"text_cosine_similarity": float(score)},
            }
            for creator, score in zip(creators, similarities, strict=True)
        ]


class SemanticHybridRanker(Ranker):
    """Fixed semantic/structured hybrid using locally stored E5 embeddings."""

    name = "semantic_hybrid"

    def __init__(
        self,
        creators: list[dict],
        *,
        model_path: Path | None = None,
        encoder: TextEncoder | None = None,
        batch_size: int = 32,
    ):
        if encoder is None and model_path is None:
            raise ValueError("model_path is required when no encoder is supplied")
        load_started = perf_counter()
        if encoder is None:
            from sentence_transformers import SentenceTransformer

            encoder = SentenceTransformer(
                str(model_path), device="cpu", local_files_only=True, trust_remote_code=False
            )
        self.model_load_ms = (perf_counter() - load_started) * 1000
        self._encoder = encoder
        self._structured = StructuredRanker()
        self._creator_ids = [creator["id"] for creator in creators]
        encode_started = perf_counter()
        self._embeddings = np.asarray(
            self._encoder.encode(
                [f"passage: {creator_document(creator)}" for creator in creators],
                batch_size=batch_size,
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            ),
            dtype=np.float32,
        )
        self.creator_encoding_ms = (perf_counter() - encode_started) * 1000
        self._row = {creator_id: index for index, creator_id in enumerate(self._creator_ids)}

    def score(self, campaign: dict, creators: list[dict]) -> list[dict]:
        query = np.asarray(
            self._encoder.encode(
                [f"query: {campaign_document(campaign)}"],
                convert_to_numpy=True,
                normalize_embeddings=True,
                show_progress_bar=False,
            ),
            dtype=np.float32,
        )[0]
        rows = [self._row[creator["id"]] for creator in creators]
        semantic_scores = self._embeddings[rows] @ query
        structured = {
            row["creator_id"]: row for row in self._structured.score(campaign, creators)
        }
        results = []
        for creator, semantic in zip(creators, semantic_scores, strict=True):
            structured_row = structured[creator["id"]]
            semantic_unit = min(1.0, max(0.0, float(semantic)))
            total = (
                SEMANTIC_HYBRID_WEIGHTS["semantic"] * semantic_unit
                + SEMANTIC_HYBRID_WEIGHTS["structured"] * structured_row["score"]
            )
            components = {
                "semantic_similarity": semantic_unit,
                **{
                    f"structured_{key}": value
                    for key, value in structured_row["components"].items()
                },
            }
            results.append({
                "creator_id": creator["id"],
                "score": total,
                "components": components,
            })
        return results
