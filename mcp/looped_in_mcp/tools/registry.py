"""The list of tool modules `create_app()` registers, in order.

Kept explicit (not auto-discovery) so the whole tool surface is greppable and
import order is obvious. To add a domain: write `tools/<domain>.py` with a
`register(mcp, deps)` function, import it here, and append it to TOOL_MODULES.
"""

from __future__ import annotations

from looped_in_mcp.tools import clients, identity

TOOL_MODULES = [
    identity,
    clients,
]
