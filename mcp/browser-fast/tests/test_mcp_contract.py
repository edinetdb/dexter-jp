from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from mcp import Client, StdioServerParameters
from mcp.client.stdio import stdio_client

from browser_fast import PACKAGE_ROOT


def test_mcp_lists_and_calls_one_structured_read_only_tool(tmp_path: Path) -> None:
    async def inspect_contract() -> None:
        parameters = StdioServerParameters(
            command=sys.executable,
            args=["-m", "browser_fast.server"],
            cwd=PACKAGE_ROOT,
            env={**os.environ, "BROWSER_FAST_TRACE_DIR": str(tmp_path)},
        )
        async with Client(stdio_client(parameters)) as client:
            listed = await client.list_tools()
            assert [tool.name for tool in listed.tools] == ["browser_fast_run"]
            tool = listed.tools[0]
            assert {
                "url",
                "goal",
                "expected_text_all",
                "expected_text_any",
                "expected_url_regex",
                "max_steps",
            }.issubset(tool.input_schema["properties"])
            assert {
                "status",
                "verified",
                "trace_id",
                "verification",
                "actions",
            }.issubset(tool.output_schema["properties"])
            assert tool.annotations is not None
            assert tool.annotations.read_only_hint is True
            assert tool.annotations.destructive_hint is False

            called = await client.call_tool(
                "browser_fast_run",
                {"url": "file:///etc/passwd", "goal": "Read a local file"},
            )
            assert called.is_error is False
            assert called.structured_content is not None
            assert called.structured_content["status"] == "error"
            assert called.structured_content["error_code"] == "INVALID_URL"

    asyncio.run(inspect_contract())
