from __future__ import annotations

import pytest
from pydantic import ValidationError

from browser_fast.schemas import BrowserTaskRequest, BrowserTaskResult


def test_request_defaults_and_budget() -> None:
    request = BrowserTaskRequest(url="https://example.com", goal="Read")
    assert request.max_steps == 20
    assert request.expected_text_all == []
    with pytest.raises(ValidationError):
        BrowserTaskRequest(url="https://example.com", goal="Read", max_steps=41)


def test_invalid_regex_is_rejected() -> None:
    with pytest.raises(ValidationError):
        BrowserTaskRequest(url="https://example.com", goal="Read", expected_url_regex="[")


def test_result_schema_contains_required_contract_fields() -> None:
    required = BrowserTaskResult.model_json_schema()["required"]
    assert {
        "status",
        "verified",
        "goal",
        "start_url",
        "final_url",
        "elapsed_ms",
        "steps",
        "trace_id",
        "verification",
        "actions",
    }.issubset(required)
