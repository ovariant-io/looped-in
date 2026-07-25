"""Shared, process-lifetime resources handed to every tool module's register()."""

from __future__ import annotations

from dataclasses import dataclass

from looped_in_mcp.backend import LoopedInApiClient


@dataclass
class Deps:
    """Container passed to each tool module's `register(mcp, deps)`.

    Carries the Looped In API client — the backend seam — opened in the app
    lifespan and `None` until then (also `None` when no backend is configured,
    e.g. local dev without BACKEND_URL). Add more shared handles here as tools
    need them, rather than constructing resources inside individual tools.
    """

    api: LoopedInApiClient | None = None
