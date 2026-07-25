"""Configuration: parse and validate the environment exactly once.

All env reads live here behind a frozen `Settings` so the rest of the package
takes typed values, not `os.environ` lookups scattered across modules. Build it
with `Settings.from_env()` (done by `create_app`); a missing required var fails
fast with an actionable message instead of a bare `KeyError` mid-import.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# Load mcp/.env.local (then mcp/.env) for local dev, mirroring the backend's
# .env.local convention. load_dotenv does NOT override real environment variables,
# so injected container/host/Lambda env always wins. Done at import so the values
# are present before Settings.from_env() reads them. __file__ is mcp/looped_in_mcp/
# config.py, so the env files sit one directory up (the mcp/ root).
_MCP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(_MCP_DIR, ".env.local"))
load_dotenv(os.path.join(_MCP_DIR, ".env"))

# ".invalid" is reserved (RFC 6761) and never resolves — a safe placeholder origin
# baked into the OAuth metadata at boot and rewritten per request when the public
# URL is dynamic (an API Gateway endpoint / ngrok tunnel). See middleware.py.
SENTINEL_ORIGIN = "https://mcp.looped-in.invalid"


@dataclass(frozen=True)
class Settings:
    """Validated, immutable runtime configuration."""

    # Clerk Frontend API URL — the OAuth issuer, e.g. https://<slug>.clerk.accounts.dev
    # (Clerk Dashboard → API Keys → "Frontend API URL"). The same value the Looped In
    # backend uses as Clerk__Authority; the JWT issuer and the base for JWKS discovery.
    clerk_issuer: str
    # Clerk does NOT put an `aud` claim on its OAuth access tokens, so this is None
    # unless Clerk is configured to emit one — then JWTVerifier validates signature +
    # issuer + expiry only.
    clerk_audience: str | None
    # Looped In .NET API base URL that API-wrapping tools forward the caller's token to.
    # None locally when unset (no backend) — whoami still works; tools needing it fail
    # with a clear message instead of an AttributeError.
    backend_url: str | None
    # Public base URL baked into the OAuth Protected Resource Metadata. Either the
    # explicit SERVER_BASE_URL (a pinned canonical URL) or the sentinel, which the
    # middleware rewrites per request. `rewrite_public_url` is True in the latter case.
    server_base_url: str
    rewrite_public_url: bool
    # When non-empty, the only Host values the middleware will rewrite the public URL
    # to. Empty (the default) accepts any syntactically valid host — required in the
    # cloud, where the gateway domain is not knowable at deploy time.
    allowed_public_hosts: frozenset[str]
    host: str
    port: int

    @classmethod
    def from_env(cls) -> "Settings":
        issuer = os.environ.get("CLERK_ISSUER")
        if not issuer:
            raise RuntimeError(
                "CLERK_ISSUER is required (the Clerk Frontend API URL, e.g. "
                "https://<slug>.clerk.accounts.dev). Set it in mcp/.env.local for "
                "local dev; infra/services/mcp.ts injects it from the ClerkAuthority "
                "secret in the cloud."
            )
        # A BLANK value must mean "unset", not "pin the empty string". Reading this as
        # `is None` would leave server_base_url on the unresolvable sentinel AND switch
        # the rewrite off, so every client's OAuth discovery would point at a host that
        # can never resolve — a silent handshake failure. Blanking the line is exactly
        # how a person "unsets" a dotenv key, and .env.example ships it set, so this is
        # the likely mistake, not an exotic one.
        explicit_base = (os.environ.get("SERVER_BASE_URL") or "").strip() or None
        return cls(
            clerk_issuer=issuer.rstrip("/"),
            clerk_audience=os.environ.get("CLERK_AUDIENCE") or None,
            backend_url=(os.environ.get("BACKEND_URL") or "").rstrip("/") or None,
            server_base_url=(explicit_base or SENTINEL_ORIGIN).rstrip("/"),
            rewrite_public_url=explicit_base is None,
            allowed_public_hosts=frozenset(
                host.strip().lower()
                for host in (os.environ.get("ALLOWED_PUBLIC_HOSTS") or "").split(",")
                if host.strip()
            ),
            host=os.environ.get("HOST", "0.0.0.0"),
            port=int(os.environ.get("PORT", "8000")),
        )
