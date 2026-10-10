# syntax=docker/dockerfile:1
FROM python:3.12.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    AFRICRE8_ML_MODEL_PATH=/app/model \
    AFRICRE8_ML_SEMANTIC_ENABLED=true

WORKDIR /app

COPY pyproject.toml ./
COPY africre8_ml ./africre8_ml
COPY scripts/download_model.py ./scripts/download_model.py

RUN python -m pip install --index-url https://download.pytorch.org/whl/cpu torch==2.14.1+cpu \
    && python -m pip install . \
    && python scripts/download_model.py --output "$AFRICRE8_ML_MODEL_PATH" \
    && useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    TOKENIZERS_PARALLELISM=false

USER appuser

EXPOSE 10000

CMD ["sh", "-c", "exec uvicorn africre8_ml.api.app:app --host 0.0.0.0 --port ${PORT:-10000} --workers 1"]
