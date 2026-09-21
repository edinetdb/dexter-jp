"""Fail-closed action policy independent from Jev internals."""

from __future__ import annotations

import re
import unicodedata

from .schemas import PolicyDecision, PredictedAction

_DANGEROUS_ENGLISH = (
    "buy",
    "sell",
    "place order",
    "confirm order",
    "checkout",
    "purchase",
    "subscribe",
    "transfer",
    "withdraw",
    "deposit",
    "bank operation",
    "payment",
    "pay now",
    "send message",
    "send email",
    "send",
    "publish",
    "post",
    "comment",
    "post comment",
    "upload",
    "delete",
    "cancel account",
    "close account",
    "change account",
    "change password",
    "log in",
    "login",
    "sign in",
    "log out",
    "logout",
    "one-time password",
    "security code",
    "api key",
    "credit card",
    "brokerage order",
    "accept terms",
    "submit application",
    "apply now",
)
_DANGEROUS_JAPANESE = (
    "買う",
    "売る",
    "注文",
    "発注",
    "約定",
    "購入",
    "支払",
    "振込",
    "送金",
    "出金",
    "入金",
    "投稿",
    "送信",
    "確定",
    "削除",
    "解約",
    "パスワード",
    "認証コード",
    "ログイン",
    "ログアウト",
    "申し込",
    "申請",
    "規約に同意",
)
_SENSITIVE = (
    "password",
    "passcode",
    "otp",
    "mfa",
    "2fa",
    "security code",
    "verification code",
    "credit card",
    "card number",
    "bank account",
    "routing number",
    "api token",
    "api key",
    "secret",
    "recovery code",
    "social security",
    "email address",
    "phone number",
    "パスワード",
    "認証コード",
    "暗証番号",
    "クレジットカード",
    "口座番号",
    "秘密鍵",
    "復旧コード",
    "メールアドレス",
    "電話番号",
)
_HIGH_RISK_URL_PARTS = (
    "/checkout",
    "/payment",
    "/order",
    "/orders",
    "/login",
    "/signin",
    "/account/security",
    "/transfer",
    "/withdraw",
    "/deposit",
)
_ALLOWED_KINDS = {"click", "fill", "select", "scroll", "wait", "terminal"}
_ALLOWED_CLICK_ROLES = {
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "option",
    "gridcell",
    "combobox",
    "textbox",
    "searchbox",
    "spinbutton",
}
_ALLOWED_FILL_ROLES = {"combobox", "textbox", "searchbox", "spinbutton"}


def _normalize(value: str | None) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value or "").casefold()).strip()


def _contains_phrase(text: str, phrase: str) -> bool:
    if phrase.isascii() and phrase.replace("-", " ").replace(" ", "").isalnum():
        return re.search(rf"(?<![\w]){re.escape(phrase)}(?![\w])", text) is not None
    return phrase in text


def _first_match(text: str, phrases: tuple[str, ...]) -> str | None:
    for phrase in phrases:
        if _contains_phrase(text, _normalize(phrase)):
            return phrase
    return None


def evaluate_action(action: PredictedAction, goal: str) -> PolicyDecision:
    """Allow only low-risk navigation/query actions; ambiguity fails closed."""

    if action.kind not in _ALLOWED_KINDS:
        return PolicyDecision(False, "POLICY_BLOCKED", f"Unsupported action kind: {action.kind}")

    combined = _normalize(
        " ".join(
            value
            for value in (
                action.label,
                action.role,
                action.field_type,
                action.nearby_context,
                action.current_url,
                goal,
            )
            if value
        )
    )
    sensitive = _first_match(combined, _SENSITIVE)
    if sensitive:
        return PolicyDecision(False, "SENSITIVE_FIELD", f"Sensitive input or context detected: {sensitive}")

    dangerous = _first_match(combined, _DANGEROUS_ENGLISH) or _first_match(combined, _DANGEROUS_JAPANESE)
    if dangerous:
        return PolicyDecision(False, "POLICY_BLOCKED", f"Potential durable external mutation detected: {dangerous}")

    normalized_url = _normalize(action.current_url)
    if any(part in normalized_url for part in _HIGH_RISK_URL_PARTS):
        return PolicyDecision(
            False,
            "AUTH_FLOW_UNSUPPORTED",
            "Actions on authentication or transaction pages are blocked.",
        )
    if action.terminal is not None or action.kind in {"scroll", "wait"}:
        return PolicyDecision(True)

    role = _normalize(action.role)
    if action.kind == "fill":
        if role not in _ALLOWED_FILL_ROLES:
            return PolicyDecision(False, "POLICY_BLOCKED", "Text may only be entered into query/filter controls.")
        return PolicyDecision(True)
    if action.kind == "select":
        if role != "combobox":
            return PolicyDecision(False, "POLICY_BLOCKED", "Only observed native dropdown options are supported.")
        return PolicyDecision(True)
    if action.kind == "click":
        if role not in _ALLOWED_CLICK_ROLES:
            return PolicyDecision(False, "POLICY_BLOCKED", "The selected control role is not read-only-safe.")
        if _normalize(action.label) in {"submit", "confirm", "確定"}:
            return PolicyDecision(False, "POLICY_BLOCKED", "Ambiguous submit/confirm actions fail closed.")
        return PolicyDecision(True)
    return PolicyDecision(False, "POLICY_BLOCKED", "The action could not be classified safely.")
