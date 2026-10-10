"""Read-only loaders for public recommendation fixtures."""

from __future__ import annotations

import json
from pathlib import Path

PUBLIC_FILES = frozenset({"creators.json", "evaluation.json", "opportunities.json"})


def load_public_json(dataset_dir: Path, filename: str) -> list[dict]:
    """Load an explicitly allowlisted public fixture; private truth is unreachable."""
    if filename not in PUBLIC_FILES:
        raise ValueError(f"Recommendation loading is not allowed for {filename!r}")
    with (dataset_dir / filename).open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, list):
        raise ValueError(f"Expected a JSON list in {filename}")
    return value


def load_demo_v2(dataset_dir: Path) -> tuple[list[dict], list[dict]]:
    return (
        load_public_json(dataset_dir, "creators.json"),
        load_public_json(dataset_dir, "evaluation.json"),
    )
