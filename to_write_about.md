# Things Worth Writing About

Insights from the pluggable agent refactor that are interesting enough to share.

---

## 1. Server vs Subprocess — The Agent Communication Tradeoff

OpenCode runs as a separate HTTP server. Pi runs as a child subprocess of the bridge.

**Server model (OpenCode):**

- Agent exists independently of the bridge
- Bridge crashes → agent keeps running → bridge reconnects
- More resilient, but 1,243 lines of SSE parsing, child session tracking, compaction, dedup
- You're a customer calling a restaurant

**Subprocess model (Pi):**

- Agent only exists because the bridge spawned it
- Bridge dies → agent dies too → must restore from session file on restart
- Fragile to bridge crashes, but dead simple: 400 lines, write JSON in, read JSON out
- You hired someone to sit next to you and pass notes

**The insight:** You don't get to choose. Pi doesn't have a server mode. You work with what the
agent gives you. The adapter pattern lets you support both models behind the same interface — the
bridge doesn't know or care which model it's dealing with. That's the whole point.

**The tradeoff is complexity vs resilience.** OpenCode is harder to integrate but more
fault-tolerant. Pi is trivial to integrate but coupled to the bridge's lifecycle. Both produce the
same 5 event types at the end.

**But actually — it barely matters.** If the bridge dies, the WebSocket to the control plane dies
too. So even with OpenCode still running, in-flight events have nowhere to go. The user sees an
error either way. The only real difference: with OpenCode you don't have to re-spawn the agent on
restart, with Pi you do. But the sandbox filesystem preserves everything already completed — session
files, commits, tool outputs. A retry picks up where you left off. The "server is more resilient"
argument sounds good in theory but the user experience is identical in practice.

---

## 2. The Adapter Layer — Why It's Necessary (Not Just Nice)

Before: 1,700-line bridge with OpenCode baked in. To swap agents, you'd rewrite the bridge.

After: 870-line generic bridge + adapter files. To swap agents, write one file, set one env var.

The adapter isn't clever architecture for its own sake. It's the minimum viable abstraction to make
agent-swapping possible without rewriting the orchestration layer every time.

**The one-file pitch:** implement 13 methods in `adapters/your_agent.py`, register it in
`__init__.py`, set `AGENT_ADAPTER=your_agent`. Done.

---

## 3. The Two-Process Problem

The adapter gets instantiated in TWO separate processes (entrypoint + bridge) doing different jobs.
This wasn't obvious at design time and caused confusion during implementation.

- Entrypoint process: install the agent, start it, monitor for crashes
- Bridge subprocess: talk to the agent, stream events, handle commands

They're separate because they need independent crash/restart lifecycles. If the WebSocket drops, the
bridge restarts without killing the agent. If the agent crashes, the entrypoint restarts it without
killing the bridge.

This means you can't pass objects between them in memory. Each process instantiates its own adapter
from the env var independently.

---

## 4. Snapshot Save/Restore — The Session ID Lifecycle

A snapshot is freezing the sandbox (all files, all state) so it can be restored later. Like saving a
game.

The non-obvious part: the agent's session ID needs to survive this. It lives in three places:

1. Adapter's memory (while running)
2. A file on disk inside the sandbox (survives snapshot/restore)
3. Control plane's database (for bookkeeping)

The lifecycle:

- Agent creates session → writes ID to disk
- Prompt finishes → bridge sends snapshot_ready with session ID → Daytona freezes sandbox
- ...time passes...
- User comes back → control plane tells Daytona "restore" → sandbox unfreezes
- Bridge boots → adapter reads session ID from disk → agent resumes

The bridge doesn't do the freezing. The sandbox provider (Daytona) does. The bridge just provides
the metadata.

---

## 5. The Event Contract — 5 Types, That's It

Whatever the agent does internally (SSE with child sessions and compaction, JSONL with turn events,
gRPC, whatever), by the time events reach the bridge they must be one of:

```
token      — streaming text
tool_call  — agent is using a tool
step_start — reasoning step begins
step_finish — reasoning step ends (with cost/token info)
error      — something went wrong
```

Plus `execution_complete` — but the BRIDGE sends that, not the adapter. This is a trust decision: if
an adapter has a bug and forgets to send "done," the session hangs forever. So the bridge guarantees
it by sending it after the adapter's stream ends.

---

## 6. Backward Compat Tax — The 130 Lines of Shims (Now Deleted)

The initial refactor left behind ~130 lines of `isinstance(self.adapter, OpenCodeAdapter)` shims in
bridge.py — purely so existing tests wouldn't break. Every shim was "if old code calls the old
method name, forward to the adapter."

This was the right call during the refactor (don't rewrite tests at the same time as extraction),
but it made the code confusing to read later. Cleaning it up meant updating tests to call adapter
methods directly, then deleting all shims. Bridge went from 1,011 lines to 870, with zero
`isinstance` checks remaining.

**Lesson:** backward compat shims are fine as a stepping stone, but schedule the cleanup or they
become permanent confusion.

---

## 7. Naming Matters — Exercising Taste

Names I changed because they were confusing to read later:

| Old name                 | New name                          | Why                                                                                                                   |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `create_session()`       | `ensure_session()`                | It resumes OR creates. "Create" is a lie when restoring from a snapshot.                                              |
| `_translate_event()`     | `_convert_pi_event_to_standard()` | "Translate" is vague. This says exactly what it does: Pi format → standard format.                                    |
| `_handle_extension_ui()` | `_auto_respond_to_dialog()`       | "Handle extension UI" is Pi jargon nobody outside Pi understands. The real job: respond to popups so Pi doesn't hang. |

Internal `_` methods still need to be readable by humans. "Internal" doesn't mean "only robots read
this." If you come back in a month and can't tell what a method does from its name, the name is
wrong.

---

## 8. The Adapter Is a Layer So You Don't Play Whack-a-Mole

Without the adapter, swapping agents means changing bridge.py — the file that also manages
WebSockets, reconnection, event buffering, ACKs, git push. You'd be playing whack-a-mole: change one
thing, break three others.

The adapter means: the bridge continues to function exactly as it wants. You're not modifying the
communication layer. You're adding a translation layer underneath it. The bridge never changes when
you swap agents. Only the adapter file changes.

"The adapter adapts the rules of the bridge to make it amendable to whatever the agent needs."

---

## 9. Beautiful Architecture = Knowing Where to Look

Good architecture isn't about everything being simple. It's about being able to look at one layer
and understand it WITHOUT needing to understand the layers below.

- Read bridge.py → understand the flow (check session, send prompt, forward events, send done)
- Want to know HOW Pi talks? → go to pi.py
- Want to know HOW OpenCode streams? → go to opencode.py
- Want to know the contract? → go to base.py

Each file is self-contained. You don't have to hold the whole system in your head. You just need to
know where to look.

---

## 10. "Server Model Is More Resilient" — Not Really

OpenCode runs as a separate server. Pi runs as a subprocess. Conventional wisdom: the server model
is more resilient because if the bridge crashes, the agent survives.

But: if the bridge crashes, the WebSocket to the control plane dies too. In-flight events have
nowhere to go. The user sees an error either way. The only real difference: with OpenCode you don't
re-spawn the agent on restart. With Pi you do. But the sandbox filesystem preserves everything
already completed — session files, commits, tool outputs. A retry picks up where you left off.

The "resilience" advantage is theoretical. The user experience is identical in practice.
