from __future__ import annotations

import socket

import pytest

from browser_fast.security import URLSecurityError, validate_navigation, validate_url


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/plain,hello",
        "chrome://settings",
        "chrome-extension://abc/page.html",
        "http://localhost/",
        "http://127.0.0.1/",
        "http://10.1.2.3/",
        "http://172.16.0.1/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[fc00::1]/",
        "http://printer.local/",
    ],
)
def test_blocked_urls(url: str) -> None:
    with pytest.raises(URLSecurityError):
        validate_url(url, resolve_dns=False)


def test_public_https_is_allowed_without_network_lookup() -> None:
    info = validate_url("https://sub.example.co.uk/path", resolve_dns=False)
    assert info.site == "example.co.uk"


def test_registrable_domain_boundary_allows_subdomains() -> None:
    start = validate_url("https://www.example.co.uk/start", resolve_dns=False)
    candidate = validate_navigation(start, "https://docs.example.co.uk/page", resolve_dns=False)
    assert candidate.site == start.site


def test_registrable_domain_boundary_blocks_suffix_tricks() -> None:
    start = validate_url("https://example.com/start", resolve_dns=False)
    with pytest.raises(URLSecurityError, match="outside") as caught:
        validate_navigation(start, "https://example.com.evil.com/page", resolve_dns=False)
    assert caught.value.code == "DOMAIN_BOUNDARY_VIOLATION"


def test_test_mode_can_explicitly_allow_localhost() -> None:
    info = validate_url("http://localhost:8000/", allow_localhost=True, resolve_dns=False)
    assert info.hostname == "localhost"


def test_hostname_resolving_to_private_ip_is_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.8", 443))],
    )
    with pytest.raises(URLSecurityError) as caught:
        validate_url("https://public.example.com/", resolve_dns=True)
    assert caught.value.code == "DOMAIN_BLOCKED"
