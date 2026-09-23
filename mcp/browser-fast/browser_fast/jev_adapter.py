"""The only module allowed to depend on Jev Ultrafast internals."""

from __future__ import annotations

import json
import os
import time
from collections.abc import Mapping
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

from .schemas import BrowserObservation, PredictedAction


def _validated_field_text(result: Any) -> str:
    """Classify invalid output without including provider-controlled text in errors."""

    finish_reason = None

    def invalid(code: str) -> None:
        message = f"Text helper invalid output: {code}"
        if finish_reason is not None:
            message += f"; finish_reason={finish_reason}"
        raise ValueError(message) from None

    if not isinstance(result, dict) or "choices" not in result:
        invalid("CHOICES_MISSING")
    choices = result["choices"]
    # A present but malformed choices container is an invalid message envelope.
    if not isinstance(choices, list):
        invalid("MESSAGE_INVALID")
    if not choices:
        invalid("CHOICES_EMPTY")
    choice = choices[0]
    if not isinstance(choice, dict):
        invalid("MESSAGE_INVALID")
    reason = choice.get("finish_reason")
    if isinstance(reason, str) and reason in {
        "stop", "length", "content_filter", "tool_calls", "function_call", "error"
    }:
        finish_reason = reason
    message = choice.get("message")
    if not isinstance(message, dict):
        invalid("MESSAGE_INVALID")
    if "content" not in message:
        invalid("CONTENT_MISSING")
    content = message["content"]
    if content is None:
        invalid("CONTENT_NULL")
    if not isinstance(content, str):
        invalid("CONTENT_TYPE_INVALID")
    if not content.strip():
        invalid("CONTENT_EMPTY")
    try:
        output = json.loads(content)
    except (ValueError, RecursionError):
        invalid("JSON_PARSE_ERROR")
    if not isinstance(output, dict):
        invalid("JSON_NOT_OBJECT")
    if "text" not in output:
        invalid("TEXT_MISSING")
    if set(output) != {"text"}:
        invalid("EXTRA_KEYS")
    value = output["text"]
    if not isinstance(value, str):
        invalid("TEXT_TYPE_INVALID")
    if not value:
        invalid("TEXT_EMPTY")
    if not value.strip():
        invalid("TEXT_WHITESPACE_ONLY")
    if len(value) > 2000:
        invalid("TEXT_TOO_LONG")
    return value


def _strict_field_text(context: Mapping[str, Any]) -> tuple[str, dict[str, Any]]:
    """Generate a field value through the upstream client with a strict schema."""

    from jev_ultrafast import model as jev_model
    from jev_ultrafast.questions import TEXT_VALUE

    key = os.environ.get("TEXT_MODEL_API_KEY")
    if not key:
        raise ValueError("TYPE_TEXT needs TEXT_MODEL_API_KEY; no text is hardcoded or guessed by the executor.")
    base = os.environ.get("TEXT_MODEL_BASE_URL", "https://api.deepseek.com/v1").rstrip("/")
    model = os.environ.get("TEXT_MODEL", "deepseek-chat")
    reasoning = {"thinking": {"type": "disabled"}} if "api.deepseek.com/" in base else {"reasoning": {"effort": "low"}}
    if os.environ.get("TEXT_MODEL_REASONING") == "none":
        reasoning = {"reasoning": {"enabled": False}}

    body: dict[str, Any] = {
        "model": model,
        "max_tokens": 1024,
        "response_format": {
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
        },
        **reasoning,
        "messages": [
            {"role": "system", "content": TEXT_VALUE},
            {"role": "user", "content": json.dumps(context)},
        ],
    }
    if urlsplit(base).hostname == "openrouter.ai":
        body["provider"] = {"require_parameters": True}

    started = time.perf_counter()
    result = jev_model.post_json(base + "/chat/completions", key, body)
    value = _validated_field_text(result)
    return value, {
        "model": model,
        "latency_ms": round((time.perf_counter() - started) * 1000),
        "usage": result.get("usage", {}),
    }


def _install_strict_text_helper() -> None:
    """Replace the function reference imported into upstream agent.py."""

    from jev_ultrafast import agent as jev_agent

    jev_agent.field_text = _strict_field_text


class ActionExecutionError(RuntimeError):
    """An action failed; `possibly_executed` prevents unsafe mutation retries."""

    def __init__(self, message: str, *, possibly_executed: bool, fresh_prediction: bool) -> None:
        super().__init__(message)
        self.possibly_executed = possibly_executed
        self.fresh_prediction = fresh_prediction


class BrowserSession(Protocol):
    def predict(self) -> PredictedAction: ...

    def act_once(self) -> BrowserObservation: ...

    def observe(self) -> BrowserObservation: ...

    def close(self) -> None: ...

    @property
    def history_length(self) -> int: ...

    @property
    def model_calls(self) -> int: ...

    @property
    def status(self) -> str: ...

    @property
    def last_history(self) -> Mapping[str, Any] | None: ...


def _observation(page: Mapping[str, Any]) -> BrowserObservation:
    return BrowserObservation(
        url=str(page.get("url", "")),
        title=str(page.get("title", "")),
        visible_text=str(page.get("text", "")),
        fingerprint=str(page.get("fingerprint")) if page.get("fingerprint") else None,
        raw=dict(page),
    )


class JevSession:
    """A predict/policy/act-once facade over the pinned upstream Agent."""

    def __init__(self, url: str, goal: str) -> None:
        from jev_ultrafast import Agent
        from jev_ultrafast import model as jev_model
        from jev_ultrafast.browser import StalePage

        _install_strict_text_helper()
        model_timeout = float(os.environ.get("BROWSER_FAST_MODEL_TIMEOUT_SECONDS", "25"))
        if not 1 <= model_timeout <= 120:
            raise ValueError("BROWSER_FAST_MODEL_TIMEOUT_SECONDS must be between 1 and 120")
        # Upstream owns the request implementation; the adapter owns its finite timeout.
        jev_model.CLIENT.timeout = httpx.Timeout(model_timeout)
        self._stale_page_type = StalePage
        self._agent = Agent(url, goal, screenshots=False, record_dir=None)

    @property
    def history_length(self) -> int:
        return len(self._agent.state["history"])

    @property
    def model_calls(self) -> int:
        return len(self._agent.state["decisions"])

    @property
    def status(self) -> str:
        return str(self._agent.state["status"])

    @property
    def last_history(self) -> Mapping[str, Any] | None:
        history = self._agent.state["history"]
        return history[-1] if history else None

    def predict(self) -> PredictedAction:
        self._agent.command("predict", {})
        state = self._agent.state
        decision = state["decision"]
        page = state["page"]
        selected = str(decision["choice"])
        if selected in {"DONE", "BLOCKED"}:
            return PredictedAction(
                selected_id=selected,
                operation=selected,
                kind="terminal",
                label=selected,
                role=None,
                field_type=None,
                nearby_context="",
                current_url=str(page["url"]),
                target_url=None,
                confidence=_optional_float(decision.get("confidence")),
                terminal="done" if selected == "DONE" else "blocked",
                raw=dict(decision),
            )

        action = next(item for item in page["actions"] if item["id"] == selected)
        guard = page.get("guards", {}).get(str(action.get("node")), [])
        nearby_context = str(guard[13]) if len(guard) > 13 and guard[13] is not None else ""
        target_url = str(guard[12]) if len(guard) > 12 and guard[12] else None
        role = str(action.get("role")) if action.get("role") else None
        return PredictedAction(
            selected_id=selected,
            operation=str(decision.get("operation", action["kind"])).upper(),
            kind=str(action["kind"]),
            label=str(action.get("label", selected)),
            role=role,
            field_type=role,
            nearby_context=nearby_context,
            current_url=str(page["url"]),
            target_url=target_url,
            confidence=_optional_float(decision.get("confidence")),
            raw={"decision": dict(decision), "action": dict(action)},
        )

    def act_once(self) -> BrowserObservation:
        before = self.history_length
        fingerprint = self._agent.state["page"]["fingerprint"]
        try:
            snapshot = self._agent.command("act", {"fingerprint": fingerprint})
        except Exception as exc:
            # The decision was consumed before text generation or input. If history advanced,
            # execution is certain; otherwise it remains uncertain and must never be replayed.
            history_advanced = self.history_length > before
            model_failure = any(
                marker in str(exc).casefold()
                for marker in ("model", "typesafe", "text_model", "text helper", "http 4", "http 5")
            )
            possibly_executed = history_advanced or (not isinstance(exc, self._stale_page_type) and not model_failure)
            fresh_prediction = isinstance(exc, self._stale_page_type) or possibly_executed
            raise ActionExecutionError(
                str(exc),
                possibly_executed=possibly_executed,
                fresh_prediction=fresh_prediction,
            ) from exc
        return _observation(snapshot["page"])

    def observe(self) -> BrowserObservation:
        page = self._agent.browser.observe(screenshot=False)
        self._agent.state["page"] = page
        self._agent.state["decision"] = None
        if self._agent.state["status"] == "predicted":
            self._agent.state["status"] = "ready"
        return _observation(page)

    def close(self) -> None:
        self._agent.close()


def _optional_float(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) else None
