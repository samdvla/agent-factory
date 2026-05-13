"""Force stdlib HTTPS clients (urllib, http.client) to use IPv4 only.

Some networks (notably the operator's) have broken IPv6 paths to AWS
CloudFront / Cloudflare CDNs that Higgsfield, Tripo, and Meshy serve
assets from. Python's stdlib doesn't implement Happy Eyeballs (RFC 8305)
fallback — when a host has both AAAA and A records, `socket.getaddrinfo`
returns the AAAA first and the connect() hangs in SYN_SENT for ~75s per
attempt while the kernel retries SYN. That eats the supervisor's 900s
budget on a single download and gives no useful error.

Usage:
    from .ipv4 import force_ipv4

    with force_ipv4():
        urllib.request.urlopen(req, timeout=60)

The patch is thread-unsafe by design — only the wrapping block sees
IPv4-only resolution. Safe enough for the workers which call urllib
single-threaded per request.
"""
from contextlib import contextmanager
import os
import socket
import sys


def install_global_ipv4_only() -> None:
    """Permanently monkey-patch socket.getaddrinfo for this process so every
    stdlib HTTPS client (urllib in nanobanana/higgsfield/tripo/meshy, plus
    any transitive http.client usage) resolves to IPv4 only.

    Idempotent — calling twice is harmless. Set env AGENT_FACTORY_ALLOW_IPV6=1
    to skip the patch (debugging only)."""
    if os.environ.get("AGENT_FACTORY_ALLOW_IPV6", "").strip() == "1":
        return
    if getattr(socket, "_agent_factory_ipv4_only_installed", False):
        return
    orig = socket.getaddrinfo

    def _ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        return orig(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = _ipv4_only
    socket._agent_factory_ipv4_only_installed = True
    print(
        "[ipv4] socket.getaddrinfo patched to IPv4-only "
        "(set AGENT_FACTORY_ALLOW_IPV6=1 to disable)",
        file=sys.stderr, flush=True,
    )


@contextmanager
def force_ipv4():
    """Within the `with` block, socket.getaddrinfo returns only IPv4
    addresses. Restored on exit even on exception."""
    orig = socket.getaddrinfo

    def _ipv4_only(host, port, family=0, type=0, proto=0, flags=0):
        # Force AF_INET. If a caller passes a specific family, honour it
        # only when it's already AF_INET — otherwise override to IPv4.
        return orig(host, port, socket.AF_INET, type, proto, flags)

    socket.getaddrinfo = _ipv4_only
    try:
        yield
    finally:
        socket.getaddrinfo = orig
