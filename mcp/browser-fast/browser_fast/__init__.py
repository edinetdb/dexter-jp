"""browser-fast: a read-only MCP safety adapter for Jev Ultrafast."""

from pathlib import Path

from dotenv import load_dotenv

UPSTREAM_SHA = "452c1ad2dd628008f1d5608f28158d76e49e6cc0"
PACKAGE_ROOT = Path(__file__).resolve().parent.parent


def load_local_environment() -> None:
    """Load this package's optional .env without overriding the host environment."""

    load_dotenv(PACKAGE_ROOT / ".env", override=False)


__all__ = ["PACKAGE_ROOT", "UPSTREAM_SHA", "load_local_environment"]
