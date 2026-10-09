"""Check browser-fast runtime dependencies without printing secret values."""

from __future__ import annotations

import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from browser_fast import UPSTREAM_SHA, load_local_environment


@dataclass(frozen=True)
class Check:
    name: str
    passed: bool
    detail: str


def check_python() -> Check:
    passed = sys.version_info >= (3, 12)
    return Check("Python >= 3.12", passed, sys.version.split()[0])


def check_credentials() -> Check:
    names = ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY")
    missing = [name for name in names if not os.environ.get(name)]
    return Check("API credentials", not missing, "present" if not missing else "missing: " + ", ".join(missing))


def check_jev() -> Check:
    try:
        import jev_ultrafast  # noqa: F401

        distribution = importlib.metadata.distribution("jev-ultrafast")
        direct_entry = next(entry for entry in distribution.files or [] if entry.name == "direct_url.json")
        direct_path = Path(distribution.locate_file(direct_entry))
        direct = json.loads(direct_path.read_text(encoding="utf-8"))
        installed_sha = direct.get("vcs_info", {}).get("commit_id")
        passed = installed_sha == UPSTREAM_SHA
        detail = f"{distribution.version}; commit={installed_sha or 'unknown'}"
        return Check("Jev exact upstream commit", passed, detail)
    except Exception as exc:
        return Check("Jev exact upstream commit", False, exc.__class__.__name__)


def check_mcp() -> Check:
    try:
        from mcp.server.mcpserver import MCPServer  # noqa: F401

        version = importlib.metadata.version("mcp")
        return Check("MCP SDK v2", version.split(".", 1)[0] == "2", version)
    except Exception as exc:
        return Check("MCP SDK v2", False, exc.__class__.__name__)


def check_browser_harness() -> Check:
    try:
        import browser_harness  # noqa: F401

        version = importlib.metadata.version("browser-harness")
        return Check("Browser Harness", True, version)
    except Exception as exc:
        return Check("Browser Harness", False, exc.__class__.__name__)


def check_chrome() -> Check:
    executable = shutil.which("browser-harness")
    if not executable:
        return Check("Chrome remote debugging", False, "browser-harness executable not found")
    try:
        completed = subprocess.run(
            [executable, "doctor", "--json", "--require-existing-daemon"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return Check("Chrome remote debugging", False, exc.__class__.__name__)
    try:
        report = json.loads(completed.stdout)
        ready = bool(report["daemon"]["browser_ready"])
    except (json.JSONDecodeError, KeyError, TypeError):
        return Check("Chrome remote debugging", False, "invalid doctor response")
    return Check(
        "Chrome remote debugging",
        completed.returncode == 0 and ready,
        "connected" if ready else "not connected",
    )


def main() -> int:
    load_local_environment()
    checks = [
        check_python(),
        check_credentials(),
        check_jev(),
        check_mcp(),
        check_browser_harness(),
        check_chrome(),
    ]
    for check in checks:
        print(f"{'PASS' if check.passed else 'FAIL'}  {check.name}: {check.detail}")
    return 0 if all(check.passed for check in checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
