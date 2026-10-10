import argparse
import hashlib
import json
from pathlib import Path

from .schemas import validate
from .synthetic import Config, encoded, generate, write_dataset
from .synthetic_v2 import ConfigV2, generate_v2, write_v2


def main():
    parser = argparse.ArgumentParser(description="Offline synthetic data only; never connects to databases")
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser("generate")
    for key in ("seed", "creators", "opportunities", "interactions"):
        gen.add_argument(f"--{key}", type=int, default=getattr(Config(), key))
    gen.add_argument("--reference-date", default=Config().reference_date)
    gen.add_argument("--output", type=Path, required=True, help="New directory; existing directories are refused")
    gen2 = sub.add_parser("generate-v2")
    for key in ("seed", "creators", "brands", "opportunities", "interactions", "evaluation_scenarios"):
        gen2.add_argument(f"--{key.replace('_', '-')}", dest=key, type=int, default=getattr(ConfigV2(), key))
    gen2.add_argument("--reference-date", default=ConfigV2().reference_date)
    gen2.add_argument("--output", type=Path, required=True, help="New directory; existing directories are refused")
    check = sub.add_parser("validate")
    check.add_argument("directory", type=Path)
    check2 = sub.add_parser("validate-v2")
    check2.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.command == "generate":
        if args.output.exists(): parser.error("Output already exists; choose a new directory")
        cfg = Config(**{key: getattr(args, key) for key in Config.__dataclass_fields__})
        report = write_dataset(generate(cfg), args.output)
    elif args.command == "generate-v2":
        if args.output.exists(): parser.error("Output already exists; choose a new directory")
        cfg = ConfigV2(**{key: getattr(args, key) for key in ConfigV2.__dataclass_fields__})
        report = write_v2(generate_v2(cfg), args.output)
    elif args.command == "validate":
        data = {k: json.loads((args.directory / f"{k}.json").read_text(encoding="utf-8")) for k in ("creators", "opportunities", "interactions", "images", "manifest")}
        for name in ("creators", "opportunities", "interactions", "images"):
            filename = f"{name}.json"
            actual = hashlib.sha256((args.directory / filename).read_bytes()).hexdigest()
            if actual != data["manifest"]["files_sha256"][filename]: raise ValueError(f"Checksum mismatch: {filename}")
        report = validate(data)
    else:
        from .schemas_v2 import validate_v2
        names = ("creators", "brands", "opportunities", "interactions", "images", "evaluation")
        data = {k: json.loads((args.directory / f"{k}.json").read_text(encoding="utf-8")) for k in (*names, "manifest")}
        truth_path = args.directory / "generator_truth.json"
        if truth_path.is_file():
            data["generator_truth"] = json.loads(truth_path.read_text(encoding="utf-8"))
        else:
            config = ConfigV2(**data["manifest"]["config"])
            data["generator_truth"] = generate_v2(config)["generator_truth"]
        for name in (*names, "generator_truth"):
            filename = f"{name}.json"
            path = args.directory / filename
            payload = path.read_bytes() if path.is_file() else encoded(data[name])
            actual = hashlib.sha256(payload).hexdigest()
            if actual != data["manifest"]["files_sha256"][filename]: raise ValueError(f"Checksum mismatch: {filename}")
        report = validate_v2(data)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
