"""Last-mile trace redaction. Browser credentials and storage are never collected."""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

REDACTED = "[REDACTED]"
_SENSITIVE_KEY = re.compile(
    r"(?:authorization|cookie|password|passcode|secret|api[_-]?key|api[_-]?token|access[_-]?token|"
    r"refresh[_-]?token|session[_-]?(?:id|token)|otp|mfa|credit[_-]?card|card[_-]?number|recovery[_-]?code)",
    re.IGNORECASE,
)
_PATTERNS = (
    re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]{8,}"),
    re.compile(r"(?i)\b(?:sk|pk|edb|xox[baprs]|gh[pousr])[-_][a-z0-9_-]{8,}"),
    re.compile(r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b"),
    re.compile(r"\b(?:\d[ -]*?){13,19}\b"),
    re.compile(r"(?i)\b(?:cookie|set-cookie|session|token)\s*[:=]\s*[^\s;,]{6,}"),
    re.compile(r"\b\d{6}\b"),
    re.compile(r"(?i)([?&](?:token|key|secret|password|code|session|auth)=)[^&#\s]+"),
)


def redact_text(value: str) -> str:
    redacted = value
    for pattern in _PATTERNS:
        if pattern.pattern.startswith("(?i)([?&]"):
            redacted = pattern.sub(r"\1[REDACTED]", redacted)
        else:
            redacted = pattern.sub(REDACTED, redacted)
    return redacted


def redact(value: Any, *, key: str | None = None) -> Any:
    """Recursively redact a JSON-compatible value immediately before persistence."""

    if key and _SENSITIVE_KEY.search(key):
        return REDACTED
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return {str(item_key): redact(item_value, key=str(item_key)) for item_key, item_value in value.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [redact(item) for item in value]
    return value
