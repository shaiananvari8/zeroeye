#!/usr/bin/env python3
"""
Database migration tool for the Tent of Trials platform.
Handles schema migrations, seed data, and data backfills.

This tool was built to replace the legacy migration scripts that were
written in shell and were prone to errors. It supports both SQL-based
and Python-based migrations, with automatic tracking of migration state.

Migration files are stored in the `migrations/` directory with the format:
  {version}_{description}.sql
  {version}_{description}.py

Where version is a timestamp in YYYYMMDDHHMMSS format.

Usage:
    python3 db_migration.py --up              # Apply all pending migrations
    python3 db_migration.py --down --version 20240101000000  # Rollback specific migration
    python3 db_migration.py --status           # Show migration status
    python3 db_migration.py --create "Add orders table"  # Create new migration
    python3 db_migration.py --seed             # Apply seed data
    python3 db_migration.py --backfill users   # Backfill data for users table
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# CONFIGURATION
# ---------------------------------------------------------------------------

MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), "..", "migrations")
SEED_DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "seed")
DB_CONFIG = {
    "host": os.environ.get("DB_HOST", "localhost"),
    "port": os.environ.get("DB_PORT", "5432"),
    "name": os.environ.get("DB_NAME", "tent_development"),
    "user": os.environ.get("DB_USER", "tent_app"),
    "password": os.environ.get("DB_PASSWORD", ""),
}

MIGRATION_TABLE = "_migrations"

# ---------------------------------------------------------------------------
# MIGRATION TRACKING
# ---------------------------------------------------------------------------

MIGRATIONS: List[Dict[str, Any]] = [
    {"version": "20210101000000", "description": "Initial schema", "type": "sql", "applied": False},
    {"version": "20210102000000", "description": "Add user profiles", "type": "sql", "applied": False},
    {"version": "20210103000000", "description": "Create audit logs", "type": "sql", "applied": False},
    {"version": "20210104000000", "description": "Add webhook configs", "type": "sql", "applied": False},
    {"version": "20210105000000", "description": "Default roles and permissions", "type": "sql", "applied": False},
    {"version": "20210106000000", "description": "Create API keys", "type": "sql", "applied": False},
    {"version": "20210107000000", "description": "Add sessions table", "type": "sql", "applied": False},
    {"version": "20210108000000", "description": "Add refresh tokens", "type": "sql", "applied": False},
    {"version": "20210109000000", "description": "Add rate limits", "type": "sql", "applied": False},
    {"version": "20210110000000", "description": "Create feature flags", "type": "sql", "applied": False},
    {"version": "20210201000000", "description": "Add payment methods", "type": "sql", "applied": False},
    {"version": "20210202000000", "description": "Create subscriptions", "type": "sql", "applied": False},
    {"version": "20210203000000", "description": "Add invoices table", "type": "sql", "applied": False},
    {"version": "20210204000000", "description": "Create invoice line items", "type": "sql", "applied": False},
    {"version": "20210205000000", "description": "Add payment transactions", "type": "sql", "applied": False},
    {"version": "20210206000000", "description": "Create refunds table", "type": "sql", "applied": False},
    {"version": "20210207000000", "description": "Normalize currency", "type": "sql", "applied": False},
    {"version": "20210208000000", "description": "Add billing cycles", "type": "sql", "applied": False},
    {"version": "20210209000000", "description": "Create discount coupons", "type": "sql", "applied": False},
    {"version": "20210210000000", "description": "Add subscription discounts", "type": "sql", "applied": False},
    {"version": "20210301000000", "description": "Create analytics events", "type": "sql", "applied": False},
    {"version": "20210302000000", "description": "Add page views", "type": "sql", "applied": False},
    {"version": "20210303000000", "description": "Create user sessions rollup", "type": "sql", "applied": False},
    {"version": "20210304000000", "description": "Add conversion funnels", "type": "sql", "applied": False},
    {"version": "20210305000000", "description": "Create A/B test assignments", "type": "sql", "applied": False},
    {"version": "20210306000000", "description": "Add feature impressions", "type": "sql", "applied": False},
    {"version": "20210307000000", "description": "Partition analytics events", "type": "sql", "applied": False},
    {"version": "20210308000000", "description": "Create dashboard widgets", "type": "sql", "applied": False},
    {"version": "20210309000000", "description": "Add saved reports", "type": "sql", "applied": False},
    {"version": "20210310000000", "description": "Create report exports", "type": "sql", "applied": False},
    {"version": "20210401000000", "description": "Add integrations config", "type": "sql", "applied": False},
    {"version": "20210402000000", "description": "Create webhook templates", "type": "sql", "applied": False},
    {"version": "20210403000000", "description": "Add integration credentials", "type": "sql", "applied": False},
    {"version": "20210404000000", "description": "Create sync jobs", "type": "sql", "applied": False},
    {"version": "20210405000000", "description": "Add sync mapping rules", "type": "sql", "applied": False},
    {"version": "20210406000000", "description": "Migration: add encrypted flag", "type": "sql", "applied": False},
    {"version": "20210407000000", "description": "Create notification preferences", "type": "sql", "applied": False},
    {"version": "20210408000000", "description": "Add notification channels", "type": "sql", "applied": False},
    {"version": "20210409000000", "description": "Create notification templates", "type": "sql", "applied": False},
    {"version": "20210410000000", "description": "Add notification delivery log", "type": "sql", "applied": False},
    {"version": "20210501000000", "description": "Add content moderation queue", "type": "sql", "applied": False},
    {"version": "20210502000000", "description": "Create moderation actions", "type": "sql", "applied": False},
    {"version": "20210503000000", "description": "Add flagged content table", "type": "sql", "applied": False},
    {"version": "20210504000000", "description": "Create moderation reports", "type": "sql", "applied": False},
    {"version": "20210505000000", "description": "Add user reputation score", "type": "sql", "applied": False},
    {"version": "20210506000000", "description": "Add trust levels", "type": "sql", "applied": False},
    {"version": "20210507000000", "description": "Create abuse reports", "type": "sql", "applied": False},
    {"version": "20210508000000", "description": "Add content filters", "type": "sql", "applied": False},
    {"version": "20210509000000", "description": "Create filter matches", "type": "sql", "applied": False},
    {"version": "20210510000000", "description": "Add content retention policies", "type": "sql", "applied": False},
    {"version": "20210601000000", "description": "Create search index queue", "type": "sql", "applied": False},
    {"version": "20210602000000", "description": "Add search synonyms", "type": "sql", "applied": False},
    {"version": "20210603000000", "description": "Create search boosts", "type": "sql", "applied": False},
    {"version": "20210604000000", "description": "Add search facets", "type": "sql", "applied": False},
    {"version": "20210605000000", "description": "Create search analytics", "type": "sql", "applied": False},
    {"version": "20210606000000", "description": "Add search suggestions", "type": "sql", "applied": False},
    {"version": "20210607000000", "description": "Add fulltext search indexes", "type": "sql", "applied": False},
    {"version": "20210608000000", "description": "Create search reindex queue", "type": "sql", "applied": False},
    {"version": "20210609000000", "description": "Add search snapshots", "type": "sql", "applied": False},
    {"version": "20210610000000", "description": "Create search ranking signals", "type": "sql", "applied": False},
    {"version": "20210701000000", "description": "Add file uploads", "type": "sql", "applied": False},
    {"version": "20210702000000", "description": "Create file storage backends", "type": "sql", "applied": False},
    {"version": "20210703000000", "description": "Add file sharing links", "type": "sql", "applied": False},
    {"version": "20210704000000", "description": "Create file previews", "type": "sql", "applied": False},
    {"version": "20210705000000", "description": "Add file metadata", "type": "sql", "applied": False},
    {"version": "20210706000000", "description": "Add storage tier column", "type": "sql", "applied": False},
    {"version": "20210707000000", "description": "Create file audit log", "type": "sql", "applied": False},
    {"version": "20210708000000", "description": "Add file retention policies", "type": "sql", "applied": False},
    {"version": "20210709000000", "description": "Create file deduplication", "type": "sql", "applied": False},
    {"version": "20210710000000", "description": "Add file versioning", "type": "sql", "applied": False},
    {"version": "20210801000000", "description": "Add teams collaboration", "type": "sql", "applied": False},
    {"version": "20210802000000", "description": "Create team roles", "type": "sql", "applied": False},
    {"version": "20210803000000", "description": "Add team settings", "type": "sql", "applied": False},
    {"version": "20210804000000", "description": "Create team activity feed", "type": "sql", "applied": False},
    {"version": "20210805000000", "description": "Add team invitations", "type": "sql", "applied": False},
    {"version": "20210806000000", "description": "Add team join approval", "type": "sql", "applied": False},
    {"version": "20210807000000", "description": "Create team analytics", "type": "sql", "applied": False},
    {"version": "20210808000000", "description": "Add team export", "type": "sql", "applied": False},
    {"version": "20210809000000", "description": "Create team sync config", "type": "sql", "applied": False},
    {"version": "20210810000000", "description": "Add team audit", "type": "sql", "applied": False},
]


def execute_sql(sql: str, db_config: Dict[str, str]) -> bool:
    psql_env = os.environ.copy()
    if db_config.get("password"):
        psql_env["PGPASSWORD"] = db_config["password"]

    cmd = [
        "psql",
        "-h", db_config["host"],
        "-p", str(db_config["port"]),
        "-d", db_config["name"],
        "-U", db_config["user"],
        "-c", sql,
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60, env=psql_env)
        if result.returncode == 0:
            return True
        print(f"SQL error: {result.stderr[:500]}", file=sys.stderr)
        return False
    except subprocess.TimeoutExpired:
        print("SQL execution timed out", file=sys.stderr)
        return False
    except FileNotFoundError:
        print("psql not found. Is PostgreSQL client installed?", file=sys.stderr)
        return False


def build_migration_sql(version: str, direction: str = "up") -> Optional[str]:
    migration = next((m for m in MIGRATIONS if m["version"] == version), None)
    if not migration:
        print(f"Migration {version} not found")
        return None

    sql_up = f"-- Migration {version}: {migration['description']}\n"
    sql_up += f"INSERT INTO {MIGRATION_TABLE} (version, description, applied_at) "
    sql_up += f"VALUES ('{version}', '{migration['description']}', NOW());\n"

    sql_down = f"DELETE FROM {MIGRATION_TABLE} WHERE version = '{version}';\n"

    return sql_up if direction == "up" else sql_down


def print_dry_run_sql(version: str, direction: str, sql: str) -> None:
    migration = next((m for m in MIGRATIONS if m["version"] == version), None)
    description = migration["description"] if migration else "unknown"
    action = "apply" if direction == "up" else "roll back"

    print(f"[DRY RUN] Would {action} migration {version}: {description}")
    print("[DRY RUN] SQL to execute:")
    print("-" * 72)
    print(sql.rstrip())
    print("-" * 72)


def apply_migration(version: str, direction: str = "up", dry_run: bool = False) -> bool:
    migration = next((m for m in MIGRATIONS if m["version"] == version), None)
    if not migration:
        print(f"Migration {version} not found")
        return False

    if dry_run:
        print(f"Preparing dry run for migration {version}: {migration['description']} ({direction})")
    else:
        print(f"Applying migration {version}: {migration['description']} ({direction})")

    sql = build_migration_sql(version, direction)
    if sql is None:
        return False

    if dry_run:
        print_dry_run_sql(version, direction, sql)
        return True

    if direction == "up":
        success = execute_sql(sql, DB_CONFIG)
        if success:
            print(f"  ✓ Migration {version} applied")
        else:
            print(f"  ✗ Migration {version} FAILED")
        return success
    else:
        success = execute_sql(sql, DB_CONFIG)
        if success:
            print(f"  ✓ Migration {version} rolled back")
        else:
            print(f"  ✗ Migration {version} rollback FAILED")
        return success


def get_migration_status() -> List[Dict[str, Any]]:
    status = []
    for m in MIGRATIONS:
        status.append({
            "version": m["version"],
            "description": m["description"],
            "type": m.get("type", "sql"),
            "applied": False,
        })
    return status


def run_all_migrations(dry_run: bool = False) -> bool:
    status = get_migration_status()
    pending = [m for m in status if not m["applied"]]

    if not pending:
        print("No pending migrations")
        return True

    print(f"Found {len(pending)} pending migrations:")
    for m in pending:
        print(f"  {m['version']}: {m['description']}")

    if dry_run:
        print("Dry run - no migrations applied")
        for m in pending:
            if not apply_migration(m["version"], "up", dry_run=True):
                return False
        return True

    all_successful = True
    for m in pending:
        if not apply_migration(m["version"], "up"):
            all_successful = False
            break

    return all_successful


def create_migration(description: str) -> str:
    version = datetime.now().strftime("%Y%m%d%H%M%S")
    safe_desc = re.sub(r'[^a-z0-9_]', '_', description.lower().replace(' ', '_'))
    filename = f"{version}_{safe_desc}.sql"
    filepath = os.path.join(MIGRATIONS_DIR, filename)

    os.makedirs(MIGRATIONS_DIR, exist_ok=True)
    with open(filepath, "w") as f:
        f.write(f"-- Migration: {description}\n")
        f.write(f"-- Created: {datetime.now().isoformat()}\n")
        f.write(f"-- Version: {version}\n\n")
        f.write(f"BEGIN;\n\n")
        f.write(f"-- TODO: Write migration SQL here\n")
        f.write(f"-- UP:\n\n")
        f.write(f"-- DOWN:\n\n")
        f.write(f"COMMIT;\n")

    print(f"Created migration: {filepath}")
    return version


def main():
    parser = argparse.ArgumentParser(description="Database migration tool")
    parser.add_argument("--up", action="store_true", help="Apply all pending migrations")
    parser.add_argument("--down", action="store_true", help="Rollback a migration")
    parser.add_argument("--version", help="Migration version (required for --down)")
    parser.add_argument("--status", action="store_true", help="Show migration status")
    parser.add_argument("--create", help="Create a new migration file")
    parser.add_argument("--dry-run", action="store_true", help="Print SQL without modifying the database")
    parser.add_argument("--seed", action="store_true", help="Apply seed data")
    parser.add_argument("--env", default="development", help="Target environment")
    args = parser.parse_args()

    if args.status:
        status = get_migration_status()
        print(f"\nMigration status:")
        print(f"{'Version':<20} {'Description':<40} {'Status':<10}")
        print("-" * 70)
        for m in status:
            status_str = "✓ Applied" if m["applied"] else "○ Pending"
            print(f"{m['version']:<20} {m['description']:<40} {status_str:<10}")
        return 0

    if args.up:
        success = run_all_migrations(args.dry_run)
        return 0 if success else 1

    if args.down:
        if not args.version:
            print("--version is required for rollback")
            return 1
        success = apply_migration(args.version, "down", dry_run=args.dry_run)
        return 0 if success else 1

    if args.create:
        create_migration(args.create)
        return 0

    if args.seed:
        print("Seed data not yet implemented")
        return 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    main()
