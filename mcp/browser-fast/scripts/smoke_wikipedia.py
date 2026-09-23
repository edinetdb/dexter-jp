"""Paid live gate: run the independently verified Wikipedia task three times."""

from __future__ import annotations

import os

from browser_fast import load_local_environment
from browser_fast.executor import BrowserExecutor
from browser_fast.schemas import BrowserTaskRequest


def main() -> int:
    load_local_environment()
    required = ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY")
    if any(not os.environ.get(name) for name in required):
        print("LIVE_GATE = BLOCKED_MISSING_CREDENTIALS")
        return 2

    executor = BrowserExecutor()
    verified = 0
    for attempt in range(1, 4):
        result = executor.run(
            BrowserTaskRequest(
                url="https://en.wikipedia.org/wiki/Main_Page",
                goal=(
                    "Search for and open the Wikipedia article about Gödel's incompleteness theorems. "
                    "Stop only when that article is visibly open."
                ),
                expected_text_all=["Gödel's incompleteness theorems"],
                expected_url_regex=r"wikipedia\.org/wiki/(?:G%C3%B6del|Gödel).*incompleteness",
                max_steps=20,
            )
        )
        verified += int(result.status == "success" and result.verified)
        print(f"run {attempt}: {result.status} verified={result.verified} trace_id={result.trace_id}")

    print(f"LIVE_GATE = {verified} / 3 verified")
    return 0 if verified == 3 else 1


if __name__ == "__main__":
    raise SystemExit(main())
