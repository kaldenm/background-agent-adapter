# Entrypoint.py — Cheat Sheet

The entrypoint (`entrypoint.py`, ~1,350 lines) is **PID 1 in the sandbox**. It boots everything up,
monitors for crashes, and shuts everything down.

Most of this file has NOTHING to do with the adapter refactor. It's git sync, code server, ttyd
terminal, setup scripts, etc. The adapter-relevant parts are small.

---

## What this file does (the boot sequence)

```
Phase 1: Git sync        — clone/update the repo
Phase 2: Setup script    — run repo's setup hook (fresh/build boots only)
Phase 3: Start script    — run repo's start hook (all boots)
Phase 3.5: Sidecars      — code-server, ttyd terminal (optional, best-effort)
Phase 4: Start agent     — adapter.install() + adapter.start()    ← ADAPTER CHANGE
Phase 5: Start bridge    — launch bridge subprocess               ← ADAPTER CHANGE
Phase 6: Monitor         — watch for crashes, restart as needed   ← ADAPTER CHANGE
```

---

## What the adapter changed (only 3 spots matter)

### Spot 1: Loading the adapter (line 59-61)

```python
agent_name = os.environ.get("AGENT_ADAPTER", "opencode")
self.adapter = load_adapter(agent_name)
```

On boot, read the env var, load the right adapter. That's how you swap agents.

### Spot 2: Starting the agent (the `start_opencode()` method, line 674)

```python
# For non-OpenCode adapters, use the generic adapter interface
if not isinstance(self.adapter, OpenCodeAdapter):
    await self.adapter.install(workdir, self.session_config)
    await self.adapter.start(workdir, self.session_config)
    self.agent_ready.set()
    return
```

If you're using Pi (or any non-OpenCode agent), this is all that runs:

1. `adapter.install()` — write config files, copy skills
2. `adapter.start()` — validate/launch the agent
3. Signal "agent ready" so the bridge can start

The rest of the method (100+ lines of OpenCode-specific setup) only runs for OpenCode.

**Note:** This `isinstance` check is the same kind of backward-compat mess we cleaned out of
bridge.py. Ideally ALL agents would go through `adapter.install()` + `adapter.start()` and the
OpenCode-specific code would live entirely in opencode.py. It's here because the OpenCode entrypoint
tests still mock the old sub-methods.

### Spot 3: Launching the bridge subprocess (line 820-834)

```python
await self.agent_ready.wait()    # don't start bridge until agent is ready

bridge_env = {
    **os.environ,
    "AGENT_ADAPTER": agent_name,   # tell bridge which adapter to load
    "AGENT_PORT": agent_port,       # tell bridge what port (if any)
}

self.bridge_process = await asyncio.create_subprocess_exec(
    "python", "-m", "sandbox_runtime.bridge", ...
    env=bridge_env,
)
```

The bridge runs as a SEPARATE PROCESS. It loads its own adapter instance from the env var. This is
the two-process architecture: entrypoint and bridge each instantiate the adapter independently.

### Bonus: Crash recovery (line 896)

```python
agent_process = self._opencode_process or self.adapter.get_process()
if agent_process and agent_process.returncode is not None:
    # agent crashed — restart it
    await self.start_opencode()
```

The monitor loop checks if the agent died. If so, restart it.

---

## What's NOT adapter-related (most of the file)

| Section                 | Lines     | What it does                                           |
| ----------------------- | --------- | ------------------------------------------------------ |
| Git sync                | 131-300   | Clone repo, fetch branches, checkout                   |
| Tool/skill installation | 302-380   | Copy tools into .opencode/ (OpenCode-specific, legacy) |
| OAuth setup             | 382-418   | Write OpenAI OAuth config (OpenCode-specific, legacy)  |
| Code server             | 419-458   | Start VS Code in browser                               |
| MCP servers             | 459-560   | Install and configure MCP packages                     |
| ttyd terminal           | 561-636   | Start terminal in browser                              |
| Port waiting            | 637-653   | Utility to wait for a port to be ready                 |
| OpenCode-specific start | 694-780   | Build OpenCode config, launch process, health check    |
| Process monitoring      | 886-980   | Watch all processes, restart on crash                  |
| Boot sequence           | 1240-1330 | Orchestrate all phases                                 |
| Shutdown                | 1338-1380 | Kill everything gracefully                             |

---

## The key insight about entrypoint.py

It's messy because it still has the **old OpenCode code inline** alongside the new adapter calls.
The adapter path (`isinstance` check → `adapter.install()` + `adapter.start()`) is clean and
generic. But the OpenCode path is still the old monolithic code that hasn't been fully extracted
yet.

For Pi, the entrypoint does almost nothing agent-specific — it just calls `adapter.install()` and
`adapter.start()` (3 lines) and moves on. All the Pi-specific logic lives in pi.py where it belongs.

---

## The two-process split (why bridge is a subprocess)

```
Entrypoint (PID 1)           Bridge (child process)
─────────────────────        ──────────────────────────
Loads adapter                Loads its OWN adapter instance
Calls adapter.install()      Calls adapter.configure()
Calls adapter.start()        Calls adapter.load_session_id()
Monitors for crashes         Calls adapter.ensure_session()
Restarts agent if dead       Calls adapter.send_prompt()
Restarts bridge if dead      Calls adapter.stop()
Handles shutdown             Holds WebSocket to control plane
```

They can't share the adapter in memory — they're separate processes. Each reads `AGENT_ADAPTER` from
the environment and creates its own instance.
