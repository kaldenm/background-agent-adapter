# OpenCode vs Pi — Adapter Comparison

Both implement the same 13-method interface from `base.py`. Same bridge, same control plane, same 5
event types. The difference is HOW they talk to the agent.

---

## The fundamental difference

**OpenCode** = a restaurant. Runs as an HTTP server on localhost:4096. The bridge sends HTTP
requests, gets SSE streams back. Agent exists independently of the bridge.

**Pi** = a person sitting next to you passing notes. Runs as a subprocess. The bridge writes JSON to
stdin, reads JSON from stdout. Agent only exists because the bridge created it.

---

## High-level differences

| Aspect                      | OpenCode                                | Pi                               |
| --------------------------- | --------------------------------------- | -------------------------------- |
| Communication               | HTTP server + SSE streaming             | stdin/stdout JSONL pipes         |
| Who spawns agent            | Entrypoint (start())                    | Adapter (ensure_session())       |
| Agent survives bridge crash | Yes — server keeps running              | No — subprocess dies with bridge |
| Total lines                 | 1,243                                   | 754                              |
| Complexity driver           | Massive ecosystem (MCP, OAuth, plugins) | Lean — just code                 |

---

## Method-by-method comparison

| Method              | OpenCode                                                                                                                       | Pi                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `install()`         | Tools, skills, plugins, OAuth, MCP packages — a lot of ecosystem setup                                                         | Settings file + skills. That's it.                                 |
| `start()`           | Builds config JSON, sets env vars, launches server, waits for health check                                                     | Just runs `pi --version` to confirm binary exists                  |
| `configure()`       | Stores http_client + base_url, resolves SSE timeout from env                                                                   | Ignores both inputs, reads env vars, finds workspace               |
| `ensure_session()`  | Always creates fresh (POST /session)                                                                                           | Spawns process with --session or --no-session depending on restore |
| `send_prompt()`     | ~400 lines: SSE stream, message correlation by parentID, child session tracking, compaction handling, dedup, final state fetch | ~70 lines: write to stdin, wait for ack, read events from queue    |
| `stop()`            | POST /session/{id}/abort                                                                                                       | Write `{"type": "abort"}` to stdin                                 |
| `health_check()`    | HTTP GET to /global/health                                                                                                     | Is the process alive? (returncode is None)                         |
| `load_session_id()` | Read /tmp/opencode-session-id, validate against API                                                                            | Read /tmp/pi-session-path, check file exists                       |
| `shutdown()`        | Terminate process, wait, kill                                                                                                  | Close stdin (signals clean exit), wait, terminate, kill            |

---

## Features only one adapter has

| Feature                     | OpenCode                                           | Pi                                          |
| --------------------------- | -------------------------------------------------- | ------------------------------------------- |
| MCP server support          | Full — installs npm packages, builds config        | None                                        |
| Custom model registry       | CUSTOM_ANTHROPIC_MODELS dict for unreleased models | None                                        |
| OpenAI OAuth                | Writes auth.json, deploys codex-auth-plugin        | None                                        |
| Extension UI auto-respond   | Not a concept                                      | Auto-responds to dialogs so Pi doesn't hang |
| Child session tracking      | Tracks sub-tasks spawned by the agent              | Not a concept                               |
| Session compaction handling | Detects when OpenCode compresses context           | Not a concept                               |
| Message deduplication       | Prevents duplicate events from SSE replays         | Not needed (pipes don't replay)             |

---

## Why OpenCode is 1,243 lines and Pi is 754

It's NOT mainly because OpenCode's communication is harder (though SSE is more complex than pipes).
It's because OpenCode has a massive ecosystem:

- MCP server installation and configuration (~100 lines)
- Custom model registry for unreleased models (~50 lines)
- OpenAI OAuth setup (~40 lines)
- Plugin deployment (~20 lines)
- SSE parsing with child sessions, compaction, and dedup (~400 lines)
- Final state fetch after session idle (~80 lines)

Pi has none of that. It does one thing: write prompt to stdin, read events from stdout, translate
them. The adapter is simple because the agent is simple.

---

## The key insight

The adapter pattern lets both of these wildly different agents plug into the same bridge with the
same interface. The bridge calls `ensure_session()` and `send_prompt()` and gets back the same 5
event types regardless. All the complexity — SSE parsing, pipe management, OAuth, MCP, child
sessions — is hidden inside the adapter files.

That's the whole point: **complexity is contained, not eliminated.** OpenCode is still complex. Pi
is still simple. But the bridge doesn't know or care which one it's talking to.
