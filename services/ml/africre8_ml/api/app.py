"""FastAPI application for private NestJS-to-ML service calls."""

from __future__ import annotations

import asyncio

from fastapi import FastAPI, HTTPException

from .schemas import (
    CredibilityBatchRequest,
    CredibilityBatchResponse,
    CredibilityRequest,
    CredibilityResponse,
    HealthResponse,
    ReadinessResponse,
    RecommendationRequest,
    RecommendationResponse,
)
from .service import ModelServices, SemanticUnavailable

API_VERSION = "v1"


def create_app(services: ModelServices | None = None) -> FastAPI:
    runtime = services or ModelServices()
    application = FastAPI(
        title="AfriCre8 ML Service",
        version="0.1.0",
        description="Private, stateless recommendation and credibility inference service.",
    )
    application.state.services = runtime

    @application.get("/health", response_model=HealthResponse, tags=["operations"])
    async def health() -> dict:
        return {"status": "ok", "service": "africre8-ml", "api_version": API_VERSION}

    @application.get("/ready", response_model=ReadinessResponse, tags=["operations"])
    async def ready() -> dict:
        return runtime.readiness()

    @application.post("/v1/recommendations", response_model=RecommendationResponse, tags=["recommendation"])
    async def recommendations(payload: RecommendationRequest) -> dict:
        request = payload.model_dump(mode="json", by_alias=True)
        try:
            return await asyncio.to_thread(runtime.recommend, request)
        except SemanticUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (KeyError, ValueError, ArithmeticError) as exc:
            raise HTTPException(status_code=422, detail=f"invalid recommendation evidence: {exc}") from exc

    @application.post("/v1/credibility/score", response_model=CredibilityResponse, tags=["credibility"])
    async def credibility(payload: CredibilityRequest) -> dict:
        events = [event.model_dump(mode="json") for event in payload.events]
        try:
            return await asyncio.to_thread(runtime.credibility, payload.creator_id, events)
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=f"invalid campaign history: {exc}") from exc

    @application.post("/v1/credibility/batch", response_model=CredibilityBatchResponse, tags=["credibility"])
    async def credibility_batch(payload: CredibilityBatchRequest) -> dict:
        def score_all() -> list[dict]:
            # Atomic batch semantics: one invalid history rejects the whole batch.
            return [
                runtime.credibility(item.creator_id, [event.model_dump(mode="json") for event in item.events])
                for item in payload.creators
            ]

        try:
            return {"results": await asyncio.to_thread(score_all)}
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=f"invalid campaign history: {exc}") from exc

    return application


app = create_app()
