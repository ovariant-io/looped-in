"""Looped In MCP server package.

The public entry point is `create_app` (see app.py); `server.py` at the mcp/ root
adapts it for local uvicorn and for AWS Lambda. Deliberately empty of side effects
so importing the package never touches the environment or the network.
"""

from __future__ import annotations
