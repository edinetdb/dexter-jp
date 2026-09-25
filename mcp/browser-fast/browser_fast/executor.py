"""Bounded OBSERVE → PREDICT → POLICY → ACT ONCE → OBSERVE execution."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from .jev_adapter import ActionExecutionError, BrowserSession, JevSession
from .policy import evaluate_action
from .schemas import BrowserActionSummary, BrowserTaskRequest, BrowserTaskResult, PredictedAction
from .security import URLInfo, URLSecurityError, validate_navigation, validate_url
from .trace import TraceWriter, create_trace_id, utc_now
from .verifier import verify

_EXECUTION_LOCK = threading.Lock()
SessionFactory = Callable[[str, str], BrowserSession]


class RunTimeoutError(TimeoutError):
    pass


class BrowserExecutor:
    def __init__(
        self,
        *,
        session_factory: SessionFactory = JevSession,
        trace_root: Path | None = None,
        require_credentials: bool = True,
        resolve_dns: bool = True,
    ) -> None:
        self._session_factory = session_factory
        self._trace_root = trace_root
        self._require_credentials = require_credentials
        self._resolve_dns = resolve_dns

    def run(self, request: BrowserTaskRequest) -> BrowserTaskResult:
        started_at = utc_now()
        started_perf = time.perf_counter()
        trace_id = create_trace_id(started_at)
        trace = TraceWriter(trace_id, self._trace_root)
        trace.write_start(start_timestamp=started_at, start_url=request.url, goal=request.goal)
        session: BrowserSession | None = None
        model_calls = 0
        actions: list[BrowserActionSummary] = []
        state: dict[str, Any] = {"verification": [], "final_url": None, "steps": 0}

        def elapsed_ms() -> int:
            return max(0, round((time.perf_counter() - started_perf) * 1000))

        def result(
            status: str,
            *,
            verified: bool = False,
            error_code: str | None = None,
            error_message: str | None = None,
        ) -> BrowserTaskResult:
            return BrowserTaskResult(
                status=status,
                verified=verified,
                goal=request.goal,
                start_url=request.url,
                final_url=state["final_url"],
                elapsed_ms=elapsed_ms(),
                steps=state["steps"],
                trace_id=trace_id,
                verification=state["verification"],
                actions=actions,
                error_code=error_code,
                error_message=error_message,
            )

        final_result: BrowserTaskResult
        try:
            start_info = validate_url(request.url, resolve_dns=self._resolve_dns)
            self._check_credentials()
            total_timeout = float(os.environ.get("BROWSER_FAST_TOTAL_TIMEOUT_SECONDS", "180"))
            if not 5 <= total_timeout <= 900:
                raise ValueError("BROWSER_FAST_TOTAL_TIMEOUT_SECONDS must be between 5 and 900")

            with _EXECUTION_LOCK:
                deadline = time.monotonic() + total_timeout
                session = self._session_factory(request.url, request.goal)
                observation = session.observe()
                _check_deadline(deadline, "after initial observation")
                state["final_url"] = observation.url
                validate_navigation(
                    start_info,
                    observation.url,
                    resolve_dns=self._resolve_dns,
                )

                final_result = self._execute_loop(
                    request=request,
                    session=session,
                    start_info=start_info,
                    deadline=deadline,
                    actions=actions,
                    trace=trace,
                    get_steps=lambda: int(state["steps"]),
                    set_steps=lambda value: state.__setitem__("steps", value),
                    set_final_url=lambda value: state.__setitem__("final_url", value),
                    set_verification=lambda value: state.__setitem__("verification", value),
                    result=result,
                )
        except URLSecurityError as exc:
            status = "blocked" if exc.code in {"DOMAIN_BLOCKED", "DOMAIN_BOUNDARY_VIOLATION"} else "error"
            final_result = result(status, error_code=exc.code, error_message=str(exc))
        except RunTimeoutError as exc:
            final_result = result("error", error_code="TIMEOUT", error_message=str(exc))
        except Exception as exc:
            code = _classify_exception(exc)
            final_result = result("error", error_code=code, error_message=_safe_error_message(exc))
        finally:
            if session is not None:
                model_calls = session.model_calls
                try:
                    session.close()
                except Exception:
                    pass
        trace.finalize(
            start_timestamp=started_at,
            end_timestamp=utc_now(),
            result=final_result.model_dump(mode="json"),
            model_calls=model_calls,
        )
        return final_result

    def _check_credentials(self) -> None:
        if not self._require_credentials:
            return
        missing = [name for name in ("TYPESAFE_API_KEY", "TEXT_MODEL_API_KEY") if not os.environ.get(name)]
        if missing:
            raise RuntimeError("Missing required credential(s): " + ", ".join(missing))

    def _execute_loop(
        self,
        *,
        request: BrowserTaskRequest,
        session: BrowserSession,
        start_info: URLInfo,
        deadline: float,
        actions: list[BrowserActionSummary],
        trace: TraceWriter,
        get_steps: Callable[[], int],
        set_steps: Callable[[int], None],
        set_final_url: Callable[[str], None],
        set_verification: Callable[[list[Any]], None],
        result: Callable[..., BrowserTaskResult],
    ) -> BrowserTaskResult:
        while get_steps() < request.max_steps:
            _check_deadline(deadline, "before prediction")
            predicted = session.predict()
            _check_deadline(deadline, "after prediction")

            validate_navigation(
                start_info,
                predicted.current_url,
                resolve_dns=self._resolve_dns,
            )
            if predicted.target_url:
                validate_navigation(
                    start_info,
                    predicted.target_url,
                    current_url=predicted.current_url,
                    resolve_dns=self._resolve_dns,
                )

            policy = evaluate_action(predicted, request.goal)
            if not policy.allowed:
                summary = _summary(predicted, get_steps() + 1, "blocked", None)
                actions.append(summary)
                trace.append_action(summary.model_dump(mode="json"))
                return result(
                    "policy_blocked",
                    error_code=policy.code or "POLICY_BLOCKED",
                    error_message=policy.reason or "Action blocked by policy.",
                )

            before = session.history_length
            _check_deadline(deadline, "before action")
            try:
                observation = session.act_once()
            except ActionExecutionError as exc:
                if not exc.fresh_prediction:
                    raise RuntimeError(str(exc)) from exc
                if predicted.terminal is None and exc.possibly_executed:
                    set_steps(get_steps() + 1)
                    summary = _summary(predicted, get_steps(), "uncertain", session.last_history)
                    actions.append(summary)
                    trace.append_action(summary.model_dump(mode="json"))
                if get_steps() >= request.max_steps:
                    return result("max_steps", error_code="MAX_STEPS", error_message="The action budget was exhausted.")
                # Never replay the consumed prediction. Observe, then request a fresh prediction.
                observation = session.observe()
                set_final_url(observation.url)
                validate_navigation(start_info, observation.url, resolve_dns=self._resolve_dns)
                continue

            set_final_url(observation.url)
            validate_navigation(start_info, observation.url, resolve_dns=self._resolve_dns)

            if predicted.terminal == "blocked":
                return result("blocked", error_code="JEV_BLOCKED", error_message="Jev reported no supported progress.")
            if predicted.terminal == "done":
                # DONE is never success by itself. Obtain a separate, fresh observation.
                fresh = session.observe()
                set_final_url(fresh.url)
                validate_navigation(start_info, fresh.url, resolve_dns=self._resolve_dns)
                checked = verify(request, fresh)
                set_verification(checked.results)
                if checked.passed:
                    return result("success", verified=True)
                return result(
                    "unverified_done",
                    error_code="VERIFICATION_FAILED" if checked.has_criteria else None,
                    error_message=(
                        "One or more deterministic verification criteria failed."
                        if checked.has_criteria
                        else "Jev finished, but no independent verification criteria were supplied."
                    ),
                )

            advanced = max(1, session.history_length - before)
            set_steps(min(request.max_steps, get_steps() + advanced))
            summary = _summary(predicted, get_steps(), "executed", session.last_history)
            actions.append(summary)
            trace.append_action(summary.model_dump(mode="json"))
            if session.status == "blocked":
                return result(
                    "blocked",
                    error_code="JEV_BLOCKED",
                    error_message="Jev stopped after repeated no-progress actions.",
                )

        return result("max_steps", error_code="MAX_STEPS", error_message="The action budget was exhausted.")


def _check_deadline(deadline: float, phase: str) -> None:
    if time.monotonic() >= deadline:
        raise RunTimeoutError(f"The total run timeout was reached {phase}.")


def _summary(
    predicted: PredictedAction,
    step: int,
    action_result: str,
    history: Mapping[str, Any] | None,
) -> BrowserActionSummary:
    return BrowserActionSummary(
        step=max(1, step),
        operation=predicted.operation,
        kind=predicted.kind,
        label=predicted.label,
        role=predicted.role,
        url=str(history.get("url")) if history and history.get("url") else predicted.current_url,
        page_changed=history.get("page_changed") if history else None,
        confidence=predicted.confidence,
        action_result=action_result,
    )


def _classify_exception(exc: Exception) -> str:
    message = str(exc).casefold()
    if "missing required credential" in message:
        return "MISSING_API_KEY"
    if "model" in message or "typesafe" in message or "text_model" in message or "text helper" in message:
        return "MODEL_ERROR"
    if "browser" in message or "chrome" in message or "cdp" in message:
        return "BROWSER_ERROR"
    if isinstance(exc, (ImportError, ModuleNotFoundError)):
        return "ENVIRONMENT_ERROR"
    return "JEV_ERROR"


def _safe_error_message(exc: Exception) -> str:
    message = str(exc).strip()
    return message[:1000] if message else exc.__class__.__name__
