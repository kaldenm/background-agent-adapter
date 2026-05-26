"""Agent adapter registry.

Usage:
    from sandbox_runtime.adapters import load_adapter

    adapter = load_adapter("opencode")

See template.py for a starter skeleton when building a new adapter.
"""

from .base import AgentAdapter


def load_adapter(name: str) -> AgentAdapter:
    """Load an agent adapter by name.

    Args:
        name: Adapter identifier (e.g., "opencode").

    Returns:
        An instance of the requested AgentAdapter.

    Raises:
        ValueError: If the adapter name is not recognized.
    """
    if name == "opencode":
        from .opencode import OpenCodeAdapter

        return OpenCodeAdapter()
    if name == "pi":
        from .pi import PiAdapter

        return PiAdapter()
    raise ValueError(f"Unknown agent adapter: {name}")


__all__ = ["AgentAdapter", "load_adapter"]
