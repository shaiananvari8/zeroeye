#!/usr/bin/env python3
"""Focused validation for benchmark rate-limit bypass propagation."""

import contextlib
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import benchmark  # noqa: E402


class _FakeResponse:
    status = 204

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return b""


def main() -> int:
    header = benchmark.RATE_LIMIT_BYPASS_HEADER
    assert benchmark.build_request_headers(False) == {}
    assert benchmark.build_request_headers(True) == {header: "true"}

    captured = {}
    original_urlopen = benchmark.urllib.request.urlopen

    def fake_urlopen(req, timeout):
        captured["headers"] = {name.lower(): value for name, value in req.header_items()}
        captured["timeout"] = timeout
        return _FakeResponse()

    benchmark.urllib.request.urlopen = fake_urlopen
    try:
        status, _duration, error = benchmark.make_request(
            "http://benchmark.example.test/health",
            timeout=1.5,
            headers=benchmark.build_request_headers(True),
        )
    finally:
        benchmark.urllib.request.urlopen = original_urlopen

    assert status == 204
    assert error is None
    assert captured["headers"][header.lower()] == "true"
    assert captured["timeout"] == 1.5

    stderr = io.StringIO()
    with contextlib.redirect_stderr(stderr):
        benchmark.warn_rate_limit_bypass("http://benchmark.example.test/health", header)
    warning = stderr.getvalue()
    assert header in warning
    assert "must explicitly trust" in warning

    print("benchmark rate-limit bypass validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
