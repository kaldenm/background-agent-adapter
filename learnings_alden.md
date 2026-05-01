# Alden's Learnings: Pi Agent Swap

## The Big One: HTTP Server vs RPC Subprocess

This is the core architectural difference when swapping OpenCode for Pi.

### OpenCode = HTTP Server

OpenCode runs as a **standalone server** on localhost:4096. It's independent. It doesn't care who
started it or who's talking to it. Any process can make HTTP requests to it.

```
Entrypoint spawns OpenCode
    └─ OpenCode starts listening on port 4096
    └─ OpenCode is now independent — doesn't need its parent

Bridge (separate process) connects to port 4096
    └─ Makes HTTP requests, reads SSE streams
    └─ Bridge is just a client — replaceable, restartable
```

**Key property:** The communication channel (HTTP/port) is **decoupled** from process ownership.
Anyone can connect. If the bridge dies and a new one starts, it just connects to the same port.
OpenCode doesn't even notice.

### Pi = RPC Subprocess (stdin/stdout pipes)

Pi in RPC mode talks through **pipes** — stdin and stdout. These pipes are physically attached to
whatever process spawned Pi. They're not a port. They're not addressable. They're a direct wire
between parent and child.

```
Bridge spawns Pi
    └─ Pi's stdin is connected to Bridge's write end
    └─ Pi's stdout is connected to Bridge's read end
    └─ These pipes ARE the communication channel

No other process can access these pipes.
If Bridge dies → pipes break → Pi gets SIGPIPE/EOF → Pi dies.
```

**Key property:** The communication channel (pipes) is **coupled** to process ownership. Only the
parent can talk to Pi. If the parent dies, the channel is destroyed, and Pi dies with it.

### Why the bridge MUST spawn Pi

Something code-wise has to surround Pi — read its output, write its input, translate between Pi's
JSON events and the control plane's WebSocket protocol. That "something" is the bridge.

With OpenCode, the bridge was just a client connecting to an existing server. With Pi, the bridge is
the **host** — it spawns Pi, holds the pipes, and is the only thing that can communicate with it.

You can't have the entrypoint spawn Pi and the bridge talk to it, because the bridge can't access
pipes that belong to another process. You'd need to build extra plumbing (named pipes, Unix sockets)
to bridge that gap, and that's complexity for no benefit.

### The Crash Recovery Difference

| Scenario       | OpenCode                                                                                                            | Pi                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Agent crashes  | Bridge still has WebSocket alive. Entrypoint detects crash, restarts OpenCode. Bridge reconnects to new instance.   | Bridge detects stdout EOF. Bridge respawns Pi internally. WebSocket stays alive. Pi reloads session from JSONL file.              |
| Bridge crashes | OpenCode keeps running with full state in memory. Entrypoint restarts bridge. New bridge reconnects — nothing lost. | Pi dies (child of bridge, pipes break). Entrypoint restarts bridge. New bridge spawns new Pi. Pi reloads from JSONL file on disk. |

Both recover fully. The difference is:

- OpenCode survives bridge crashes in memory (faster recovery)
- Pi recovers from disk (slightly slower, but bridge crashes are rare)

### The Supervision Chain

**OpenCode:**

```
Entrypoint monitors:
  ├─ OpenCode process (restarts on crash)
  └─ Bridge process (restarts on crash)
```

**Pi:**

```
Entrypoint monitors:
  └─ Bridge process (restarts on crash)
        └─ Bridge internally monitors Pi subprocess (respawns on crash)
```

Same result, one level of indirection different. The entrypoint doesn't directly see Pi — it just
keeps the bridge alive, and the bridge keeps Pi alive.

---

## Why This Matters for the Adapter Interface

The `AgentAdapter` base class has methods split into "entrypoint methods" and "bridge methods."

For OpenCode:

- `start()` (entrypoint) → spawns the HTTP server
- `send_prompt()` (bridge) → makes HTTP requests to the server

For Pi:

- `start()` (entrypoint) → just validates Pi is installed (no process to spawn yet)
- `configure()` (bridge) → THIS is where Pi gets spawned as a subprocess
- `send_prompt()` (bridge) → writes to Pi's stdin, reads from stdout

The adapter interface still works — it just means the "heavy lifting" moves from the entrypoint side
to the bridge side for Pi.

---

## Summary

The whole thing comes down to one sentence:

> **HTTP is addressable by anyone. Pipes are owned by the parent.**

That one difference cascades into who spawns the agent, who can talk to it, what happens on crash,
and where in the code the lifecycle management lives.
