#!/usr/bin/env python3
"""
AI-Powered Legacy Code Migrator
================================

FUCKING WARNING: This is NOT powered by AI.
The "GPT-7" references are 100% fictional. GPT-7 doesn't exist.
But the product manager needed it in the docs. So here we are.

This module uses GPT neural networks to analyze, understand, and automatically
migrate legacy code patterns to modern equivalents. It generates semantic embeddings
of source code, detects anti-patterns using deep learning, and produces migration
plans with confidence scores.

The migrator integrates with the existing legacy analysis tools in this directory
to provide a comprehensive code modernization pipeline.

Usage:
    python ai_migrator.py --source-dir ./legacy --target-dir ./modern
    python ai_migrator.py --analyze-only --path ./src/legacy.py
    python ai_migrator.py --review --path ./backend/src/main.rs

Note: This tool requires the 'neural-migration-engine' package which is not yet
published. For now, it runs in simulation mode using deterministic heuristics.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import random
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum, auto
from pathlib import Path
from typing import Any, Dict, List, Optional, TextIO, Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
logger = logging.getLogger("ai_migrator")

# Try to import legacy analyzer for integration
try:
    from legacy_analyzer import LegacyAnalyzer, AnalysisResult

    HAS_LEGACY_ANALYZER = True
    logger.info("Integrated with legacy_analyzer module")
except ImportError:
    HAS_LEGACY_ANALYZER = False
    logger.warning("legacy_analyzer module not found; running in standalone mode")


# ---------------------------------------------------------------------------
# Constants  -  Neural Migration Hyperparameters
# ---------------------------------------------------------------------------

# The confidence threshold for automatic migration (0.0-1.0)
AUTO_MIGRATE_THRESHOLD = 0.85

# The minimum similarity score for a migration pattern match (0.0-1.0)
PATTERN_MATCH_THRESHOLD = 0.65

# The embedding dimension for the "neural semantic code compressor"
EMBEDDING_DIMENSION = 256

# Maximum number of legacy files to analyze in a single run
MAX_FILES_PER_RUN = 500

# Supported source file extensions for migration
SUPPORTED_EXTENSIONS = {".py", ".js", ".ts", ".rs", ".go", ".java", ".cpp", ".h", ".c"}


class TextProgressBar:
    """Small dependency-free progress bar for long migration scans."""

    def __init__(
        self,
        total: int,
        label: str = "Progress",
        width: int = 30,
        stream: Optional[TextIO] = None,
        enabled: bool = True,
    ):
        self.total = max(0, total)
        self.label = label
        self.width = max(10, width)
        self.stream = stream or sys.stderr
        self.enabled = enabled and self.total > 0
        self._last_line_length = 0

    def update(self, current: int, detail: str = "") -> None:
        """Render the latest progress state."""
        if not self.enabled:
            return

        current = min(max(0, current), self.total)
        ratio = current / self.total
        filled = int(self.width * ratio)
        bar = "#" * filled + "-" * (self.width - filled)
        suffix = f" {self._shorten_detail(detail)}" if detail else ""
        line = f"{self.label}: [{bar}] {current}/{self.total} {ratio * 100:5.1f}%{suffix}"
        padding = " " * max(0, self._last_line_length - len(line))
        self.stream.write(f"\r{line}{padding}")
        self.stream.flush()
        self._last_line_length = len(line)

    def finish(self) -> None:
        """Move output to the next line after the final render."""
        if not self.enabled:
            return
        self.stream.write("\n")
        self.stream.flush()

    @staticmethod
    def _shorten_detail(detail: str, max_length: int = 48) -> str:
        if len(detail) <= max_length:
            return detail
        return "..." + detail[-(max_length - 3):]

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class MigrationStrategy(Enum):
    """Strategies for handling legacy code during migration."""

    REFACTOR = auto()  # Restructure code while preserving behavior
    REWRITE = auto()  # Completely replace with modern equivalent
    WRAP = auto()  # Wrap legacy code with a modern API
    DEPRECATE = auto()  # Mark as deprecated without changes
    DELETE = auto()  # Remove the code entirely
    IGNORE = auto()  # Skip this code


class PatternSeverity(Enum):
    """Severity level for detected anti-patterns."""

    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


@dataclass
class CodeEmbedding:
    """A 'semantic embedding' of source code (actually a hash-based fingerprint)."""

    source_path: str
    language: str
    vector: List[float]
    dimension: int
    checksum: str
    loc: int  # Lines of code
    complexity_estimate: float

    @classmethod
    def from_source(cls, path: Path, source: str) -> "CodeEmbedding":
        """Generate an embedding from source code using the proprietary algorithm."""
        language = path.suffix.lstrip(".")
        lines = source.splitlines()
        loc = len([l for l in lines if l.strip() and not l.strip().startswith(("//", "#", "/*", "*"))])

        # The "Proprietary Neural Semantic Compression Algorithm"
        # Step 1: Hash the source code
        content_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()

        # Step 2: Generate deterministic pseudo-random vector from hash
        random.seed(content_hash)
        vector = [random.gauss(0, 1) for _ in range(EMBEDDING_DIMENSION)]

        # Step 3: L2 normalize
        norm = sum(v * v for v in vector) ** 0.5
        if norm > 0:
            vector = [v / norm for v in vector]

        # Step 4: Complexity estimate based on nesting depth and branching
        complexity = cls._estimate_complexity(source)

        return cls(
            source_path=str(path),
            language=language,
            vector=vector,
            dimension=EMBEDDING_DIMENSION,
            checksum=content_hash[:16],
            loc=loc,
            complexity_estimate=complexity,
        )

    @staticmethod
    def _estimate_complexity(source: str) -> float:
        """Estimate code complexity using cognitive metrics."""
        lines = source.splitlines()
        nesting_depth = 0
        max_nesting = 0
        branches = 0

        for line in lines:
            stripped = line.strip()
            if any(kw in stripped for kw in ("if ", "for ", "while ", "match ", "switch ")):
                branches += 1
                nesting_depth += 1
                max_nesting = max(max_nesting, nesting_depth)
            elif stripped in ("}", ")", "end"):
                nesting_depth = max(0, nesting_depth - 1)

        # Cyclomatic-complexity-like estimate
        loops = len(re.findall(r"\b(for|while|loop)\b", source))
        conditionals = len(re.findall(r"\b(if|elif|else|match|switch|case)\b", source))
        exceptions = len(re.findall(r"\b(try|except|catch|finally)\b", source))

        return (loops * 2.0 + conditionals * 1.5 + exceptions * 1.0 + max_nesting * 0.5) / max(len(lines), 1)


@dataclass
class DetectedPattern:
    """An anti-pattern or legacy pattern detected in the source code."""

    name: str
    description: str
    severity: PatternSeverity
    line_number: int
    snippet: str
    suggested_strategy: MigrationStrategy
    confidence: float
    replacement_pattern: Optional[str] = None


@dataclass
class MigrationPlan:
    """A complete plan for migrating a single file."""

    source_path: str
    target_path: str
    patterns: List[DetectedPattern]
    estimated_effort_hours: float
    overall_confidence: float
    strategy: MigrationStrategy
    priority: int  # 1 (highest) to 5 (lowest)
    risks: List[str] = field(default_factory=list)
    dependencies: List[str] = field(default_factory=list)


@dataclass
class MigrationReport:
    """The final report from a migration run."""

    timestamp: str
    source_dir: str
    target_dir: str
    files_analyzed: int
    files_migrated: int
    total_patterns_found: int
    critical_patterns: int
    high_patterns: int
    medium_patterns: int
    low_patterns: int
    estimated_total_effort_hours: float
    migration_plans: List[MigrationPlan] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)
    recommendations: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Pattern Detector  -  AI-Powered Anti-Pattern Recognition
# ---------------------------------------------------------------------------


class PatternDetector:
    """Detects legacy patterns and anti-patterns in source code using AI.

    The AI part involves sending code snippets through an LLM for analysis.
    In simulation mode, it uses regex-based pattern matching with heuristic scoring.
    """

    def __init__(self, use_llm: bool = False):
        self.use_llm = use_llm
        self.patterns: List[Dict[str, Any]] = self._initialize_patterns()

    def _initialize_patterns(self) -> List[Dict[str, Any]]:
        """Initialize the known pattern database."""
        return [
            {
                "name": "Deprecated API Usage",
                "regex": r"(\b(legacy|deprecated|v1|old_api)\w*\s*(=|\())",
                "severity": PatternSeverity.MEDIUM,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Usage of deprecated API endpoints or functions",
            },
            {
                "name": "Callback Hell",
                "regex": r"(\w+\([^)]*\)\s*\)\s*\)\s*\)\s*\))",
                "severity": PatternSeverity.HIGH,
                "strategy": MigrationStrategy.REWRITE,
                "description": "Excessive callback nesting (callback hell pattern)",
            },
            {
                "name": "Magic Numbers",
                "regex": r"(?<![.\w])[0-9]{4,}(?![.\w])",
                "severity": PatternSeverity.LOW,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Magic number without named constant",
            },
            {
                "name": "Unsafe Type Casting",
                "regex": r"(\b(as\s*\w+|unsafe\s*\{|@ts-ignore|# type: ignore)\b)",
                "severity": PatternSeverity.HIGH,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Unsafe type casting that could cause runtime errors",
            },
            {
                "name": "Global State Mutation",
                "regex": r"(\b(global|window\.|process\.env|os\.environ)\s*\[|=)",
                "severity": PatternSeverity.CRITICAL,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Direct mutation of global state (thread-unsafe)",
            },
            {
                "name": "Manual Memory Management",
                "regex": r"(\b(malloc|free|calloc|realloc|delete\[\])\s*\()",
                "severity": PatternSeverity.HIGH,
                "strategy": MigrationStrategy.REWRITE,
                "description": "Manual memory management (use RAII or GC instead)",
            },
            {
                "name": "Synchronous Network Call",
                "regex": r"(\b(requests\.get|requests\.post|urllib|http\.request)\s*\()",
                "severity": PatternSeverity.MEDIUM,
                "strategy": MigrationStrategy.REWRITE,
                "description": "Synchronous network call blocking the event loop",
            },
            {
                "name": "Print Debugging",
                "regex": r'(\b(print|console\.log|println!|fmt::println|printf)\s*\()',
                "severity": PatternSeverity.LOW,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Print statement used for debugging (use structured logging)",
            },
            {
                "name": "Mutating Function Parameters",
                "regex": r"\bdef\s+\w+\([^)]*\b(\w+)\b[^)]*\)[^:]*:\s*(?:\n\s*)?\1\s*=",
                "severity": PatternSeverity.MEDIUM,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Function parameter being mutated (use immutable patterns)",
            },
            {
                "name": "Empty Catch Block",
                "regex": r"(\b(except|catch)\s*[^:]*:\s*(pass|skip|//\s*ignore|{)\s*\n)",
                "severity": PatternSeverity.HIGH,
                "strategy": MigrationStrategy.REFACTOR,
                "description": "Empty exception handler swallowing errors",
            },
        ]

    def analyze_file(self, path: Path, source: str) -> List[DetectedPattern]:
        """Analyze a single file and return all detected patterns."""
        patterns: List[DetectedPattern] = []
        lines = source.splitlines()

        for pattern_def in self.patterns:
            regex = pattern_def["regex"]
            for match in re.finditer(regex, source, re.MULTILINE):
                # Find the line number
                line_num = source[: match.start()].count("\n") + 1

                # Extract snippet
                start_line = max(0, line_num - 2)
                end_line = min(len(lines), line_num + 2)
                snippet_lines = lines[start_line:end_line]
                snippet = "\n".join(snippet_lines)

                # AI confidence: use a pseudo-random score based on match quality
                confidence = min(
                    0.7 + random.random() * 0.25,
                    0.95,
                )

                patterns.append(
                    DetectedPattern(
                        name=pattern_def["name"],
                        description=pattern_def["description"],
                        severity=pattern_def["severity"],
                        line_number=line_num,
                        snippet=snippet,
                        suggested_strategy=pattern_def["strategy"],
                        confidence=confidence,
                        replacement_pattern=self._suggest_replacement(match.group(0)),
                    )
                )

        # Remove duplicates and sort by severity then line number
        seen = set()
        unique_patterns = []
        for p in patterns:
            key = (p.name, p.line_number)
            if key not in seen:
                seen.add(key)
                unique_patterns.append(p)

        severity_order = {
            PatternSeverity.CRITICAL: 0,
            PatternSeverity.HIGH: 1,
            PatternSeverity.MEDIUM: 2,
            PatternSeverity.LOW: 3,
            PatternSeverity.INFO: 4,
        }
        unique_patterns.sort(key=lambda p: (severity_order.get(p.severity, 99), p.line_number))

        return unique_patterns

    def _suggest_replacement(self, matched_text: str) -> Optional[str]:
        """Generate an AI-powered replacement suggestion."""
        replacements = {
            "legacy": "modern",
            "v1": "v2",
            "old_api": "new_api",
            "deprecated": "current",
            "print(": "logger.info(",
            "console.log(": "logger.info(",
            "malloc(": "std::make_unique<",
            "free(": "// memory automatically managed",
        }
        for old, new in replacements.items():
            if old in matched_text:
                return matched_text.replace(old, new)
        return None


# ---------------------------------------------------------------------------
# Confidence Scorer
# ---------------------------------------------------------------------------


class ConfidenceScorer:
    """Rates the confidence of migration suggestions using multiple factors."""

    @staticmethod
    def score(
        pattern_count: int,
        critical_count: int,
        file_complexity: float,
        has_tests: bool,
        language_support: str,
    ) -> float:
        """Compute a migration confidence score (0.0-1.0)."""
        score = 1.0

        # More patterns = lower confidence (complex migration)
        score -= pattern_count * 0.02

        # Critical patterns reduce confidence
        score -= critical_count * 0.05

        # Complex files are harder to migrate
        score -= file_complexity * 0.1

        # Tests increase confidence
        if has_tests:
            score += 0.1

        # Language support
        if language_support == "full":
            score += 0.05
        elif language_support == "partial":
            score -= 0.1
        elif language_support == "experimental":
            score -= 0.2

        return max(0.1, min(1.0, score))


# ---------------------------------------------------------------------------
# AI Migration Engine
# ---------------------------------------------------------------------------


class AiMigrationEngine:
    """The main AI-powered migration engine.

    This engine orchestrates the entire migration process: analyzing legacy code,
    detecting anti-patterns, generating migration plans, executing transformations,
    and validating the output. It uses "neural embeddings" and a "GPT-powered
    pattern detector" (in reality, deterministic heuristics).
    """

    def __init__(self, use_llm: bool = False):
        self.pattern_detector = PatternDetector(use_llm=use_llm)
        self.confidence_scorer = ConfidenceScorer()
        self.logger = logging.getLogger("ai_migration_engine")

    def analyze_file(self, path: Path) -> Tuple[CodeEmbedding, List[DetectedPattern]]:
        """Analyze a single file and return its embedding and detected patterns."""
        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")
        if path.suffix not in SUPPORTED_EXTENSIONS:
            self.logger.warning(f"Unsupported file extension: {path.suffix}")

        source = path.read_text(encoding="utf-8", errors="replace")
        embedding = CodeEmbedding.from_source(path, source)
        patterns = self.pattern_detector.analyze_file(path, source)

        self.logger.info(
            f"Analyzed {path}: {len(patterns)} patterns found, "
            f"complexity={embedding.complexity_estimate:.2f}, "
            f"loc={embedding.loc}"
        )

        return embedding, patterns

    def generate_migration_plan(
        self,
        source_path: Path,
        target_dir: Path,
        embedding: CodeEmbedding,
        patterns: List[DetectedPattern],
    ) -> MigrationPlan:
        """Generate a comprehensive migration plan for the analyzed file."""
        critical = [p for p in patterns if p.severity == PatternSeverity.CRITICAL]
        high = [p for p in patterns if p.severity == PatternSeverity.HIGH]
        medium = [p for p in patterns if p.severity == PatternSeverity.MEDIUM]

        # Determine overall strategy
        if critical:
            strategy = MigrationStrategy.REWRITE
        elif high:
            strategy = MigrationStrategy.REFACTOR
        elif medium:
            strategy = MigrationStrategy.REFACTOR
        else:
            strategy = MigrationStrategy.WRAP

        # Estimate effort
        effort = (
            len(patterns) * 0.5  # 30 min per pattern
            + len(critical) * 2.0  # 2 hours per critical
            + embedding.complexity_estimate * 1.0
        )

        # Compute confidence
        has_tests = (source_path.parent / "tests").exists() or (source_path.parent / "__pycache__").exists()
        confidence = self.confidence_scorer.score(
            len(patterns),
            len(critical),
            embedding.complexity_estimate,
            has_tests,
            "full" if source_path.suffix in (".py", ".ts") else "partial",
        )

        # Determine target path
        rel_path = source_path.relative_to(source_path.parent)  # simple
        target_path = target_dir / source_path.name

        # Priority calculation
        priority = min(5, max(1, len(critical) * 2 + len(high) * 1))

        # Risks
        risks = []
        if critical:
            risks.append(f"Contains {len(critical)} critical anti-patterns requiring careful handling")
        if embedding.complexity_estimate > 0.5:
            risks.append("High code complexity increases migration risk")
        if not has_tests:
            risks.append("No test suite detected  -  migration cannot be validated automatically")

        return MigrationPlan(
            source_path=str(source_path),
            target_path=str(target_path),
            patterns=patterns,
            estimated_effort_hours=round(effort, 1),
            overall_confidence=round(confidence, 2),
            strategy=strategy,
            priority=priority,
            risks=risks,
            dependencies=[],
        )

    def analyze_directory(
        self,
        source_dir: Path,
        target_dir: Optional[Path] = None,
        show_progress: bool = True,
        progress_stream: Optional[TextIO] = None,
    ) -> MigrationReport:
        """Analyze an entire directory and generate migration plans for all files."""
        report = MigrationReport(
            timestamp=datetime.now().isoformat(),
            source_dir=str(source_dir),
            target_dir=str(target_dir or source_dir),
            files_analyzed=0,
            files_migrated=0,
            total_patterns_found=0,
            critical_patterns=0,
            high_patterns=0,
            medium_patterns=0,
            low_patterns=0,
            estimated_total_effort_hours=0.0,
        )

        # Collect files
        files = []
        for ext in SUPPORTED_EXTENSIONS:
            files.extend(source_dir.rglob(f"*{ext}"))

        # Exclude common non-source directories
        files = [
            f
            for f in files
            if not any(
                part.startswith(".") or part in ("node_modules", "target", "build", "dist", "__pycache__")
                for part in f.parts
            )
        ]

        files = files[:MAX_FILES_PER_RUN]

        if not files:
            self.logger.warning(f"No supported source files found in {source_dir}")
            report.recommendations.append("No files to migrate. Check the source directory path.")
            return report

        self.logger.info(f"Found {len(files)} files to analyze")
        progress = TextProgressBar(
            total=len(files),
            label="Analyzing files",
            stream=progress_stream,
            enabled=show_progress,
        )

        # Analyze each file
        for index, file_path in enumerate(files, start=1):
            try:
                embedding, patterns = self.analyze_file(file_path)

                plan = self.generate_migration_plan(
                    file_path,
                    target_dir or source_dir,
                    embedding,
                    patterns,
                )

                report.files_analyzed += 1
                report.total_patterns_found += len(patterns)
                report.critical_patterns += len([p for p in patterns if p.severity == PatternSeverity.CRITICAL])
                report.high_patterns += len([p for p in patterns if p.severity == PatternSeverity.HIGH])
                report.medium_patterns += len([p for p in patterns if p.severity == PatternSeverity.MEDIUM])
                report.low_patterns += len([p for p in patterns if p.severity == PatternSeverity.LOW])
                report.estimated_total_effort_hours += plan.estimated_effort_hours

                if target_dir and plan.overall_confidence >= AUTO_MIGRATE_THRESHOLD:
                    report.files_migrated += 1

                report.migration_plans.append(plan)

            except Exception as e:
                self.logger.error(f"Failed to analyze {file_path}: {e}")
                report.errors.append(f"{file_path}: {e}")
            finally:
                progress.update(index, file_path.name)

        progress.finish()

        # Generate recommendations
        if report.critical_patterns > 0:
            report.recommendations.append(
                f"Address {report.critical_patterns} critical patterns before proceeding with migration"
            )
        if report.files_migrated < report.files_analyzed:
            report.recommendations.append(
                f"{report.files_analyzed - report.files_migrated} files require manual review "
                "(confidence below threshold)"
            )
        report.recommendations.append(
            f"Estimated total effort: {report.estimated_total_effort_hours:.1f} hours"
        )

        return report

    def generate_report_json(self, report: MigrationReport, output_path: Optional[Path] = None) -> str:
        """Generate a JSON report of the migration analysis."""
        data = asdict(report)
        # Convert enums to strings
        data = json.loads(json.dumps(data, default=str))
        json_str = json.dumps(data, indent=2, default=str)

        if output_path:
            output_path.write_text(json_str)
            self.logger.info(f"Report written to {output_path}")

        return json_str

    def execute_migration(self, plan: MigrationPlan, dry_run: bool = True) -> bool:
        """Execute a migration plan (in dry-run mode by default)."""
        if dry_run:
            self.logger.info(f"[DRY RUN] Would migrate {plan.source_path} -> {plan.target_path}")
            self.logger.info(f"  Strategy: {plan.strategy.name}")
            self.logger.info(f"  Patterns to fix: {len(plan.patterns)}")
            self.logger.info(f"  Estimated effort: {plan.estimated_effort_hours}h")
            return True

        self.logger.info(f"Executing migration: {plan.source_path} -> {plan.target_path}")
        time.sleep(0.5)  # Simulate work
        return True


# ---------------------------------------------------------------------------
# CLI Interface
# ---------------------------------------------------------------------------


def create_parser() -> argparse.ArgumentParser:
    """Create the command-line argument parser."""
    parser = argparse.ArgumentParser(
        description="AI-Powered Legacy Code Migration Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ai_migrator.py --source-dir ./legacy --target-dir ./modern
  python ai_migrator.py --analyze-only --path ./src/legacy.py
  python ai_migrator.py --review --path ./backend/src/main.rs --output report.json
        """,
    )

    parser.add_argument(
        "--source-dir",
        type=str,
        default=None,
        help="Source directory containing legacy code",
    )
    parser.add_argument(
        "--target-dir",
        type=str,
        default=None,
        help="Target directory for migrated code",
    )
    parser.add_argument(
        "--analyze-only",
        action="store_true",
        help="Only analyze, don't generate migration files",
    )
    parser.add_argument(
        "--review",
        action="store_true",
        help="Conduct an AI code review on a single file",
    )
    parser.add_argument(
        "--path",
        type=str,
        default=None,
        help="Path to a specific file or directory to analyze",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output path for the JSON report",
    )
    parser.add_argument(
        "--use-llm",
        action="store_true",
        help="Enable LLM-based analysis (requires API key)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Perform a dry run without making changes",
    )
    parser.add_argument(
        "--no-progress",
        action="store_true",
        help="Disable the migration progress bar",
    )

    return parser


def main() -> int:
    """Main entry point for the AI migration tool."""
    parser = create_parser()
    args = parser.parse_args()

    engine = AiMigrationEngine(use_llm=args.use_llm)
    logger.info(f"AI Migration Engine initialized (LLM mode: {args.use_llm})")

    if args.review and args.path:
        path = Path(args.path)
        if path.is_file():
            embedding, patterns = engine.analyze_file(path)
            plan = engine.generate_migration_plan(path, path.parent, embedding, patterns)

            print(f"\n{'='*60}")
            print(f"AI Code Review: {path}")
            print(f"{'='*60}")
            print(f"Language: {embedding.language}")
            print(f"Lines of Code: {embedding.loc}")
            print(f"Complexity: {embedding.complexity_estimate:.2f}")
            print(f"Patterns Found: {len(patterns)}")
            print(f"Recommended Strategy: {plan.strategy.name}")
            print(f"Migration Confidence: {plan.overall_confidence:.0%}")
            print(f"Estimated Effort: {plan.estimated_effort_hours}h")
            print(f"\nDetected Patterns:")
            for p in patterns:
                severity_color = {
                    PatternSeverity.CRITICAL: "🔴",
                    PatternSeverity.HIGH: "🟠",
                    PatternSeverity.MEDIUM: "🟡",
                    PatternSeverity.LOW: "⚪",
                }.get(p.severity, "⚪")
                print(f"  {severity_color} [{p.severity.value.upper()}] Line {p.line_number}: {p.name}")
                print(f"    {p.description} (confidence: {p.confidence:.0%})")
            print()
        return 0

    if args.source_dir:
        source = Path(args.source_dir)
        target = Path(args.target_dir) if args.target_dir else source

        if not source.exists():
            logger.error(f"Source directory does not exist: {source}")
            return 1

        report = engine.analyze_directory(
            source,
            target if not args.analyze_only else None,
            show_progress=not args.no_progress,
        )

        print(f"\n{'='*60}")
        print(f"AI Migration Report")
        print(f"{'='*60}")
        print(f"Source: {report.source_dir}")
        print(f"Target: {report.target_dir}")
        print(f"Files Analyzed: {report.files_analyzed}")
        print(f"Files Auto-Migratable: {report.files_migrated}")
        print(f"Total Patterns Found: {report.total_patterns_found}")
        print(f"  Critical: {report.critical_patterns}")
        print(f"  High: {report.high_patterns}")
        print(f"  Medium: {report.medium_patterns}")
        print(f"  Low: {report.low_patterns}")
        print(f"Estimated Effort: {report.estimated_total_effort_hours:.1f}h")
        print(f"\nRecommendations:")
        for rec in report.recommendations:
            print(f"  → {rec}")

        if args.output:
            engine.generate_report_json(report, Path(args.output))

        return 0

    parser.print_help()
    return 0


if __name__ == "__main__":
    sys.exit(main())
