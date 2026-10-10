from __future__ import annotations

import argparse
import json
from pathlib import Path

from .offline_evaluation import load_and_evaluate


def main() -> None:
    parser = argparse.ArgumentParser(description="Run synthetic-only credibility validation")
    parser.add_argument("--data", type=Path, default=Path("data/demo-v2"))
    args = parser.parse_args()
    print(json.dumps(load_and_evaluate(args.data), indent=2))


if __name__ == "__main__":
    main()
