from __future__ import annotations

from browser_fast.redaction import REDACTED, redact


def test_trace_redaction_covers_secret_classes() -> None:
    value = {
        "authorization": "Bearer should-never-survive",
        "text": "email person@example.com card 4111 1111 1111 1111 otp 123456",
        "url": "https://example.com/?token=private-value",
    }
    cleaned = redact(value)
    assert cleaned["authorization"] == REDACTED
    assert "person@example.com" not in cleaned["text"]
    assert "4111" not in cleaned["text"]
    assert "123456" not in cleaned["text"]
    assert "private-value" not in cleaned["url"]
