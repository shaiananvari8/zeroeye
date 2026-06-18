#!/usr/bin/env python3
"""Validate that data_generator.py produces byte-identical output per seed."""

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "tools" / "data_generator.py"
SEEDS = [7, 42, 2026]


def file_manifest(directory: Path) -> dict[str, str]:
    manifest: dict[str, str] = {}
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        relpath = path.relative_to(directory).as_posix()
        manifest[relpath] = hashlib.sha256(path.read_bytes()).hexdigest()
    return manifest


def run_generator(seed: int, output_dir: Path) -> dict[str, str]:
    cmd = [
        sys.executable,
        str(GENERATOR),
        "--seed",
        str(seed),
        "--users",
        "6",
        "--orders",
        "9",
        "--trades",
        "12",
        "--ticks",
        "8",
        "--candles",
        "5",
        "--format",
        "both",
        "--output-dir",
        str(output_dir),
    ]
    subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True, text=True)

    metadata = json.loads((output_dir / "metadata.json").read_text(encoding="utf-8"))
    if metadata.get("seed") != seed:
        raise AssertionError(f"metadata.json recorded {metadata.get('seed')}, expected {seed}")

    return file_manifest(output_dir)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="zeroeye-determinism-") as tmp:
        tmpdir = Path(tmp)
        for seed in SEEDS:
            first = run_generator(seed, tmpdir / f"{seed}-a")
            second = run_generator(seed, tmpdir / f"{seed}-b")
            if first != second:
                raise AssertionError(f"generator output differs for seed {seed}")

    print(f"Validated deterministic data generator output for seeds: {', '.join(map(str, SEEDS))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
