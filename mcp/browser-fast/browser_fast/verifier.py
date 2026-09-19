"""Deterministic verification independent from Jev's DONE decision."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from .schemas import BrowserObservation, BrowserTaskRequest, VerificationResult


@dataclass(frozen=True, slots=True)
class VerificationSummary:
    has_criteria: bool
    passed: bool
    results: list[VerificationResult]


def _normalized(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def verify(request: BrowserTaskRequest, observation: BrowserObservation) -> VerificationSummary:
    """Check every requested criterion against one fresh observation."""

    results: list[VerificationResult] = []
    content = _normalized("\n".join((observation.title, observation.visible_text)))

    for expected in request.expected_text_all:
        passed = _normalized(expected) in content
        results.append(
            VerificationResult(
                criterion="expected_text_all",
                expected=expected,
                passed=passed,
                evidence="visible text contains the required value" if passed else "required value is absent",
            )
        )

    if request.expected_text_any:
        for expected in request.expected_text_any:
            passed = _normalized(expected) in content
            results.append(
                VerificationResult(
                    criterion="expected_text_any",
                    expected=expected,
                    passed=passed,
                    evidence="visible text contains this alternative" if passed else "alternative is absent",
                )
            )

    if request.expected_url_regex is not None:
        passed = re.search(request.expected_url_regex, observation.url) is not None
        results.append(
            VerificationResult(
                criterion="expected_url_regex",
                expected=request.expected_url_regex,
                passed=passed,
                evidence=observation.url,
            )
        )

    has_criteria = bool(results)
    all_required = all(result.passed for result in results if result.criterion != "expected_text_any")
    any_results = [result.passed for result in results if result.criterion == "expected_text_any"]
    any_required = not request.expected_text_any or any(any_results)
    return VerificationSummary(
        has_criteria=has_criteria,
        passed=has_criteria and all_required and any_required,
        results=results,
    )
