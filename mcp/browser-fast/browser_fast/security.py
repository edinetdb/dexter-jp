"""URL, DNS, and registrable-domain controls for browser-fast."""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

import tldextract

_EXTRACT = tldextract.TLDExtract(suffix_list_urls=(), include_psl_private_domains=True)
_BLOCKED_HOSTS = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata.google.internal.",
}
_BLOCKED_SUFFIXES = (".local", ".localhost", ".internal", ".home", ".lan")


class URLSecurityError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class URLInfo:
    url: str
    hostname: str
    site: str


def _is_public_ip(address: str) -> bool:
    try:
        return ipaddress.ip_address(address).is_global
    except ValueError:
        return False


def _site_for(hostname: str) -> str:
    try:
        ipaddress.ip_address(hostname)
        return hostname
    except ValueError:
        extracted = _EXTRACT(hostname)
        site = extracted.top_domain_under_public_suffix
        if not site:
            raise URLSecurityError("DOMAIN_BLOCKED", "The hostname has no registrable public domain.")
        return site.casefold()


def validate_url(
    url: str,
    *,
    allow_localhost: bool = False,
    resolve_dns: bool = True,
) -> URLInfo:
    """Validate a browser URL and reject local, private, or ambiguous destinations."""

    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError as exc:
        raise URLSecurityError("INVALID_URL", "The URL is malformed.") from exc

    if parsed.scheme.casefold() not in {"http", "https"}:
        raise URLSecurityError("INVALID_URL", "Only http and https URLs are supported.")
    if not parsed.hostname:
        raise URLSecurityError("INVALID_URL", "The URL must include a hostname.")
    if parsed.username is not None or parsed.password is not None:
        raise URLSecurityError("INVALID_URL", "Credentials embedded in URLs are not supported.")

    hostname = parsed.hostname.rstrip(".").casefold()
    is_local_name = hostname in _BLOCKED_HOSTS or hostname.endswith(_BLOCKED_SUFFIXES)
    if is_local_name and not allow_localhost:
        raise URLSecurityError("DOMAIN_BLOCKED", "Local and internal hostnames are blocked.")

    literal_ip: ipaddress.IPv4Address | ipaddress.IPv6Address | None
    try:
        literal_ip = ipaddress.ip_address(hostname)
    except ValueError:
        literal_ip = None

    if literal_ip is not None:
        if not literal_ip.is_global and not (allow_localhost and literal_ip.is_loopback):
            raise URLSecurityError("DOMAIN_BLOCKED", "Private, loopback, link-local, and reserved IPs are blocked.")
    elif "." not in hostname and not allow_localhost:
        raise URLSecurityError("DOMAIN_BLOCKED", "Single-label hostnames are blocked.")

    if resolve_dns and not (allow_localhost and is_local_name):
        try:
            records = socket.getaddrinfo(
                hostname,
                port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except socket.gaierror as exc:
            raise URLSecurityError("DOMAIN_BLOCKED", "The hostname could not be resolved safely.") from exc
        addresses = {record[4][0] for record in records}
        if not addresses or any(not _is_public_ip(address) for address in addresses):
            raise URLSecurityError("DOMAIN_BLOCKED", "The hostname resolves to a non-public address.")

    site = hostname if allow_localhost and (is_local_name or literal_ip is not None) else _site_for(hostname)
    return URLInfo(url=url, hostname=hostname, site=site)


def validate_navigation(
    start: URLInfo,
    candidate_url: str,
    *,
    current_url: str | None = None,
    resolve_dns: bool = True,
) -> URLInfo:
    """Resolve a candidate and enforce the initial registrable-domain boundary."""

    absolute = urljoin(current_url or start.url, candidate_url)
    candidate = validate_url(absolute, resolve_dns=resolve_dns)
    if candidate.site != start.site:
        raise URLSecurityError(
            "DOMAIN_BOUNDARY_VIOLATION",
            f"Navigation outside the initial site ({start.site}) is blocked.",
        )
    return candidate
