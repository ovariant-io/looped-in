"""Self-adapting public URL for a dynamic gateway endpoint / tunnel."""

from __future__ import annotations

_OAUTH_METADATA_PREFIX = "/.well-known/oauth-protected-resource"


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
    """

    def __init__(self, app, sentinel_origin: str) -> None:
        self.app = app
        self._sentinel = sentinel_origin.rstrip("/").encode()

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        host = headers.get(b"host")
        if not host:
            await self.app(scope, receive, send)
            return
        proto = headers.get(b"x-forwarded-proto", b"") or scope.get("scheme", "https").encode()
        origin = proto.split(b",")[0].strip() + b"://" + host
        if origin == self._sentinel:
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
