"""stdio MCP entrypoint exposing exactly one read-only browser tool."""

from __future__ import annotations

import asyncio
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from . import load_local_environment
from .executor import BrowserExecutor
from .schemas import BrowserTaskRequest, BrowserTaskResult

load_local_environment()

server = MCPServer(
    "browser-fast",
    description="Policy-gated, read-only browser tasks through pinned Jev Ultrafast.",
    version="0.1.0",
)
_executor = BrowserExecutor()


@server.tool(
    name="browser_fast_run",
    title="Run a read-only browser task",
    description=(
        "Execute a bounded read-only browser navigation/query task. Transactional, authentication, "
        "messaging, publishing, upload, deletion, and account actions are blocked before execution."
    ),
    annotations=ToolAnnotations(
        title="Read-only browser task",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=False,
        openWorldHint=True,
    ),
    structured_output=True,
)
async def browser_fast_run(
    url: Annotated[str, Field(min_length=1, max_length=4096)],
    goal: Annotated[str, Field(min_length=1, max_length=20_000)],
    expected_text_all: Annotated[list[str], Field(max_length=100)] = [],
    expected_text_any: Annotated[list[str], Field(max_length=100)] = [],
    expected_url_regex: Annotated[str | None, Field(max_length=2000)] = None,
    max_steps: Annotated[int, Field(ge=1, le=40)] = 20,
) -> BrowserTaskResult:
    """Run one serialized Jev session and independently verify its final page."""

    request = BrowserTaskRequest(
        url=url,
        goal=goal,
        expected_text_all=expected_text_all,
        expected_text_any=expected_text_any,
        expected_url_regex=expected_url_regex,
        max_steps=max_steps,
    )
    return await asyncio.to_thread(_executor.run, request)


def main() -> None:
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
