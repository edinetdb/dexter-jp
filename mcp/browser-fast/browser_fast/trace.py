"""Small, screenshot-free JSON traces owned by browser-fast."""

from __future__ import annotations

import json
import os
import secrets
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import PACKAGE_ROOT, UPSTREAM_SHA
from .redaction import redact


def utc_now() -> datetime:
    return datetime.now(UTC)


def create_trace_id(now: datetime | None = None) -> str:
    instant = now or utc_now()
    return f"bf-{instant.strftime('%Y%m%dT%H%M%S')}-{secrets.token_hex(4)}"


class TraceWriter:
    def __init__(self, trace_id: str, root: Path | None = None) -> None:
        configured = os.environ.get("BROWSER_FAST_TRACE_DIR")
        self.directory = (root or (Path(configured) if configured else PACKAGE_ROOT / "traces")) / trace_id
        self.directory.mkdir(parents=True, exist_ok=False)
        self.actions_path = self.directory / "actions.jsonl"
        self.actions_path.touch()

    @staticmethod
    def _json(value: Any) -> str:
        return json.dumps(redact(value), ensure_ascii=False, indent=2, sort_keys=True) + "\n"

    def _write_json(self, filename: str, value: Any) -> None:
        destination = self.directory / filename
        temporary = destination.with_suffix(destination.suffix + ".tmp")
        temporary.write_text(self._json(value), encoding="utf-8", newline="\n")
        temporary.replace(destination)

    def write_start(self, *, start_timestamp: datetime, start_url: str, goal: str) -> None:
        self._write_json(
            "run.json",
            {
                "trace_id": self.directory.name,
                "start_timestamp": start_timestamp.isoformat(),
                "start_url": start_url,
                "goal": goal,
                "status": "running",
                "screenshots": False,
                "upstream_sha": UPSTREAM_SHA,
            },
        )
        self._write_json("verification.json", {"verified": False, "criteria": []})

    def append_action(self, action: dict[str, Any]) -> None:
        line = json.dumps(redact(action), ensure_ascii=False, sort_keys=True)
        with self.actions_path.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(line + "\n")

    def finalize(
        self,
        *,
        start_timestamp: datetime,
        end_timestamp: datetime,
        result: dict[str, Any],
        model_calls: int,
    ) -> None:
        run = {
            "trace_id": self.directory.name,
            "start_timestamp": start_timestamp.isoformat(),
            "end_timestamp": end_timestamp.isoformat(),
            "start_url": result["start_url"],
            "final_url": result.get("final_url"),
            "goal": result["goal"],
            "status": result["status"],
            "verified": result["verified"],
            "elapsed_ms": result["elapsed_ms"],
            "step_count": result["steps"],
            "model_calls": model_calls,
            "error_code": result.get("error_code"),
            "error_message": result.get("error_message"),
            "screenshots": False,
            "upstream_sha": UPSTREAM_SHA,
        }
        self._write_json("run.json", run)
        self._write_json(
            "verification.json",
            {"verified": result["verified"], "criteria": result.get("verification", [])},
        )
