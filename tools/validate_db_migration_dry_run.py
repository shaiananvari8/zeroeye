#!/usr/bin/env python3
"""Smoke-test db_migration dry-run SQL previews."""

from __future__ import annotations

import contextlib
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import db_migration


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def fail_if_execute_sql(sql, db_config):
    raise AssertionError(f"dry-run attempted to execute SQL: {sql!r}")


def capture_stdout(fn, *args, **kwargs) -> str:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        result = fn(*args, **kwargs)
    require(result is True or result == 0, f"unexpected result from dry-run call: {result!r}")
    return buffer.getvalue()


def main() -> int:
    original_execute_sql = db_migration.execute_sql
    original_argv = sys.argv[:]

    try:
        db_migration.execute_sql = fail_if_execute_sql

        up_output = capture_stdout(db_migration.run_all_migrations, dry_run=True)
        require("[DRY RUN] SQL to execute:" in up_output, "up dry-run did not print SQL preview")
        require("INSERT INTO _migrations" in up_output, "up dry-run did not show INSERT SQL")
        require("No migrations applied" in up_output or "no migrations applied" in up_output, "up dry-run summary missing")

        down_output = capture_stdout(
            db_migration.apply_migration,
            "20210101000000",
            "down",
            dry_run=True,
        )
        require("DELETE FROM _migrations" in down_output, "down dry-run did not show DELETE SQL")
        require("[DRY RUN] Would roll back migration" in down_output, "down dry-run action missing")

        sys.argv = [
            "db_migration.py",
            "--down",
            "--version",
            "20210101000000",
            "--dry-run",
        ]
        cli_output = capture_stdout(db_migration.main)
        require("DELETE FROM _migrations" in cli_output, "CLI rollback dry-run did not show SQL")

    finally:
        db_migration.execute_sql = original_execute_sql
        sys.argv = original_argv

    print("db_migration dry-run validation passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
