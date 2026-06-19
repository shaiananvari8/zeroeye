#!/usr/bin/env python3
"""Smoke checks for ai_reviewer.py ignored extension filtering."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import ai_reviewer  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    ignored = ai_reviewer.normalize_ignore_extensions("py, .TS ,")
    require(ignored == {".py", ".ts"}, str(ignored))

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "keep.rs").write_text("fn main() {}\n", encoding="utf-8")
        (root / "skip.py").write_text("print('skip me')\n", encoding="utf-8")
        (root / "skip.ts").write_text("export const skip = true;\n", encoding="utf-8")

        reviewer = ai_reviewer.AiCodeReviewer()
        report = reviewer.review_directory(root, recursive=False, ignore_extensions=ignored)
        reviewed_paths = {Path(result.file_path).name for result in report.file_results}
        require(report.total_files == 1, str(report.total_files))
        require(reviewed_paths == {"keep.rs"}, str(reviewed_paths))

    print("ai_reviewer ignore extension checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
