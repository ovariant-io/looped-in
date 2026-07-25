"""Clerk auth wiring: Clerk = OAuth authorization server, this process = resource
server. Validates Clerk-issued JWTs against Clerk's JWKS and advertises Clerk via
/.well-known/oauth-protected-resource (RemoteAuthProvider + JWTVerifier — the
canonical FastMCP setup for DCR-capable identity providers).

This is the same trust chain the .NET API uses (Clerk:Authority → JWKS discovery →
bearer validation), so a token minted for one is understood by the other — which is
what lets a tool forward the caller's token straight through to the API.
"""

from __future__ import annotations

from fastmcp.server.auth import RemoteAuthProvider
from fastmcp.server.auth.providers.jwt import JWTVerifier
from pydantic import AnyHttpUrl

from looped_in_mcp.config import Settings


def build_auth(settings: Settings) -> RemoteAuthProvider:
    """Build the Clerk RemoteAuthProvider from validated settings."""
    token_verifier = JWTVerifier(
        jwks_uri=f"{settings.clerk_issuer}/.well-known/jwks.json",
        issuer=settings.clerk_issuer,
        audience=settings.clerk_audience,
    )
    # `scopes_supported` is load-bearing: MCP clients silently refuse the OAuth
    # handshake when the advertised scope list is empty.
    return RemoteAuthProvider(
        token_verifier=token_verifier,
        authorization_servers=[AnyHttpUrl(settings.clerk_issuer)],
        base_url=settings.server_base_url,
        scopes_supported=["profile", "email", "offline_access"],
    )
