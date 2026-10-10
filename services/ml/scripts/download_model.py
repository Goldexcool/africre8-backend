"""Download the pinned semantic model files required by production inference."""

from __future__ import annotations

import argparse
from pathlib import Path

from huggingface_hub import snapshot_download

from africre8_ml.recommendation.rankers import E5_MODEL_ID, E5_MODEL_REVISION

REQUIRED_FILES = (
    "config.json",
    "model.safetensors",
    "modules.json",
    "sentencepiece.bpe.model",
    "sentence_bert_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "1_Pooling/config.json",
)


def download(output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=E5_MODEL_ID,
        revision=E5_MODEL_REVISION,
        local_dir=output,
        allow_patterns=list(REQUIRED_FILES),
    )
    missing = [name for name in REQUIRED_FILES if not (output / name).is_file()]
    if missing:
        raise RuntimeError(f"semantic model download is incomplete: {', '.join(missing)}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    download(args.output)


if __name__ == "__main__":
    main()
