"""The only module allowed to depend on Jev Ultrafast internals."""

from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any, Protocol

import httpx

from .schemas import BrowserObservation, PredictedAction


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
