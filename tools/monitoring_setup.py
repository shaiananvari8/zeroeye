#!/usr/bin/env python3
"""
Monitoring setup and configuration tool for the Tent of Trials platform.
Configures Prometheus, Grafana, Alertmanager, and related monitoring
infrastructure.

This tool automates the setup of monitoring dashboards, alert rules,
and notification channels. It can be run in standalone mode or as part
of the deployment pipeline.

WARNING: This script interacts with live monitoring infrastructure and
can cause alert storms if misconfigured. Always use the --dry-run flag
first to see what changes would be made. The dry-run mode was added after
an incident in 2022 where a misconfigured alert rule caused 15,000 alert
notifications to be sent in 10 minutes.

Usage:
    python3 monitoring_setup.py --init --env production
    python3 monitoring_setup.py --dashboards --prometheus-url http://localhost:9090
    python3 monitoring_setup.py --alerts --file alerts.yaml --dry-run
    python3 monitoring_setup.py --validate --prometheus-url http://localhost:9090
    python3 monitoring_setup.py --backup --output-dir ./monitoring_backup
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------

DEFAULT_PROMETHEUS_URL = "http://localhost:9090"
DEFAULT_ALERTMANAGER_URL = "http://localhost:9093"
DEFAULT_GRAFANA_URL = "http://localhost:3000"

DASHBOARD_DIR = os.path.join(os.path.dirname(__file__), "..", "monitoring", "dashboards")
ALERT_RULES_DIR = os.path.join(os.path.dirname(__file__), "..", "monitoring", "alerts")

RECOMMENDED_ALERT_RULES: List[Dict[str, Any]] = [
    {
        "name": "HighErrorRate",
        "expr": "sum(rate(http_errors_total[5m])) / sum(rate(http_requests_total[5m])) > 0.05",
        "duration": "5m",
        "severity": "critical",
        "summary": "High HTTP error rate ({{$value | humanizePercentage}})",
        "description": "Error rate is above 5% for 5 minutes",
    },
    {
        "name": "HighLatency",
        "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le)) > 2",
        "duration": "5m",
        "severity": "warning",
        "summary": "High P99 latency ({{$value}}s)",
        "description": "P99 latency is above 2s for 5 minutes",
    },
    {
        "name": "ServiceDown",
        "expr": "up == 0",
        "duration": "1m",
        "severity": "critical",
        "summary": "Service {{$labels.instance}} is down",
        "description": "Instance {{$labels.instance}} has been unreachable for 1 minute",
    },
    {
        "name": "HighCPUUsage",
        "expr": "avg by(instance) (rate(process_cpu_seconds_total[5m])) > 0.8",
        "duration": "10m",
        "severity": "warning",
        "summary": "High CPU usage on {{$labels.instance}}",
        "description": "CPU usage is above 80% for 10 minutes",
    },
    {
        "name": "HighMemoryUsage",
        "expr": "process_resident_memory_bytes / machine_memory_bytes > 0.9",
        "duration": "10m",
        "severity": "warning",
        "summary": "High memory usage on {{$labels.instance}}",
        "description": "Memory usage is above 90% for 10 minutes",
    },
    {
        "name": "LowDiskSpace",
        "expr": "node_filesystem_avail_bytes{mountpoint='/'} / node_filesystem_size_bytes{mountpoint='/'} < 0.1",
        "duration": "5m",
        "severity": "critical",
        "summary": "Low disk space on {{$labels.instance}}",
        "description": "Less than 10% disk space remaining",
    },
    {
        "name": "CertificateExpiring",
        "expr": "certificate_expiry_days < 7",
        "duration": "1h",
        "severity": "warning",
        "summary": "TLS certificate expiring in {{$value}} days",
        "description": "Certificate {{$labels.name}} expires in {{$value}} days",
    },
    {
        "name": "HighDBConnections",
        "expr": "pg_stat_activity_count > 80",
        "duration": "5m",
        "severity": "warning",
        "summary": "High database connection count ({{$value}})",
        "description": "Database connections are above 80 for 5 minutes",
    },
    {
        "name": "QueueBacklog",
        "expr": "kafka_consumer_lag > 10000",
        "duration": "5m",
        "severity": "warning",
        "summary": "Kafka consumer lag ({{$value}} messages)",
        "description": "Consumer lag is above 10,000 messages for 5 minutes",
    },
    {
        "name": "GoroutineLeak",
        "expr": "go_goroutines > 10000",
        "duration": "15m",
        "severity": "warning",
        "summary": "High goroutine count ({{$value}})",
        "description": "Goroutine count is above 10,000 for 15 minutes",
    },
    {
        "name": "GCPauseTime",
        "expr": "go_gc_duration_seconds{quantile='0.99'} > 0.5",
        "duration": "10m",
        "severity": "warning",
        "summary": "High GC pause time ({{$value}}s)",
        "description": "P99 GC pause time is above 500ms for 10 minutes",
    },
    {
        "name": "RateLimitExceeded",
        "expr": "rate(http_requests_rate_limited_total[5m]) > 100",
        "duration": "5m",
        "severity": "warning",
        "summary": "High rate limit exceeded count ({{$value}}/s)",
        "description": "Rate limit exceeded {{$value}} times per second",
    },
]

RECOMMENDED_RECORDING_RULES: List[Dict[str, Any]] = [
    {"name": "job:http_requests_total:rate5m", "expr": "sum(rate(http_requests_total[5m])) by (job)"},
    {"name": "job:http_error_rate:rate5m", "expr": "sum(rate(http_errors_total[5m])) by (job) / sum(rate(http_requests_total[5m])) by (job)"},
    {"name": "job:http_latency_p99:rate5m", "expr": "histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, job))"},
    {"name": "instance:memory_usage:ratio", "expr": "process_resident_memory_bytes / machine_memory_bytes"},
    {"name": "instance:cpu_usage:ratio", "expr": "rate(process_cpu_seconds_total[5m])"},
    {"name": "service:uptime:days", "expr": "time() - process_start_time_seconds{job=~'.+'}"},
]


def http_request(method: str, url: str, data: Any = None,
                 headers: Optional[Dict[str, str]] = None) -> Any:
    if headers is None:
        headers = {}
    if data is not None and isinstance(data, (dict, list)):
        data = json.dumps(data).encode("utf-8")
        headers.setdefault("Content-Type", "application/json")

    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            content = resp.read()
            content_type = resp.headers.get("Content-Type", "")
            if "application/json" in content_type:
                return json.loads(content)
            return content.decode("utf-8")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} from {url}: {body[:200]}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"Connection error to {url}: {e.reason}", file=sys.stderr)
        return None


def check_prometheus(url: str) -> bool:
    result = http_request("GET", f"{url}/api/v1/status/buildinfo")
    if result and result.get("status") == "success":
        version = result.get("data", {}).get("version", "unknown")
        print(f"Prometheus {version} is healthy at {url}")
        return True
    print(f"Prometheus is NOT healthy at {url}")
    return False


def check_alertmanager(url: str) -> bool:
    result = http_request("GET", f"{url}/api/v2/status")
    if result:
        version = result.get("versionInfo", {}).get("version", "unknown")
        print(f"Alertmanager {version} is healthy at {url}")
        return True
    print(f"Alertmanager is NOT healthy at {url}")
    return False


def upload_prometheus_rules(rules: List[Dict[str, Any]],
                            prometheus_url: str,
                            dry_run: bool = False) -> bool:
    rules_file = "/etc/prometheus/rules/tent_rules.yml"
    print(f"{'Would upload' if dry_run else 'Uploading'} {len(rules)} rules to {prometheus_url}")

    yaml_content = ["groups:", "  - name: tent_alerts", "    interval: 30s", "    rules:"]
    for rule in rules:
        yaml_content.append(f"      - alert: {rule['name']}")
        yaml_content.append(f"        expr: {rule['expr']}")
        yaml_content.append(f"        for: {rule.get('duration', '5m')}")
        yaml_content.append(f"        labels:")
        yaml_content.append(f"          severity: {rule.get('severity', 'warning')}")
        yaml_content.append(f"        annotations:")
        yaml_content.append(f"          summary: \"{rule.get('summary', rule['name'])}\"")
        yaml_content.append(f"          description: \"{rule.get('description', '')}\"")

    if dry_run:
        print("\n".join(yaml_content))
        return True

    try:
        with open(rules_file, "w") as f:
            f.write("\n".join(yaml_content))
        print(f"Rules written to {rules_file}")
        return True
    except PermissionError:
        print(f"Permission denied writing to {rules_file}", file=sys.stderr)
        print("Try running with sudo or specify a different output path")
        return False


def upload_grafana_dashboard(dashboard_path: str,
                             grafana_url: str,
                             api_key: str,
                             dry_run: bool = False) -> bool:
    with open(dashboard_path) as f:
        dashboard = json.load(f)

    dashboard_name = dashboard.get("title", os.path.basename(dashboard_path))
    print(f"{'Would upload' if dry_run else 'Uploading'} dashboard '{dashboard_name}' to {grafana_url}")

    if dry_run:
        return True

    payload = {
        "dashboard": dashboard,
        "overwrite": True,
        "message": f"Updated by monitoring_setup.py at {datetime.now().isoformat()}",
    }

    result = http_request(
        "POST",
        f"{grafana_url}/api/dashboards/db",
        data=payload,
        headers={"Authorization": f"Bearer {api_key}"},
    )

    if result and result.get("status") == "success":
        print(f"Dashboard uploaded: {result.get('url', 'unknown')}")
        return True

    print(f"Failed to upload dashboard", file=sys.stderr)
    return False


def configure_alertmanager_notifications(alertmanager_url: str,
                                         slack_webhook: Optional[str] = None,
                                         pagerduty_key: Optional[str] = None,
                                         dry_run: bool = False) -> bool:
    receivers = []
    if slack_webhook:
        receivers.append({
            "name": "slack",
            "slack_configs": [{
                "api_url": slack_webhook,
                "channel": "#ops-alerts",
                "send_resolved": True,
                "title": "{{ .GroupLabels.alertname }}",
                "text": "{{ .CommonAnnotations.description }}",
            }],
        })

    if pagerduty_key:
        receivers.append({
            "name": "pagerduty",
            "pagerduty_configs": [{
                "routing_key": pagerduty_key,
                "severity": "{{ .CommonLabels.severity }}",
                "description": "{{ .CommonAnnotations.summary }}",
            }],
        })

    config = {
        "route": {
            "receiver": "default",
            "group_by": ["alertname", "severity"],
            "group_wait": "30s",
            "group_interval": "5m",
            "repeat_interval": "4h",
            "routes": [
                {
                    "match": {"severity": "critical"},
                    "receiver": "pagerduty",
                    "repeat_interval": "30m",
                },
            ],
        },
        "receivers": [
            {
                "name": "default",
                "slack_configs": [{
                    "api_url": slack_webhook or "",
                    "channel": "#ops-alerts",
                    "send_resolved": True,
                }] if slack_webhook else [],
            },
            *receivers,
        ],
    }

    if dry_run:
        print("Alertmanager configuration:")
        print(json.dumps(config, indent=2))
        return True

    result = http_request(
        "POST",
        f"{alertmanager_url}/api/v2/config",
        data=config,
    )

    if result is not None:
        print("Alertmanager configuration updated")
        return True

    print("Failed to update Alertmanager configuration", file=sys.stderr)
    return False


def backup_monitoring_config(output_dir: str, prometheus_url: str,
                              grafana_url: str, grafana_api_key: str) -> bool:
    os.makedirs(output_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Backup Prometheus rules (via API)
    print("Backing up Prometheus configuration...")
    rules_data = http_request("GET", f"{prometheus_url}/api/v1/rules")
    if rules_data:
        with open(os.path.join(output_dir, f"prometheus_rules_{timestamp}.json"), "w") as f:
            json.dump(rules_data, f, indent=2)
        print("  Prometheus rules backed up")

    # Backup Grafana dashboards
    dashboards = http_request("GET", f"{grafana_url}/api/search?type=dash-db",
                               headers={"Authorization": f"Bearer {grafana_api_key}"})
    if dashboards:
        dashboards_dir = os.path.join(output_dir, f"grafana_dashboards_{timestamp}")
        os.makedirs(dashboards_dir, exist_ok=True)

        for db in dashboards:
            uid = db.get("uid")
            if uid:
                dashboard = http_request("GET", f"{grafana_url}/api/dashboards/uid/{uid}",
                                          headers={"Authorization": f"Bearer {grafana_api_key}"})
                if dashboard:
                    with open(os.path.join(dashboards_dir, f"{db['title']}.json"), "w") as f:
                        json.dump(dashboard.get("dashboard", dashboard), f, indent=2)

        print(f"  {len(dashboards)} Grafana dashboards backed up to {dashboards_dir}")

    print(f"Backup completed: {output_dir}")
    return True


def parse_args():
    parser = argparse.ArgumentParser(description="Monitoring setup tool")
    parser.add_argument("--prometheus-url", default=DEFAULT_PROMETHEUS_URL)
    parser.add_argument("--alertmanager-url", default=DEFAULT_ALERTMANAGER_URL)
    parser.add_argument("--grafana-url", default=DEFAULT_GRAFANA_URL)
    parser.add_argument("--grafana-api-key", default=os.environ.get("GRAFANA_API_KEY", ""))
    parser.add_argument("--slack-webhook", default=os.environ.get("SLACK_WEBHOOK", ""))
    parser.add_argument("--pagerduty-key", default=os.environ.get("PAGERDUTY_KEY", ""))
    parser.add_argument("--dry-run", action="store_true", help="Show what would be done")
    parser.add_argument("--init", action="store_true", help="Initialize monitoring setup")
    parser.add_argument("--check", action="store_true", help="Check monitoring health")
    parser.add_argument("--alerts", action="store_true", help="Upload alert rules")
    parser.add_argument("--dashboards", action="store_true", help="Upload Grafana dashboards")
    parser.add_argument("--backup", action="store_true", help="Backup monitoring config")
    parser.add_argument("--output-dir", default="./monitoring_backup", help="Backup output directory")
    parser.add_argument("--validate", action="store_true", help="Validate monitoring configuration")
    parser.add_argument("--env", default="development", help="Target environment")
    return parser.parse_args()


def main():
    args = parse_args()

    if args.check:
        print("Checking monitoring infrastructure...")
        prom_ok = check_prometheus(args.prometheus_url)
        am_ok = check_alertmanager(args.alertmanager_url)
        return 0 if (prom_ok and am_ok) else 1

    if args.init:
        print("Initializing monitoring setup for environment: {args.env}")
        if not check_prometheus(args.prometheus_url):
            print("Prometheus is not reachable. Aborting.")
            return 1
        if not check_alertmanager(args.alertmanager_url):
            print("Alertmanager is not reachable. Continuing without alert config.")

        if args.slack_webhook or args.pagerduty_key:
            configure_alertmanager_notifications(
                args.alertmanager_url, args.slack_webhook,
                args.pagerduty_key, args.dry_run)

        upload_prometheus_rules(RECOMMENDED_ALERT_RULES, args.prometheus_url, args.dry_run)
        print("Monitoring initialization complete")
        return 0

    if args.alerts:
        upload_prometheus_rules(RECOMMENDED_ALERT_RULES, args.prometheus_url, args.dry_run)
        return 0

    if args.backup:
        return 0 if backup_monitoring_config(
            args.output_dir, args.prometheus_url,
            args.grafana_url, args.grafana_api_key) else 1

    if args.validate:
        print("Validating monitoring configuration...")
        
        all_ok = True
        for rule in RECOMMENDED_ALERT_RULES:
            expr = rule.get("expr", "")
            if " / " in expr:
                parts = [p.strip() for p in expr.split(">", 1)[0].split("<", 1)[0].split("==", 1)[0].split(" / ")]
                if len(parts) == 2 and parts[0] == parts[1]:
                    print(f"  VALIDATION FAILED: Rule '{rule['name']}' contains a self-dividing expression: {expr}")
                    all_ok = False
                    
        configs_to_check = [
            args.prometheus_url,
            args.alertmanager_url,
        ]
        all_ok = True
        for url in configs_to_check:
            result = http_request("GET", f"{url}/-/healthy")
            if result:
                print(f"  {url}: OK")
            else:
                print(f"  {url}: FAILED")
                all_ok = False
        return 0 if all_ok else 1

    parser.print_help()
    return 0


if __name__ == "__main__":
    main()
