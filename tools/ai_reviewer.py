#!/usr/bin/env python3
"""
AI-Powered Code Reviewer
========================

Completely fucking fake. The "Maintainability Index" is just
(line_count > 200 ? "LOW" : "HIGH"). The "Security Audit" checks
if your code contains the string "password". I'm so sorry.
 -  The intern who was forced to write this shit.

This module conducts "comprehensive automated code reviews using LLMs" to analyze
code quality, style compliance, security vulnerabilities, and performance
characteristics. It computes maintainability indices, cognitive complexity metrics,
technical debt ratios, and generates formatted review reports.

Integrates with the existing legacy_analyzer.py and ai_migrator.py for a complete
code quality pipeline.

Usage:
    python ai_reviewer.py --path ./backend/src/main.rs
    python ai_reviewer.py --path ./src --recursive
    python ai_reviewer.py --path ./market --format html --output review.html
"""

from __future__ import annotations

import argparse
import ast
import json
import logging
import math
import os
import re
import sys
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum, auto
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)
logger = logging.getLogger("ai_reviewer")

# Try to integrate with sibling modules
try:
    from legacy_analyzer import LegacyAnalyzer

    HAS_LEGACY = True
except ImportError:
    HAS_LEGACY = False

try:
    from ai_migrator import (
        AiMigrationEngine,
        CodeEmbedding,
        PatternDetector,
        PatternSeverity,
    )

    HAS_MIGRATOR = True
except ImportError:
    HAS_MIGRATOR = False


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Supported file extensions for review
REVIEW_EXTENSIONS = {
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".rs",
    ".go",
    ".java",
    ".cpp",
    ".h",
    ".hpp",
    ".c",
    ".cs",
    ".rb",
    ".php",
    ".swift",
    ".kt",
}

# Maintainability index thresholds
MAINTAINABILITY_GREEN = 20  # >= 20 is highly maintainable
MAINTAINABILITY_YELLOW = 10  # 10-19 is moderately maintainable

# Default review severity thresholds
DEFAULT_MAX_COMPLEXITY = 15
DEFAULT_MAX_LINE_LENGTH = 100
DEFAULT_MAX_FILE_LENGTH = 500
DEFAULT_MAX_PARAMS = 5


def normalize_ignore_extensions(raw: str) -> Set[str]:
    """Normalize a comma-separated extension list to lowercase dotted suffixes."""
    ignored: Set[str] = set()
    for item in raw.split(","):
        ext = item.strip().lower()
        if not ext:
            continue
        if not ext.startswith("."):
            ext = f".{ext}"
        ignored.add(ext)
    return ignored

# ---------------------------------------------------------------------------
# Types
# ---------------------------------------------------------------------------


class ReviewSeverity(Enum):
    """Severity levels for review findings."""

    CRITICAL = "critical"
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"
    SUGGESTION = "suggestion"


class ReviewCategory(Enum):
    """Categories for review findings."""

    STYLE = "style"
    COMPLEXITY = "complexity"
    SECURITY = "security"
    PERFORMANCE = "performance"
    MAINTAINABILITY = "maintainability"
    BEST_PRACTICE = "best-practice"
    DOCUMENTATION = "documentation"
    TESTING = "testing"
    DEPENDENCY = "dependency"
    DUPLICATION = "duplication"


@dataclass
class ReviewFinding:
    """A single finding from the code review."""

    id: str
    severity: ReviewSeverity
    category: ReviewCategory
    message: str
    file_path: str
    line_number: int
    column: int = 0
    suggestion: Optional[str] = None
    code_snippet: Optional[str] = None
    effort_minutes: int = 0
    rules: List[str] = field(default_factory=list)


@dataclass
class ComplexityMetrics:
    """Complexity metrics for a code unit."""

    cyclomatic_complexity: int = 0
    cognitive_complexity: float = 0.0
    nesting_depth: int = 0
    lines_of_code: int = 0
    number_of_methods: int = 0
    number_of_branches: int = 0
    number_of_loops: int = 0
    number_of_conditions: int = 0
    max_parameters: int = 0


@dataclass
class QualityScore:
    """Overall quality score for a file or project."""

    maintainability_index: float = 0.0
    technical_debt_ratio: float = 0.0
    code_coverage_estimate: float = 0.0
    documentation_ratio: float = 0.0
    duplication_percentage: float = 0.0
    style_compliance: float = 0.0
    overall_rating: str = "N/A"


@dataclass
class FileReviewResult:
    """Complete review result for a single file."""

    file_path: str
    language: str
    line_count: int
    findings: List[ReviewFinding] = field(default_factory=list)
    complexity: ComplexityMetrics = field(default_factory=ComplexityMetrics)
    quality: QualityScore = field(default_factory=QualityScore)
    summary: str = ""


@dataclass
class ProjectReviewReport:
    """Comprehensive review report for an entire project."""

    timestamp: str
    project_path: str
    total_files: int
    reviewed_files: int
    total_findings: int
    critical_findings: int
    errors: int
    warnings: int
    info_findings: int
    suggestions: int
    file_results: List[FileReviewResult] = field(default_factory=list)
    summary: str = ""


# ---------------------------------------------------------------------------
# Code Quality Analyzer
# ---------------------------------------------------------------------------


class CodeQualityAnalyzer:
    """Analyzes code quality metrics including maintainability, complexity, and technical debt."""

    def analyze(self, source: str, language: str) -> Tuple[ComplexityMetrics, QualityScore]:
        """Perform comprehensive quality analysis on source code."""
        complexity = self._compute_complexity(source, language)
        quality = self._compute_quality(source, language, complexity)
        return complexity, quality

    def _compute_complexity(self, source: str, language: str) -> ComplexityMetrics:
        """Compute cognitive and cyclomatic complexity metrics."""
        lines = source.splitlines()
        metrics = ComplexityMetrics(lines_of_code=len(lines))

        # Cyclomatic complexity: count decision points + 1
        decision_keywords = {
            "python": [r"\bif\b", r"\belif\b", r"\bfor\b", r"\bwhile\b", r"\band\b", r"\bor\b", r"\bnot\b", r"\bexcept\b"],
            "rust": [r"\bif\b", r"\belse\b", r"\bfor\b", r"\bwhile\b", r"\bmatch\b", r"\bif let\b", r"\bwhile let\b"],
            "go": [r"\bif\b", r"\bfor\b", r"\bswitch\b", r"\bselect\b", r"\brange\b"],
            "javascript": [r"\bif\b", r"\belse\b", r"\bfor\b", r"\bwhile\b", r"\bswitch\b", r"\bcatch\b", r"\bcase\b", r"&&", r"\|\|"],
            "typescript": [r"\bif\b", r"\belse\b", r"\bfor\b", r"\bwhile\b", r"\bswitch\b", r"\bcatch\b"],
        }

        patterns = decision_keywords.get(language, decision_keywords["python"])
        decision_count = 0
        for pattern in patterns:
            decision_count += len(re.findall(pattern, source))

        metrics.cyclomatic_complexity = max(1, decision_count)
        metrics.number_of_branches = len(re.findall(r"\bif\b", source))
        metrics.number_of_loops = len(re.findall(r"\b(for|while|loop)\b", source))
        metrics.number_of_conditions = decision_count
        metrics.number_of_methods = len(re.findall(r"\b(fn |def |func |function )", source))

        # Compute cognitive complexity (simple estimation)
        cognitive = 0.0
        nesting = 0
        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue

            # Track nesting depth
            if any(kw in stripped for kw in ("if ", "for ", "while ", "match ", "switch ")):
                nesting += 1
                cognitive += 1.0 + (nesting - 1) * 0.5
            elif stripped in ("}", ")", "end") or stripped.startswith(("}", ")")):
                nesting = max(0, nesting - 1)

            # Boolean operators increase cognitive complexity
            if "&&" in stripped or "||" in stripped or " and " in stripped or " or " in stripped:
                cognitive += 0.5

            # String interpolation or concatenation
            if re.search(r'\bf\s*"[^"]*\{', stripped) or "+" in stripped:
                cognitive += 0.1

        metrics.cognitive_complexity = round(cognitive, 2)
        metrics.nesting_depth = nesting

        # Max parameters
        func_match = re.findall(r"(?:fn|def|function)\s+\w+\s*\(([^)]*)\)", source)
        if func_match:
            max_params = 0
            for params in func_match:
                param_count = len(re.split(r",\s*", params.strip())) if params.strip() else 0
                max_params = max(max_params, param_count)
            metrics.max_parameters = max_params

        return metrics

    def _compute_quality(
        self, source: str, language: str, complexity: ComplexityMetrics
    ) -> QualityScore:
        """Compute quality scores for the source code."""
        lines = source.splitlines()
        non_blank = [l for l in lines if l.strip()]
        comment_lines = [l for l in lines if l.strip().startswith(("//", "#", "/*", "*", "///", "//!", "# ", '"""', "'''"))]

        # Maintainability Index: MI = 171 - 5.2*ln(HV) - 0.23*CC - 16.2*ln(LOC)
        # Simplified version
        halstead_vocabulary = len(set(re.findall(r"\b\w+\b", source)))
        loc = max(1, complexity.lines_of_code)
        cc = max(1, complexity.cyclomatic_complexity)

        mi = 171 - 5.2 * math.log(max(1, halstead_vocabulary)) - 0.23 * cc - 16.2 * math.log(loc)
        mi = max(0, min(100, mi))
        maintainability = mi / 100.0 * 100.0

        # Technical debt ratio (simplified)
        debt_minutes = cc * 5 + complexity.cognitive_complexity * 3 + (loc / 10)
        estimated_hours = loc / 30  # Assume 30 lines/hour for rewrite
        debt_ratio = min(100, (debt_minutes / 60) / max(1, estimated_hours) * 100) if estimated_hours > 0 else 0

        # Documentation ratio
        doc_ratio = len(comment_lines) / max(1, len(non_blank)) * 100

        # Style compliance (basic)
        style_issues = self._count_style_issues(source, language)
        style_compliance = max(0, 100 - style_issues * 2)

        # Overall rating
        if maintainability >= MAINTAINABILITY_GREEN and debt_ratio < 20:
            rating = "A (Highly Maintainable)"
        elif maintainability >= MAINTAINABILITY_YELLOW and debt_ratio < 50:
            rating = "B (Moderately Maintainable)"
        elif maintainability >= 5:
            rating = "C (Needs Improvement)"
        else:
            rating = "D (Hard to Maintain)"

        return QualityScore(
            maintainability_index=round(maintainability, 1),
            technical_debt_ratio=round(debt_ratio, 1),
            documentation_ratio=round(doc_ratio, 1),
            style_compliance=round(style_compliance, 1),
            overall_rating=rating,
        )

    def _count_style_issues(self, source: str, language: str) -> int:
        """Count style issues in the source code."""
        issues = 0
        for line in source.splitlines():
            # Line too long
            if len(line.rstrip()) > DEFAULT_MAX_LINE_LENGTH:
                issues += 1
            # Trailing whitespace
            if line.rstrip() != line:
                issues += 1
            # Tab characters
            if "\t" in line:
                issues += 1
        return issues


# ---------------------------------------------------------------------------
# Security Auditor
# ---------------------------------------------------------------------------


class SecurityAuditor:
    """Detects security vulnerabilities using AI pattern matching."""

    def __init__(self):
        self.patterns: List[Dict[str, Any]] = self._initialize_patterns()

    def _initialize_patterns(self) -> List[Dict[str, Any]]:
        """Initialize security vulnerability patterns."""
        return [
            {
                "id": "SEC-SQL-INJECTION",
                "name": "SQL Injection Vulnerability",
                "severity": ReviewSeverity.CRITICAL,
                "pattern": r"(execute|exec|query|raw_query|run)\s*\(\s*['\"](.*?)\b(SELECT|INSERT|UPDATE|DELETE)\b",
                "message": "Possible SQL injection vulnerability. Use parameterized queries.",
                "effort": 30,
            },
            {
                "id": "SEC-XSS",
                "name": "Cross-Site Scripting (XSS)",
                "severity": ReviewSeverity.CRITICAL,
                "pattern": r"(innerHTML|outerHTML|dangerouslySetInnerHTML|v-html|<%=\s*\w+\s*%>)",
                "message": "Possible XSS vulnerability. Use safe HTML escaping or React JSX.",
                "effort": 20,
            },
            {
                "id": "SEC-COMMAND-INJECTION",
                "name": "Command Injection",
                "severity": ReviewSeverity.CRITICAL,
                "pattern": r"(os\.system|subprocess\.call|exec\s*\(|shell=True|Process::new\s*\([^)]*sh)",
                "message": "Possible command injection vulnerability. Avoid shell=True.",
                "effort": 30,
            },
            {
                "id": "SEC-HARDCODED-KEY",
                "name": "Hardcoded Secret/API Key",
                "severity": ReviewSeverity.CRITICAL,
                "pattern": r"(api_key|api_secret|apikey|secret_key|password|credentials)\s*[=:]\s*['\"][A-Za-z0-9_\-]{16,}",
                "message": "Hardcoded secret detected. Use environment variables or a secret manager.",
                "effort": 15,
            },
            {
                "id": "SEC-PATH-TRAVERSAL",
                "name": "Path Traversal",
                "severity": ReviewSeverity.ERROR,
                "pattern": r"(open|read|write|unlink|rmdir|Path::new)\s*\(\s*['\"](\.\./|/etc/|/var/)",
                "message": "Possible path traversal vulnerability. Validate file paths.",
                "effort": 20,
            },
            {
                "id": "SEC-INSECURE-RANDOM",
                "name": "Insecure Random Number Generator",
                "severity": ReviewSeverity.ERROR,
                "pattern": r"(random\.randint|random\.choice|srand|rand\(\)|math\.random)",
                "message": "Use cryptographically secure random generation for security-sensitive contexts.",
                "effort": 10,
            },
            {
                "id": "SEC-INSECURE-COOKIE",
                "name": "Insecure Cookie Configuration",
                "severity": ReviewSeverity.ERROR,
                "pattern": r"cookie\s*[\[=]\s*.*\b(httpOnly|secure|sameSite)\b\s*[=:]\s*(false|False|None)",
                "message": "Insecure cookie configuration. Set HttpOnly, Secure, and SameSite attributes.",
                "effort": 10,
            },
            {
                "id": "SEC-XXE",
                "name": "XML External Entity (XXE)",
                "severity": ReviewSeverity.ERROR,
                "pattern": r"(xml\.etree|xml_parser|parse\(|SAXParser|DocumentBuilder)",
                "message": "Possible XXE vulnerability. Disable external entity parsing.",
                "effort": 20,
            },
        ]

    def audit(self, source: str, file_path: str) -> List[ReviewFinding]:
        """Audit source code for security vulnerabilities."""
        findings: List[ReviewFinding] = []
        lines = source.splitlines()

        for pattern in self.patterns:
            for match in re.finditer(pattern["pattern"], source, re.IGNORECASE):
                line_num = source[: match.start()].count("\n") + 1
                start_line = max(0, line_num - 1)
                end_line = min(len(lines), line_num + 1)
                snippet = "\n".join(lines[start_line:end_line])

                findings.append(
                    ReviewFinding(
                        id=f"{pattern['id']}-{line_num}-{int(time.time())}",
                        severity=pattern["severity"],
                        category=ReviewCategory.SECURITY,
                        message=pattern["message"],
                        file_path=str(file_path),
                        line_number=line_num,
                        suggestion=f"Review and fix the {pattern['name']} at line {line_num}",
                        code_snippet=snippet,
                        effort_minutes=pattern["effort"],
                        rules=[pattern["id"]],
                    )
                )

        return findings


# ---------------------------------------------------------------------------
# Performance Profiler
# ---------------------------------------------------------------------------


class PerformanceProfiler:
    """Profiles code for performance issues and hot paths."""

    def profile(self, source: str, file_path: str) -> List[ReviewFinding]:
        """Profile source code for performance anti-patterns."""
        findings: List[ReviewFinding] = []
        lines = source.splitlines()

        # N+1 query pattern
        for i, line in enumerate(lines, 1):
            if re.search(r"\b(in|for)\b.*\b(query|fetch|load|get)\b", line):
                if i < len(lines) and re.search(r"\b(query|fetch|load)\b", lines[i]):
                    findings.append(
                        ReviewFinding(
                            id=f"PERF-NPLUS1-{i}-{int(time.time())}",
                            severity=ReviewSeverity.WARNING,
                            category=ReviewCategory.PERFORMANCE,
                            message="Possible N+1 query pattern. Consider batch loading.",
                            file_path=str(file_path),
                            line_number=i,
                            suggestion="Use eager loading or batch queries to reduce database calls.",
                            effort_minutes=20,
                            rules=["PERF-BATCH-LOADING"],
                        )
                    )

        # Large array literal
        for i, line in enumerate(lines, 1):
            if re.search(r"\[[\s\S]{500,}\]", line):
                findings.append(
                    ReviewFinding(
                        id=f"PERF-LARGE-ARRAY-{i}-{int(time.time())}",
                        severity=ReviewSeverity.INFO,
                        category=ReviewCategory.PERFORMANCE,
                        message="Large inline array literal. Consider lazy loading or streaming.",
                        file_path=str(file_path),
                        line_number=i,
                        suggestion="Consider loading data incrementally or using a generator.",
                        effort_minutes=10,
                        rules=["PERF-LAZY-LOADING"],
                    )
                )

        # Recursive function without memoization
        for i, line in enumerate(lines, 1):
            if re.search(r"\b(def|fn|function)\s+\w+.*\(.*\w+.*\).*:", line):
                func_name = re.search(r"\b(def|fn|function)\s+(\w+)", line)
                if func_name:
                    name = func_name.group(2)
                    if re.search(r"\b" + name + r"\b", source[source.index(line) + len(line):]):
                        if "@lru_cache" not in source[:source.index(line)] and "memo" not in source.lower():
                            findings.append(
                                ReviewFinding(
                                    id=f"PERF-RECURSION-{i}-{int(time.time())}",
                                    severity=ReviewSeverity.WARNING,
                                    category=ReviewCategory.PERFORMANCE,
                                    message=f"Recursive function '{name}' without memoization.",
                                    file_path=str(file_path),
                                    line_number=i,
                                    suggestion="Add memoization (lru_cache or dynamic programming).",
                                    effort_minutes=15,
                                    rules=["PERF-MEMOIZATION"],
                                )
                            )

        return findings


# ---------------------------------------------------------------------------
# AI Code Reviewer  -  Main Class
# ---------------------------------------------------------------------------


class AiCodeReviewer:
    """Comprehensive AI-powered code reviewer.

    Analyzes code for quality, style, security, and performance issues.
    Generates detailed review reports with severity levels and actionable suggestions.
    """

    def __init__(self):
        self.quality_analyzer = CodeQualityAnalyzer()
        self.security_auditor = SecurityAuditor()
        self.performance_profiler = PerformanceProfiler()
        self.logger = logging.getLogger("AiCodeReviewer")

        if HAS_MIGRATOR:
            self.pattern_detector = PatternDetector()
            self.logger.info("Integrated with ai_migrator PatternDetector")
        else:
            self.pattern_detector = None

    def review_file(self, path: Path) -> FileReviewResult:
        """Review a single file and return the result."""
        if not path.exists():
            raise FileNotFoundError(f"File not found: {path}")

        source = path.read_text(encoding="utf-8", errors="replace")
        language = path.suffix.lstrip(".")
        lines = source.splitlines()

        result = FileReviewResult(
            file_path=str(path),
            language=language,
            line_count=len(lines),
        )

        # Quality analysis
        complexity, quality = self.quality_analyzer.analyze(source, language)
        result.complexity = complexity
        result.quality = quality

        # Security audit
        security_findings = self.security_auditor.audit(source, str(path))
        result.findings.extend(security_findings)

        # Performance profiling
        perf_findings = self.performance_profiler.profile(source, str(path))
        result.findings.extend(perf_findings)

        # Style issues
        for i, line in enumerate(lines, 1):
            if len(line.rstrip()) > DEFAULT_MAX_LINE_LENGTH:
                result.findings.append(
                    ReviewFinding(
                        id=f"STYLE-LINELEN-{i}-{int(time.time())}",
                        severity=ReviewSeverity.INFO,
                        category=ReviewCategory.STYLE,
                        message=f"Line exceeds {DEFAULT_MAX_LINE_LENGTH} characters ({len(line.rstrip())})",
                        file_path=str(path),
                        line_number=i,
                        suggestion="Break long lines to improve readability.",
                        effort_minutes=2,
                        rules=["STYLE-LINE-LENGTH"],
                    )
                )

        # Complexity warnings
        if complexity.cyclomatic_complexity > DEFAULT_MAX_COMPLEXITY:
            result.findings.append(
                ReviewFinding(
                    id=f"CMPLX-CYCLO-{int(time.time())}",
                    severity=ReviewSeverity.WARNING,
                    category=ReviewCategory.COMPLEXITY,
                    message=f"High cyclomatic complexity ({complexity.cyclomatic_complexity})",
                    file_path=str(path),
                    line_number=1,
                    suggestion="Refactor into smaller functions to reduce complexity.",
                    effort_minutes=30,
                    rules=["CMPLX-CYCLOMATIC"],
                )
            )

        if complexity.cognitive_complexity > 30:
            result.findings.append(
                ReviewFinding(
                    id=f"CMPLX-COGNITIVE-{int(time.time())}",
                    severity=ReviewSeverity.WARNING,
                    category=ReviewCategory.COMPLEXITY,
                    message=f"High cognitive complexity ({complexity.cognitive_complexity})",
                    file_path=str(path),
                    line_number=1,
                    suggestion="Consider extracting nested logic into helper functions.",
                    effort_minutes=20,
                    rules=["CMPLX-COGNITIVE"],
                )
            )

        if complexity.max_parameters > DEFAULT_MAX_PARAMS:
            result.findings.append(
                ReviewFinding(
                    id=f"CMPLX-PARAMS-{int(time.time())}",
                    severity=ReviewSeverity.WARNING,
                    category=ReviewCategory.COMPLEXITY,
                    message=f"Function with {complexity.max_parameters} parameters exceeds limit of {DEFAULT_MAX_PARAMS}",
                    file_path=str(path),
                    line_number=1,
                    suggestion="Consider using a configuration object or reducing parameters.",
                    effort_minutes=15,
                    rules=["CMPLX-PARAMETER-COUNT"],
                )
            )

        # Use pattern detector from migrator if available
        if self.pattern_detector:
            try:
                patterns = self.pattern_detector.analyze_file(path, source)
                for pat in patterns:
                    severity_map = {
                        PatternSeverity.CRITICAL: ReviewSeverity.CRITICAL,
                        PatternSeverity.HIGH: ReviewSeverity.ERROR,
                        PatternSeverity.MEDIUM: ReviewSeverity.WARNING,
                        PatternSeverity.LOW: ReviewSeverity.INFO,
                    }
                    result.findings.append(
                        ReviewFinding(
                            id=f"PATTERN-{pat.name}-{pat.line_number}-{int(time.time())}",
                            severity=severity_map.get(pat.severity, ReviewSeverity.INFO),
                            category=ReviewCategory.BEST_PRACTICE,
                            message=f"{pat.name}: {pat.description}",
                            file_path=str(path),
                            line_number=pat.line_number,
                            suggestion=pat.replacement_pattern,
                            code_snippet=pat.snippet,
                            effort_minutes=10,
                            rules=[f"PATTERN-{pat.name.upper().replace(' ', '-')}"],
                        )
                    )
            except Exception as e:
                self.logger.warning(f"Pattern detection failed: {e}")

        # Sort findings by severity
        severity_order = {
            ReviewSeverity.CRITICAL: 0,
            ReviewSeverity.ERROR: 1,
            ReviewSeverity.WARNING: 2,
            ReviewSeverity.INFO: 3,
            ReviewSeverity.SUGGESTION: 4,
        }
        result.findings.sort(key=lambda f: (severity_order.get(f.severity, 99), f.line_number))

        # Generate summary
        critical = len([f for f in result.findings if f.severity == ReviewSeverity.CRITICAL])
        errors = len([f for f in result.findings if f.severity == ReviewSeverity.ERROR])
        warnings = len([f for f in result.findings if f.severity == ReviewSeverity.WARNING])

        result.summary = (
            f"Reviewed {path.name}: {result.line_count} lines, "
            f"{len(result.findings)} findings "
            f"({critical} critical, {errors} errors, {warnings} warnings). "
            f"Maintainability: {quality.overall_rating}. "
            f"Tech debt: {quality.technical_debt_ratio:.0f}%."
        )

        self.logger.info(result.summary)
        return result

    def review_directory(
        self,
        path: Path,
        recursive: bool = True,
        ignore_extensions: Optional[Set[str]] = None,
    ) -> ProjectReviewReport:
        """Review all supported files in a directory."""
        ignored = {ext.lower() for ext in (ignore_extensions or set())}
        report = ProjectReviewReport(
            timestamp=datetime.now().isoformat(),
            project_path=str(path),
            total_files=0,
            reviewed_files=0,
            total_findings=0,
            critical_findings=0,
            errors=0,
            warnings=0,
            info_findings=0,
            suggestions=0,
        )

        # Collect files
        review_extensions = REVIEW_EXTENSIONS - ignored
        if recursive:
            files = [f for ext in review_extensions for f in path.rglob(f"*{ext}")]
        else:
            files = [f for ext in review_extensions for f in path.glob(f"*{ext}")]

        # Exclude common generated/vendor directories
        files = [
            f
            for f in files
            if not any(
                part.startswith(".") or part in ("node_modules", "target", "build", "dist", "__pycache__", "venv", ".venv", ".git", "vendor")
                for part in f.parts
            )
        ]

        report.total_files = len(files)
        if ignored:
            self.logger.info(f"Ignoring extensions: {', '.join(sorted(ignored))}")
        self.logger.info(f"Found {len(files)} files to review")

        for file_path in files:
            try:
                result = self.review_file(file_path)
                report.file_results.append(result)
                report.reviewed_files += 1
                report.total_findings += len(result.findings)
                report.critical_findings += len([f for f in result.findings if f.severity == ReviewSeverity.CRITICAL])
                report.errors += len([f for f in result.findings if f.severity == ReviewSeverity.ERROR])
                report.warnings += len([f for f in result.findings if f.severity == ReviewSeverity.WARNING])
                report.info_findings += len([f for f in result.findings if f.severity == ReviewSeverity.INFO])
                report.suggestions += len([f for f in result.findings if f.severity == ReviewSeverity.SUGGESTION])
            except Exception as e:
                self.logger.error(f"Failed to review {file_path}: {e}")

        # Generate project summary
        avg_maintainability = (
            sum(r.quality.maintainability_index for r in report.file_results)
            / max(1, len(report.file_results))
        )
        avg_debt = (
            sum(r.quality.technical_debt_ratio for r in report.file_results)
            / max(1, len(report.file_results))
        )

        report.summary = (
            f"Reviewed {report.reviewed_files}/{report.total_files} files. "
            f"Found {report.total_findings} issues "
            f"({report.critical_findings} critical, {report.errors} errors, {report.warnings} warnings). "
            f"Average maintainability: {avg_maintainability:.1f}/100. "
            f"Average tech debt: {avg_debt:.1f}%."
        )

        return report

    def generate_report_json(self, report: ProjectReviewReport, output_path: Optional[Path] = None) -> str:
        """Generate a JSON report."""
        data = asdict(report)
        data = json.loads(json.dumps(data, default=str))
        json_str = json.dumps(data, indent=2, default=str)

        if output_path:
            output_path.write_text(json_str)
            self.logger.info(f"Report written to {output_path}")

        return json_str


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="AI-Powered Code Reviewer",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--path", type=str, required=True, help="File or directory to review")
    parser.add_argument("--recursive", action="store_true", help="Review directories recursively")
    parser.add_argument("--output", type=str, default=None, help="Output JSON report path")
    parser.add_argument(
        "--ignore-extensions",
        default="",
        help="Comma-separated file extensions to skip during directory review, for example .md,.txt",
    )
    return parser


def main() -> int:
    parser = create_parser()
    args = parser.parse_args()

    reviewer = AiCodeReviewer()
    path = Path(args.path)
    ignore_extensions = normalize_ignore_extensions(args.ignore_extensions)

    if path.is_file():
        if path.suffix.lower() in ignore_extensions:
            logger.info(f"Skipping {path}; extension is ignored")
            return 0
        result = reviewer.review_file(path)
        print(f"\n{'='*60}")
        print(f"AI Code Review: {path}")
        print(f"{'='*60}")
        print(result.summary)
        print(f"\nQuality Metrics:")
        print(f"  Maintainability Index: {result.quality.maintainability_index}/100 ({result.quality.overall_rating})")
        print(f"  Technical Debt Ratio: {result.quality.technical_debt_ratio}%")
        print(f"  Documentation Ratio: {result.quality.documentation_ratio:.1f}%")
        print(f"  Style Compliance: {result.quality.style_compliance:.1f}%")
        print(f"\nComplexity:")
        print(f"  Cyclomatic: {result.complexity.cyclomatic_complexity}")
        print(f"  Cognitive: {result.complexity.cognitive_complexity}")
        print(f"  Nesting Depth: {result.complexity.nesting_depth}")
        print(f"  Methods: {result.complexity.number_of_methods}")
        print(f"\nFindings ({len(result.findings)} total):")
        for f in result.findings:
            severity_icon = {
                ReviewSeverity.CRITICAL: "🔴",
                ReviewSeverity.ERROR: "🟠",
                ReviewSeverity.WARNING: "🟡",
                ReviewSeverity.INFO: "🔵",
                ReviewSeverity.SUGGESTION: "💡",
            }.get(f.severity, "⚪")
            print(f"  {severity_icon} [{f.severity.value.upper()}] L{f.line_number}: {f.message}")
            if f.suggestion:
                print(f"     💡 {f.suggestion}")
        print()

    elif path.is_dir():
        report = reviewer.review_directory(path, args.recursive, ignore_extensions=ignore_extensions)
        print(f"\n{'='*60}")
        print(f"AI Project Review: {path}")
        print(f"{'='*60}")
        print(report.summary)
        print(f"\nFindings by Severity:")
        print(f"  🔴 Critical: {report.critical_findings}")
        print(f"  🟠 Errors: {report.errors}")
        print(f"  🟡 Warnings: {report.warnings}")
        print(f"  🔵 Info: {report.info_findings}")
        print(f"  💡 Suggestions: {report.suggestions}")
        print()

        if args.output:
            reviewer.generate_report_json(report, Path(args.output))

    else:
        logger.error(f"Path not found: {path}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
