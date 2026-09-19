from __future__ import annotations

import pytest

from browser_fast.policy import evaluate_action
from browser_fast.schemas import PredictedAction


def action(label: str, *, kind: str = "click", role: str = "button", context: str = "") -> PredictedAction:
    return PredictedAction(
        selected_id="e1",
        operation={"click": "CLICK", "fill": "TYPE_TEXT", "select": "SELECT"}.get(kind, kind.upper()),
        kind=kind,
        label=label,
        role=role,
        field_type=role,
        nearby_context=context,
        current_url="https://en.wikipedia.org/wiki/Main_Page",
        target_url=None,
        confidence=0.9,
    )


@pytest.mark.parametrize(
    ("label", "kind", "role"),
    [
        ("Wikipedia search", "fill", "searchbox"),
        ("Category filter", "select", "combobox"),
        ("Next page", "click", "link"),
        ("Article navigation", "click", "link"),
    ],
)
def test_safe_read_only_actions_pass(label: str, kind: str, role: str) -> None:
    assert evaluate_action(action(label, kind=kind, role=role), "Find an encyclopedia article").allowed


@pytest.mark.parametrize(
    "label",
    [
        "Buy",
        "Sell",
        "Place order",
        "Transfer",
        "Delete",
        "Publish",
        "Send",
        "パスワード変更",
        "注文を確定",
        "購入する",
        "送金",
        "投稿",
        "削除",
    ],
)
def test_dangerous_actions_are_blocked(label: str) -> None:
    decision = evaluate_action(action(label), "Inspect this page")
    assert not decision.allowed
    assert decision.code in {"POLICY_BLOCKED", "SENSITIVE_FIELD"}


@pytest.mark.parametrize("label", ["Password", "OTP", "API token", "クレジットカード", "認証コード"])
def test_sensitive_fields_are_unconditionally_blocked(label: str) -> None:
    decision = evaluate_action(action(label, kind="fill", role="textbox"), "Enter a value")
    assert not decision.allowed
    assert decision.code == "SENSITIVE_FIELD"


def test_high_risk_nearby_context_blocks_an_ambiguous_button() -> None:
    decision = evaluate_action(action("Continue", context="Review your payment and confirm order"), "Continue")
    assert not decision.allowed
