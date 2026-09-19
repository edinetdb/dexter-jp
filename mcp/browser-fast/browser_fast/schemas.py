"""Public and internal typed contracts for browser-fast."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

BrowserStatus = Literal[
    "success",
    "unverified_done",
    "blocked",
    "policy_blocked",
    "max_steps",
    "error",
]


class BrowserTaskRequest(BaseModel):
    """One bounded, read-only browser task."""

    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=4096)
    goal: str = Field(min_length=1, max_length=20_000)
    expected_text_all: list[str] = Field(default_factory=list, max_length=100)
    expected_text_any: list[str] = Field(default_factory=list, max_length=100)
    expected_url_regex: str | None = Field(default=None, max_length=2000)
    max_steps: int = Field(default=20, ge=1, le=40)

    @field_validator("url", "goal")
    @classmethod
    def non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("must not be blank")
        return value

    @field_validator("expected_text_all", "expected_text_any")
    @classmethod
    def clean_expected_text(cls, values: list[str]) -> list[str]:
        cleaned = [value.strip() for value in values]
        if any(not value for value in cleaned):
            raise ValueError("verification text must not be blank")
        return cleaned

    @field_validator("expected_url_regex")
    @classmethod
    def valid_regex(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"invalid URL regex: {exc}") from exc
        return value


class VerificationResult(BaseModel):
    criterion: Literal["expected_text_all", "expected_text_any", "expected_url_regex"]
    expected: str
    passed: bool
    evidence: str | None = None


class BrowserActionSummary(BaseModel):
    step: int = Field(ge=1)
    operation: str
    kind: str
    label: str
    role: str | None = None
    url: str | None = None
    page_changed: bool | None = None
    confidence: float | None = None
    action_result: Literal["executed", "uncertain", "blocked", "terminal"]


class BrowserTaskResult(BaseModel):
    status: BrowserStatus
    verified: bool
    goal: str
    start_url: str
    final_url: str | None
    elapsed_ms: int = Field(ge=0)
    steps: int = Field(ge=0)
    trace_id: str
    verification: list[VerificationResult]
    actions: list[BrowserActionSummary]
    error_code: str | None = None
    error_message: str | None = None


@dataclass(slots=True)
class BrowserObservation:
    url: str
    title: str = ""
    visible_text: str = ""
    fingerprint: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(slots=True)
class PredictedAction:
    selected_id: str
    operation: str
    kind: str
    label: str
    role: str | None
    field_type: str | None
    nearby_context: str
    current_url: str
    target_url: str | None
    confidence: float | None
    terminal: Literal["done", "blocked"] | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    allowed: bool
    code: str | None = None
    reason: str | None = None
