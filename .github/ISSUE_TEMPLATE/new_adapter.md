---
name: New Agent Adapter
about: Propose or discuss adding a new coding agent adapter
title: "[adapter] "
labels: adapter
assignees: ""
---

## Agent

Which coding agent do you want to add?

- **Name**:
- **Link**:
- **Communication model**: (HTTP server / subprocess pipes / other)

## Why

Why is this agent worth supporting?

## Implementation notes

Any details about how the agent works that are relevant to the adapter:

- How does it receive prompts?
- How does it stream output?
- Does it have a session/state concept?
- What tools does it support?

## Checklist

- [ ] I've read [`docs/AGENT_ADAPTER.md`](../../docs/AGENT_ADAPTER.md)
- [ ] I've looked at the existing adapters in
      [`packages/sandbox-runtime/src/sandbox_runtime/adapters/`](../../packages/sandbox-runtime/src/sandbox_runtime/adapters/)
