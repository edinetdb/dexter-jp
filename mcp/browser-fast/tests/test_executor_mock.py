from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from browser_fast.executor import BrowserExecutor
from browser_fast.jev_adapter import ActionExecutionError
from browser_fast.schemas import BrowserObservation, BrowserTaskRequest, PredictedAction


def predicted(label: str = "Next page", *, terminal: str | None = None) -> PredictedAction:
    selected = terminal.upper() if terminal else "e1"
    return PredictedAction(
        selected_id=selected,
        operation=selected if terminal else "CLICK",
        kind="terminal" if terminal else "click",
        label=selected if terminal else label,
        role=None if terminal else "link",
        field_type=None,
        nearby_context="",
        current_url="https://example.com/start",
        target_url="https://example.com/next" if not terminal else None,
        confidence=0.9,
        terminal=terminal,  # type: ignore[arg-type]
    )


class FakeSession:
    def __init__(
        self,
        predictions: list[PredictedAction],
        *,
        fail_action_once: bool = False,
        fail_predict: bool = False,
    ) -> None:
        self.predictions = predictions
        self.fail_action_once = fail_action_once
        self.fail_predict = fail_predict
        self.closed = False
        self.act_calls = 0
        self.mutation_calls = 0
        self._history: list[dict[str, Any]] = []
        self._model_calls = 0
        self._status = "ready"
        self._current: PredictedAction | None = None
        self.observation = BrowserObservation(
            url="https://example.com/start",
            title="Example",
            visible_text="Expected result",
        )

    def predict(self) -> PredictedAction:
        if self.fail_predict:
            raise RuntimeError("synthetic Jev failure")
        self._model_calls += 1
        self._current = self.predictions.pop(0)
        return self._current

    def act_once(self) -> BrowserObservation:
        assert self._current is not None
        self.act_calls += 1
        if self._current.terminal == "blocked":
            self._status = "blocked"
            return self.observation
        if self._current.terminal == "done":
            self._status = "done"
            return self.observation
        self.mutation_calls += 1
        if self.fail_action_once:
            self.fail_action_once = False
            raise ActionExecutionError("uncertain synthetic mutation", possibly_executed=True, fresh_prediction=True)
        self._history.append(
            {
                "url": self.observation.url,
                "page_changed": True,
            }
        )
        return self.observation

    def observe(self) -> BrowserObservation:
        return self.observation

    def close(self) -> None:
        self.closed = True

    @property
    def history_length(self) -> int:
        return len(self._history)

    @property
    def model_calls(self) -> int:
        return self._model_calls

    @property
    def status(self) -> str:
        return self._status

    @property
    def last_history(self) -> Mapping[str, Any] | None:
        return self._history[-1] if self._history else None


def run_with(session: FakeSession, tmp_path: Path, **request_overrides: object):
    executor = BrowserExecutor(
        session_factory=lambda _url, _goal: session,
        trace_root=tmp_path,
        require_credentials=False,
        resolve_dns=False,
    )
    request = BrowserTaskRequest(
        url="https://example.com/start",
        goal="Navigate to the expected result",
        expected_text_all=["Expected result"],
        **request_overrides,
    )
    return executor.run(request)


def test_max_steps_is_enforced(tmp_path: Path) -> None:
    session = FakeSession([predicted(), predicted(), predicted(terminal="done")])
    result = run_with(session, tmp_path, max_steps=2)
    assert result.status == "max_steps"
    assert result.steps == 2
    assert session.mutation_calls == 2


def test_policy_blocks_before_act(tmp_path: Path) -> None:
    session = FakeSession([predicted("Buy")])
    result = run_with(session, tmp_path)
    assert result.status == "policy_blocked"
    assert session.act_calls == 0


def test_safe_action_executes_once(tmp_path: Path) -> None:
    session = FakeSession([predicted(), predicted(terminal="done")])
    result = run_with(session, tmp_path)
    assert result.status == "success"
    assert session.mutation_calls == 1


def test_failed_mutation_is_not_replayed_from_same_prediction(tmp_path: Path) -> None:
    session = FakeSession([predicted(), predicted(terminal="done")], fail_action_once=True)
    result = run_with(session, tmp_path)
    assert result.status == "success"
    assert session.mutation_calls == 1
    assert session._model_calls == 2
    assert result.actions[0].action_result == "uncertain"


def test_jev_blocked_is_propagated(tmp_path: Path) -> None:
    session = FakeSession([predicted(terminal="blocked")])
    result = run_with(session, tmp_path)
    assert result.status == "blocked"
    assert result.error_code == "JEV_BLOCKED"


def test_exception_always_closes_browser(tmp_path: Path) -> None:
    session = FakeSession([], fail_predict=True)
    result = run_with(session, tmp_path)
    assert result.status == "error"
    assert session.closed


def test_trace_is_generated_and_redacted(tmp_path: Path) -> None:
    session = FakeSession([predicted(), predicted(terminal="done")])
    result = run_with(session, tmp_path)
    trace = tmp_path / result.trace_id
    assert {path.name for path in trace.iterdir()} == {"run.json", "actions.jsonl", "verification.json"}
    run = json.loads((trace / "run.json").read_text(encoding="utf-8"))
    assert run["status"] == "success"
    assert run["upstream_sha"]


def test_done_without_criteria_is_not_success(tmp_path: Path) -> None:
    session = FakeSession([predicted(terminal="done")])
    executor = BrowserExecutor(
        session_factory=lambda _url, _goal: session,
        trace_root=tmp_path,
        require_credentials=False,
        resolve_dns=False,
    )
    result = executor.run(BrowserTaskRequest(url="https://example.com/start", goal="Read"))
    assert result.status == "unverified_done"
    assert not result.verified
