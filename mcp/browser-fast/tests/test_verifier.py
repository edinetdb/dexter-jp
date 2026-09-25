from __future__ import annotations

from browser_fast.schemas import BrowserObservation, BrowserTaskRequest
from browser_fast.verifier import verify


def observation() -> BrowserObservation:
    return BrowserObservation(
        url="https://en.wikipedia.org/wiki/G%C3%B6del%27s_incompleteness_theorems",
        title="Gödel's incompleteness theorems",
        visible_text="Gödel's incompleteness theorems are two results in mathematical logic.",
    )


def request(**kwargs: object) -> BrowserTaskRequest:
    return BrowserTaskRequest(url="https://en.wikipedia.org/", goal="Read an article", **kwargs)


def test_expected_text_all_passes() -> None:
    checked = verify(request(expected_text_all=["Gödel's", "mathematical logic"]), observation())
    assert checked.passed


def test_expected_text_all_fails() -> None:
    checked = verify(request(expected_text_all=["Gödel's", "not present"]), observation())
    assert not checked.passed


def test_expected_text_any_passes_when_one_alternative_is_visible() -> None:
    checked = verify(request(expected_text_any=["not present", "two results"]), observation())
    assert checked.passed


def test_url_regex_passes() -> None:
    checked = verify(request(expected_url_regex=r"wikipedia\.org/wiki/.*incompleteness"), observation())
    assert checked.passed


def test_done_without_criteria_is_unverified() -> None:
    checked = verify(request(), observation())
    assert not checked.has_criteria
    assert not checked.passed


def test_done_with_failed_criteria_is_unverified() -> None:
    checked = verify(request(expected_text_all=["wrong article"]), observation())
    assert checked.has_criteria
    assert not checked.passed
