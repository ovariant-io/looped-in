"""Self-adapting public URL for a dynamic gateway endpoint / tunnel."""

from __future__ import annotations

import re
from collections.abc import Iterable

_OAUTH_METADATA_PREFIX = "/.well-known/oauth-protected-resource"

# The Host header is attacker-controlled, and whatever it says is reflected into two
# OAuth discovery surfaces. Constrain it to the RFC 3986 reg-name/port shape before it
# can reach either: letters, digits, dot, hyphen, optional `:port`. That rejects the
# characters an injection would need (CR/LF, spaces, quotes, `/`, `@`) outright.
_HOST_PATTERN = re.compile(rb"^[A-Za-z0-9.\-]{1,253}(:[0-9]{1,5})?$")

# Only these two ever belong in a discovery URL.
_VALID_SCHEMES = (b"http", b"https")


class PublicUrlRewriteMiddleware:
    """Make the OAuth discovery surfaces reflect the public URL the client
    actually used, instead of the fixed `base_url` baked in at startup.

    RemoteAuthProvider builds the protected-resource metadata once, from
    `base_url`, and FastMCP has no forwarded-header support — but this server may
    sit behind a public URL it can't know at boot (the API Gateway endpoint AWS
    generates, or an ngrok tunnel). So we hand RemoteAuthProvider a sentinel
    origin and rewrite it, on the way out, to `{X-Forwarded-Proto}://{Host}` of
    the incoming request. Two surfaces carry the origin: the `WWW-Authenticate`
    header on 401s (its `resource_metadata=` URL) and the body of
    `/.well-known/oauth-protected-resource` (its `resource` field). Only those are
    touched — and the metadata body's Content-Length is recomputed; everything
    else passes straight through. Active only when SERVER_BASE_URL is unset.

    Both inputs to that origin come from the request, so both are validated: the
    scheme must be http/https and the host must match `_HOST_PATTERN`. A request
    failing either is served with the sentinel left in place — discovery degrades
    to unusable rather than advertising an origin someone else chose. Setting
    ALLOWED_PUBLIC_HOSTS narrows it further to an explicit list, which is worth
    doing anywhere the public hostname is actually known (a custom domain, or a
    gateway endpoint you can read off the stack outputs after the first deploy).
    """

    def __init__(self, app, sentinel_origin: str, allowed_hosts: Iterable[str] = ()) -> None:
        self.app = app
        self._sentinel = sentinel_origin.rstrip("/").encode()
        self._allowed_hosts = frozenset(host.lower() for host in allowed_hosts)

    def _public_origin(self, scope) -> bytes | None:
        """The validated `scheme://host` this request arrived on, or None."""
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        host = headers.get(b"host")
        if not host or not _HOST_PATTERN.match(host):
            return None
        if self._allowed_hosts and host.decode().lower() not in self._allowed_hosts:
            return None

        # X-Forwarded-Proto may be a comma-separated chain; the first entry is the
        # scheme the client actually used.
        forwarded = headers.get(b"x-forwarded-proto", b"").split(b",")[0].strip().lower()
        scheme = forwarded or scope.get("scheme", "https").encode().lower()
        if scheme not in _VALID_SCHEMES:
            return None

        return scheme + b"://" + host

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        origin = self._public_origin(scope)
        if origin is None or origin == self._sentinel:
            await self.app(scope, receive, send)
            return

        buffer_body = scope.get("path", "").startswith(_OAUTH_METADATA_PREFIX)
        start: dict | None = None
        chunks: list[bytes] = []

        async def send_wrapper(message) -> None:
            nonlocal start
            mtype = message["type"]
            if mtype == "http.response.start":
                message = {
                    **message,
                    "headers": [
                        (k, v.replace(self._sentinel, origin))
                        if k.lower() == b"www-authenticate"
                        else (k, v)
                        for k, v in message.get("headers", [])
                    ],
                }
                if buffer_body:
                    start = message  # hold until the full body is rewritten
                    return
                await send(message)
            elif mtype == "http.response.body" and buffer_body:
                chunks.append(message.get("body", b""))
                if message.get("more_body"):
                    return
                body = b"".join(chunks).replace(self._sentinel, origin)
                hdrs = [(k, v) for k, v in start["headers"] if k.lower() != b"content-length"]
                hdrs.append((b"content-length", str(len(body)).encode()))
                await send({**start, "headers": hdrs})
                await send({"type": "http.response.body", "body": body, "more_body": False})
            else:
                await send(message)

        await self.app(scope, receive, send_wrapper)
