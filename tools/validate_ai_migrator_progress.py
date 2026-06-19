#!/usr/bin/env python3
"""Smoke-test the ai_migrator progress bar."""

from __future__ import annotations

import io
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ai_migrator import AiMigrationEngine, TextProgressBar


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    progress_output = io.StringIO()
    progress = TextProgressBar(total=3, label="Testing", stream=progress_output)
    progress.update(1, "first.py")
    progress.update(3, "last.py")
    progress.finish()
    rendered = progress_output.getvalue()
    require("Testing: [" in rendered, "progress bar label was not rendered")
    require("3/3" in rendered, "progress bar did not reach final count")
    require("100.0%" in rendered, "progress bar did not render completion percent")

    with tempfile.TemporaryDirectory() as tmp:
        source_dir = Path(tmp) / "legacy"
        source_dir.mkdir()
        (source_dir / "legacy_api.py").write_text("def legacy_call():\n    print('old')\n", encoding="utf-8")
        (source_dir / "client.js").write_text("console.log('old');\n", encoding="utf-8")

        engine = AiMigrationEngine()
        stream = io.StringIO()
        report = engine.analyze_directory(source_dir, show_progress=True, progress_stream=stream)
        captured = stream.getvalue()

        require(report.files_analyzed == 2, "expected two supported files to be analyzed")
        require("Analyzing files: [" in captured, "directory analysis did not emit progress")
        require("2/2" in captured, "directory progress did not reach final count")

        muted_stream = io.StringIO()
        engine.analyze_directory(source_dir, show_progress=False, progress_stream=muted_stream)
        require(muted_stream.getvalue() == "", "disabled progress should not write output")

    print("ai_migrator progress validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
