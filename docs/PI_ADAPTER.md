# Pi Adapter

Things I ran into that are specific to Pi.

For the general adapter interface, see [AGENT_ADAPTER.md](./AGENT_ADAPTER.md).

---

## Two-Queue Routing

After the bridge spawns Pi, the adapter sends internal commands to configure it — set model, get
state, create session. These commands and Pi's streaming events (tokens, tool calls, etc.) all come
back on the same stdout pipe.

If you read them into one queue, a command response (like `get_state`) might be sitting behind 500
streaming events. The fix is two queues. A background task (`_read_stdout`) reads every line and
sorts it:

```
stdout line → parse JSON → check type
  ├── "response"              → command queue     (internal commands between adapter and Pi)
  ├── "extension_ui_request"  → auto-approve      (see below)
  └── everything else         → event queue       (streams out to bridge → session → browser)
```

This isn't a subprocess problem in general — it's a Pi thing. A different subprocess agent might
separate its channels differently.

---

## Extension Dialog Auto-Approve

Pi extensions can pop up dialog questions — confirm, select, input. In a normal terminal, a human
answers. In a sandbox, there's no human. If nobody responds, Pi hangs forever.

The adapter auto-responds (`_auto_respond_to_dialog`):

- **confirm** → yes
- **select** → pick first option
- **input/editor** → cancel (can't fake meaningful text)

---

## File

[`packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py`](../packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py)
