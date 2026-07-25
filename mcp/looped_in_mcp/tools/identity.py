"""Identity tools — the scaffold's proof that the auth chain works end to end.

`whoami` proves the near half (MCP client → Clerk → this server): it reads the
verified JWT's own claims and touches nothing else. `my_api_identity` proves the
far half (this server → the .NET API): it forwards the same token to the API's
protected `GET /me`, which validates it independently against Clerk's JWKS. It is
the MCP equivalent of the frontend's /me page — when both tools return your Clerk
user id, the whole trust chain is wired correctly.
"""

from __future__ import annotations

from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from fastmcp.server.dependencies import get_access_token

from looped_in_mcp.deps import Deps
from looped_in_mcp.tools.common import READ_ONLY, caller_token, require_api


def register(mcp: FastMCP, deps: Deps) -> None:
    @mcp.tool(annotations=READ_ONLY)
    def whoami() -> dict:
        """Return identity claims from the caller's verified Clerk JWT.

        Use this first to confirm the MCP client is authenticated against the
        expected Clerk instance before exercising any other tool.
        """
        # Behind RemoteAuthProvider a verified token is always present, so a
        # missing one is a wiring fault, not a user error — surface it cleanly
        # rather than AttributeError. whoami reads the token's *claims* (not the
        # token string common.py's caller_token returns), so it keeps this small
        # inline check instead of reusing that helper.
        access = get_access_token()
        if access is None:
            raise ToolError("No authenticated caller token on the request.")
        claims = access.claims
        return {
            "sub": claims.get("sub"),
            "email": claims.get("email"),
            "issuer": claims.get("iss"),
        }

    @mcp.tool(annotations=READ_ONLY)
    async def my_api_identity() -> dict:
        """Return the identity the Looped In API itself sees for the caller.

        Forwards your Clerk token to the API's protected `GET /me`, which
        validates it against Clerk's JWKS and echoes back the user id, email, and
        claims it read. A successful result proves the MCP server can act on your
        behalf against the API.
        """
        api = require_api(deps)
        return await api.get_json("/me", token=caller_token())
