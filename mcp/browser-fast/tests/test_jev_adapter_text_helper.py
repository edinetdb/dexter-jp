from __future__ import annotations

import json
from typing import Any

import pytest

from browser_fast.jev_adapter import _install_strict_text_helper, _strict_field_text


def _configure_openrouter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test-key")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://openrouter.ai/api/v1")
    monkeypatch.setenv("TEXT_MODEL", "inception/mercury-2.5")
    monkeypatch.setenv("TEXT_MODEL_REASONING", "none")


def _result(content: Any) -> dict[str, Any]:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"completion_tokens": 1},
    }


def test_openrouter_request_uses_strict_json_schema(monkeypatch: pytest.MonkeyPatch) -> None:
    from jev_ultrafast import model as jev_model
    from jev_ultrafast.questions import TEXT_VALUE

    _configure_openrouter(monkeypatch)
    captured: dict[str, Any] = {}

    def fake_post_json(url: str, key: str, body: dict[str, Any]) -> dict[str, Any]:
        captured.update(url=url, key=key, body=body)
        return _result('{"text":"Godel incompleteness theorem"}')

    monkeypatch.setattr(jev_model, "post_json", fake_post_json)
    context = {"goal": "Search", "field": {"label": "Search"}}

    value, metadata = _strict_field_text(context)

    assert value == "Godel incompleteness theorem"
    assert captured["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert captured["key"] == "test-key"
    body = captured["body"]
    assert body["model"] == "inception/mercury-2.5"
    assert body["max_tokens"] == 1024
    assert body["reasoning"] == {"enabled": False}
    assert body["provider"] == {"require_parameters": True}
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {
            "name": "browser_fast_text_value",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {"text": {"type": "string"}},
                "required": ["text"],
                "additionalProperties": False,
            },
        },
    }
    assert body["messages"][0] == {"role": "system", "content": TEXT_VALUE}
    assert json.loads(body["messages"][1]["content"]) == context
    assert metadata["model"] == "inception/mercury-2.5"
    assert metadata["usage"] == {"completion_tokens": 1}


def test_require_parameters_is_openrouter_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from jev_ultrafast import model as jev_model

    monkeypatch.setenv("TEXT_MODEL_API_KEY", "test-key")
    monkeypatch.setenv("TEXT_MODEL_BASE_URL", "https://api.deepseek.com/v1")
    monkeypatch.setenv("TEXT_MODEL", "deepseek-chat")
    monkeypatch.delenv("TEXT_MODEL_REASONING", raising=False)
    captured: dict[str, Any] = {}

    def fake_post_json(_url: str, _key: str, body: dict[str, Any]) -> dict[str, Any]:
        captured.update(body)
        return _result('{"text":"safe value"}')

    monkeypatch.setattr(jev_model, "post_json", fake_post_json)

    _strict_field_text({"goal": "Fill the field"})

    assert "provider" not in captured
    assert captured["thinking"] == {"type": "disabled"}


@pytest.mark.parametrize(
    "response,code",
    [
        (None, "CHOICES_MISSING"),
        ({}, "CHOICES_MISSING"),
        ({"choices": []}, "CHOICES_EMPTY"),
        ({"choices": None}, "MESSAGE_INVALID"),
        ({"choices": {}}, "MESSAGE_INVALID"),
        ({"choices": [None]}, "MESSAGE_INVALID"),
        ({"choices": [{}]}, "MESSAGE_INVALID"),
        ({"choices": [{"message": []}]}, "MESSAGE_INVALID"),
        ({"choices": [{"message": {}}]}, "CONTENT_MISSING"),
        (_result(None), "CONTENT_NULL"),
        (_result([]), "CONTENT_TYPE_INVALID"),
        (_result({}), "CONTENT_TYPE_INVALID"),
        (_result(123), "CONTENT_TYPE_INVALID"),
        (_result(""), "CONTENT_EMPTY"),
        (_result(" \n\t"), "CONTENT_EMPTY"),
        (_result("not json"), "JSON_PARSE_ERROR"),
        (_result("[]"), "JSON_NOT_OBJECT"),
        (_result("null"), "JSON_NOT_OBJECT"),
        (_result('"string"'), "JSON_NOT_OBJECT"),
        (_result("{}"), "TEXT_MISSING"),
        (_result('{"extra":true}'), "TEXT_MISSING"),
        (_result('{"text":1}'), "TEXT_TYPE_INVALID"),
        (_result('{"text":null}'), "TEXT_TYPE_INVALID"),
        (_result('{"text":""}'), "TEXT_EMPTY"),
        (_result('{"text":"   "}'), "TEXT_WHITESPACE_ONLY"),
        (_result(json.dumps({"text": " " * 2001})), "TEXT_WHITESPACE_ONLY"),
        (_result('{"text":"valid","extra":true}'), "EXTRA_KEYS"),
        (_result('{"text":null,"extra":true}'), "EXTRA_KEYS"),
        (_result(json.dumps({"text": "x" * 2001})), "TEXT_TOO_LONG"),
    ],
)
def test_invalid_outputs_fail_closed(monkeypatch: pytest.MonkeyPatch, response: Any, code: str) -> None:
    from jev_ultrafast import model as jev_model

    from browser_fast.executor import _classify_exception

    _configure_openrouter(monkeypatch)
    calls = []

    def fake_post_json(_url: str, _key: str, _body: dict[str, Any]) -> Any:
        calls.append(1)
        return response

    monkeypatch.setattr(jev_model, "post_json", fake_post_json)

    with pytest.raises(ValueError) as caught:
        _strict_field_text({"goal": "Fill the field"})
    assert str(caught.value) == f"Text helper invalid output: {code}"
    assert _classify_exception(caught.value) == "MODEL_ERROR"
    assert calls == [1]


@pytest.mark.parametrize("reason", ["stop", "length", "content_filter", "tool_calls", "function_call", "error"])
def test_safe_finish_reason_is_independent_of_failure_code(monkeypatch: pytest.MonkeyPatch, reason: str) -> None:
    from jev_ultrafast import model as jev_model

    _configure_openrouter(monkeypatch)
    response = _result("invalid JSON synthetic-private-content")
    response["choices"][0]["finish_reason"] = reason
    monkeypatch.setattr(jev_model, "post_json", lambda *_args: response)
    with pytest.raises(ValueError) as caught:
        _strict_field_text({"goal": "synthetic-private-prompt"})
    assert str(caught.value) == f"Text helper invalid output: JSON_PARSE_ERROR; finish_reason={reason}"


@pytest.mark.parametrize("reason", [None, [], {}, 1, "unknown", "length\nsynthetic-private-value"])
def test_unsafe_metadata_and_raw_output_are_not_logged(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], caplog: pytest.LogCaptureFixture, reason: Any
) -> None:
    import traceback

    from jev_ultrafast import model as jev_model

    _configure_openrouter(monkeypatch)
    response = _result('{"text":"synthetic-private-input","synthetic-private-key":true}')
    response["choices"][0]["finish_reason"] = reason
    response["model"] = "synthetic-private-model"
    monkeypatch.setattr(jev_model, "post_json", lambda *_args: response)
    context = {"goal": "synthetic-private-prompt"}
    with pytest.raises(ValueError) as caught:
        _strict_field_text(context)
    assert str(caught.value) == "Text helper invalid output: EXTRA_KEYS"
    formatted = "".join(traceback.format_exception(caught.value))
    assert "synthetic-private" not in formatted
    captured = capsys.readouterr()
    assert captured.out == captured.err == caplog.text == ""


@pytest.mark.parametrize("value", [" valid ", "x" * 2000])
def test_valid_output_is_preserved_even_with_length_finish_reason(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    from jev_ultrafast import model as jev_model

    _configure_openrouter(monkeypatch)
    response = _result(json.dumps({"text": value}))
    response["choices"][0]["finish_reason"] = "length"
    monkeypatch.setattr(jev_model, "post_json", lambda *_args: response)
    actual, _metadata = _strict_field_text({"goal": "Fill the field"})
    assert actual == value


def test_missing_api_key_fails_before_request(monkeypatch: pytest.MonkeyPatch) -> None:
    from jev_ultrafast import model as jev_model

    monkeypatch.delenv("TEXT_MODEL_API_KEY", raising=False)
    called = False

    def fake_post_json(_url: str, _key: str, _body: dict[str, Any]) -> dict[str, Any]:
        nonlocal called
        called = True
        return _result('{"text":"unused"}')

    monkeypatch.setattr(jev_model, "post_json", fake_post_json)

    with pytest.raises(ValueError, match="TEXT_MODEL_API_KEY"):
        _strict_field_text({"goal": "Fill the field"})
    assert not called


def test_installer_patches_agent_reference_only(monkeypatch: pytest.MonkeyPatch) -> None:
    from jev_ultrafast import agent as jev_agent
    from jev_ultrafast import model as jev_model

    original_model_field_text = jev_model.field_text
    original_choose = jev_model.choose
    monkeypatch.setattr(jev_agent, "field_text", original_model_field_text)

    _install_strict_text_helper()

    assert jev_agent.field_text is _strict_field_text
    assert jev_model.field_text is original_model_field_text
    assert jev_model.choose is original_choose
