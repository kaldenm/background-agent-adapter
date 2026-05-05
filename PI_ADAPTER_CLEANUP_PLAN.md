# Pi Adapter Cleanup Plan

## Overview

The Pi adapter implementation introduced ~3700 lines of code across 12 files. While functional, the
implementation has several areas of complexity that can be simplified without affecting
functionality.

## Analysis Summary

### Current State

- **Pi adapter**: 694 lines (`adapters/pi.py`)
- **OpenCode adapter**: 1243 lines (`adapters/opencode.py`)
- **Bridge**: Extensive backward compat layer with `isinstance(OpenCodeAdapter)` checks
- **Entrypoint**: Mixed generic/adapter-specific logic in `start_opencode()`

### Key Architectural Insight

The core difference is **HTTP server vs RPC subprocess**:

- OpenCode: HTTP server on port 4096, bridge is a client
- Pi: stdin/stdout subprocess, bridge owns the process

This difference is handled correctly, but the bridge has accumulated backward compatibility shims
that can be removed.

---

## Cleanup Opportunities

### 1. Remove Bridge Backward Compat Layer (High Impact)

**Problem**: The bridge has 15+ methods with `isinstance(self.adapter, OpenCodeAdapter)` checks to
maintain backward compatibility with old tests/code that accessed bridge properties directly.

**Current pattern**:

```python
@property
def opencode_session_id(self) -> str | None:
    """Backward compat: delegates to adapter._session_id."""
    return self._session_id

def _transform_part_to_event(self, part: dict, message_id: str):
    """Backward compat: delegates to adapter."""
    if isinstance(self.adapter, OpenCodeAdapter):
        return self.adapter._transform_part_to_event(part, message_id)
    return None
```

**Simplified approach**:

- Remove all `isinstance` checks
- Keep only the adapter interface methods
- Let tests use `adapter.` directly instead of `bridge.adapter.`

**Files affected**:

- `packages/sandbox-runtime/src/sandbox_runtime/bridge.py` (lines 148-275)

**Risk**: Low - these are documented as "backward compat" for tests that can be updated

**Effort**: Medium (need to update ~20 tests that use the old bridge API)

---

### 2. Simplify Entrypoint `start_opencode()` Method (High Impact)

**Problem**: `start_opencode()` in entrypoint.py has two code paths:

1. Generic adapter path (lines 684-692): calls `adapter.install()` and `adapter.start()`
2. OpenCode-specific path (lines 694-776): duplicates OpenCode setup logic

**Current code**:

```python
async def start_opencode(self) -> None:
    # For non-OpenCode adapters, use the generic adapter interface
    if not isinstance(self.adapter, OpenCodeAdapter):
        workdir = self.workspace_path
        if self.repo_path.exists():
            workdir = self.repo_path
        await self.adapter.install(workdir, self.session_config)
        await self.adapter.start(workdir, self.session_config)
        self.agent_ready.set()
        return

    # OpenCode-specific logic follows (80+ lines of duplicated setup)
```

**Simplified approach**:

- Move all OpenCode-specific setup logic INTO `OpenCodeAdapter.install()` and
  `OpenCodeAdapter.start()`
- Make `start_opencode()` truly generic - just call the adapter methods
- Remove the `isinstance` check entirely

**Files affected**:

- `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` (lines 674-776)
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py` (move logic into
  install/start)

**Risk**: Low - OpenCodeAdapter already has install/start, we're just moving code

**Effort**: Medium (refactor ~80 lines from entrypoint to adapter)

---

### 3. Remove Dual Session ID Tracking (Medium Impact)

**Problem**: Session ID is tracked in two places:

- `bridge._session_id` (bridge-level state)
- `adapter._session_id` (adapter-level state, OpenCode-specific)

The bridge has properties to sync these:

```python
@property
def opencode_session_id(self) -> str | None:
    return self._session_id

@opencode_session_id.setter
def opencode_session_id(self, value: str | None):
    self._session_id = value
    if isinstance(self.adapter, OpenCodeAdapter):
        self.adapter._session_id = value
```

**Simplified approach**:

- Keep `bridge._session_id` as the source of truth
- Remove `adapter._session_id` from OpenCodeAdapter
- Pass session ID via method parameters instead of storing in adapter

**Files affected**:

- `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py`

**Risk**: Medium - affects OpenCodeAdapter internal state management

**Effort**: Low-Medium (update ~10 places)

---

### 4. Simplify Adapter Registry (Low Impact)

**Problem**: The `load_adapter()` function in `__init__.py` has a growing if/else chain:

```python
def load_adapter(name: str) -> AgentAdapter:
    if name == "opencode":
        from .opencode import OpenCodeAdapter
        return OpenCodeAdapter()
    if name == "pi":
        from .pi import PiAdapter
        return PiAdapter()
    raise ValueError(f"Unknown agent adapter: {name}")
```

**Simplified approach**:

```python
_ADAPTERS: dict[str, type[AgentAdapter]] = {}

def register_adapter(name: str, adapter_class: type[AgentAdapter]) -> None:
    _ADAPTERS[name] = adapter_class

def load_adapter(name: str) -> AgentAdapter:
    if name not in _ADAPTERS:
        raise ValueError(f"Unknown agent adapter: {name}")
    return _ADAPTERS[name]()

# In each adapter file:
register_adapter("opencode", OpenCodeAdapter)
```

**Files affected**:

- `packages/sandbox-runtime/src/sandbox_runtime/adapters/__init__.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py`

**Risk**: None - purely internal refactoring

**Effort**: Low (20 lines total)

---

### 5. Consolidate Tool/Skill Installation (Medium Impact)

**Problem**: Both entrypoint.py and PiAdapter have `_install_tools()`, `_install_skills()`, and
`_install_bin_scripts()` methods with near-identical logic.

**Duplication**:

- `entrypoint._install_tools()` - for OpenCode (lines 302-341)
- `entrypoint._install_skills()` - for OpenCode (lines 360-381)
- `entrypoint._install_bin_scripts()` - for OpenCode (lines 342-358)
- `pi_adapter._install_skills()` - for Pi (lines 660-682)
- `pi_adapter._install_bin_scripts()` - for Pi (lines 683-695)

**Simplified approach**:

- Move these methods to a shared `sandbox_runtime/install.py` module
- All adapters call the shared functions
- Parameterize for adapter-specific paths (e.g., `.opencode/` vs `.pi/`)

**Files affected**:

- `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` (remove ~80 lines)
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py` (remove ~40 lines)
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py` (call shared functions)
- `packages/sandbox-runtime/src/sandbox_runtime/install.py` (new file, ~100 lines)

**Risk**: Low - consolidating identical logic

**Effort**: Medium (new file + updates to 3 files)

### 6. Make AGENT_ADAPTER Configurable (Low Impact)

**Problem**: `AGENT_ADAPTER: 'pi'` is hardcoded in `daytona-provider.ts`:

```typescript
// packages/control-plane/src/sandbox/providers/daytona-provider.ts
buildEnvVars() {
  return {
    // ... other vars
    AGENT_ADAPTER: 'pi',  // Hardcoded!
  }
}
```

**Impact**:

- Can't switch back to OpenCode without redeploying control plane
- Can't test different adapters in production
- No per-repo or per-session adapter selection

**Simplified approach**:

- Add Cloudflare Worker env var: `DEFAULT_AGENT_ADAPTER` (default: 'pi')
- Optionally: add per-repo setting in D1
- Remove hardcoded value from provider

**Files affected**:

- `packages/control-plane/src/sandbox/providers/daytona-provider.ts` (1 line)
- `terraform/` (add DEFAULT_AGENT_ADAPTER variable)
- `wrangler.production.jsonc` (add variable)

**Risk**: None - purely configuration change

**Effort**: Low (10 lines total)

### 7. Rename opencode_session_id to agent_session_id (Medium-High Impact)

**Problem**: Database columns, TypeScript types, and session state all reference "opencode" even
though Pi uses the same field:

```
D1 schema: opencode_session_id TEXT
TypeScript: opencode_session_id?: string
Session state: opencode_session_id: string | null
```

**Confusion**:

- New developers think this is OpenCode-specific
- Pi uses it but it's named after a different agent
- Unclear ownership and purpose

**Simplified approach**:

- D1 migration: rename column `opencode_session_id` → `agent_session_id`
- TypeScript: rename all references across packages
- Control plane: update query and mutation logic
- Keep backward compat during migration (read both, write to new)

**Files affected**:

- `packages/shared/src/types/index.ts` (session types)
- `packages/control-plane/src/session/durable-object.ts` (session logic)
- `packages/control-plane/src/sandbox/providers/daytona-provider.ts` (env vars)
- `terraform/d1/migrations/` (new migration)
- `packages/control-plane/src/session/` (all session-related files)

**Risk**: Medium-High (database migration required)

- Requires migration script
- Must handle existing sessions
- Potential for data loss if migration fails

**Effort**: High (affects multiple packages + database)

### 8. Consolidate Deployment Paths (Medium Impact)

**Problem**: Two deployment mechanisms exist:

1. **Terraform** (`terraform/` directory):
   - Deploys Cloudflare Workers, D1, KV, etc.
   - Infrastructure as code
   - Requires Terraform installation

2. **wrangler.production.jsonc**:
   - Direct Cloudflare Workers deployment
   - Manual secrets management
   - No Terraform dependency

**Current state**:

- Pi adapter was deployed via wrangler.production.jsonc
- Terraform config exists but wasn't used for recent deployments
- Duplicate configuration

**Simplified approach**: **Option A (Recommended)**: Keep wrangler.production.jsonc

- Remove terraform/ directory
- Document deployment via `wrangler deploy`
- Simpler workflow, no Terraform dependency

**Option B**: Keep Terraform

- Remove wrangler.production.jsonc
- Require Terraform for all deployments
- Better for infrastructure as code, but more complex

**Files affected**:

- Either remove `terraform/` or `wrangler.production.jsonc`
- Update documentation
- Update CI/CD pipelines

**Risk**: Medium (deployment path change)

- Could break existing deployment scripts
- Requires updating team documentation
- CI/CD changes needed

**Effort**: Medium (cleanup + documentation)

---

## Proposed Implementation Order

### Phase 1: Low-Risk Cleanups (Can be done independently)

1. **Simplify adapter registry** (#4)
   - Changes only internal adapter loading
   - No behavior changes
   - Easy to verify with existing tests

2. **Consolidate tool/skill installation** (#5)
   - Extracts shared utilities
   - Reduces duplication
   - Tests should pass without modification

3. **Make AGENT_ADAPTER configurable** (#6)
   - Remove hardcoded `AGENT_ADAPTER: 'pi'` from daytona-provider.ts
   - Add Cloudflare env var or per-repo setting
   - Allows easy flipping between adapters without redeploy

### Phase 2: Medium-Risk Cleanups (Require test updates)

4. **Remove dual session ID tracking** (#3)
   - Requires updating OpenCodeAdapter tests
   - Changes internal state management
   - Behavior unchanged from external perspective

5. **Simplify entrypoint `start_opencode()`** (#2)
   - Moves code from entrypoint to OpenCodeAdapter
   - Requires updating entrypoint tests
   - Makes entrypoint truly adapter-agnostic

### Phase 3: High-Risk Cleanups (Comprehensive refactoring)

6. **Remove bridge backward compat layer** (#1)
   - Most extensive changes
   - Requires updating all bridge tests
   - Biggest impact on codebase
   - Should be done last after other cleanups are verified

### Phase 4: Naming & Deployment Cleanups

7. **Rename opencode_session_id to agent_session_id** (#7)
   - Migration across D1 schema, TypeScript types, control plane
   - Improves clarity now that multiple adapters exist
   - Requires D1 migration + type updates across packages

8. **Consolidate deployment paths** (#8)
   - Choose between Terraform vs wrangler.production.jsonc
   - Recommend keeping wrangler.production.jsonc (no Terraform dependency)
   - Remove unused deployment artifacts

---

## Expected Outcomes

### Code Reduction

- **Bridge**: Remove ~120 lines of backward compat code
- **Entrypoint**: Remove ~80 lines of duplicated logic
- **Adapters**: Remove ~40 lines of duplicated installation logic
- **Deployment**: Remove ~200 lines of duplicate terraform/wrangler config (one path removed)
- **Net reduction**: ~440 lines of code
- **Added**: ~100 lines of shared utilities (install.py)
- **Total net**: ~340 lines removed

### Improved Maintainability

1. **Clearer separation of concerns**:
   - Entrypoint: only orchestrates processes
   - Adapters: own their setup and lifecycle
   - Bridge: only handles WebSocket + adapter communication

2. **No backward compat shims**:
   - Bridge uses adapter interface directly
   - No `isinstance` checks
   - Tests use adapter methods directly

3. **Shared utilities**:
   - Tool/skill/bin installation in one place
   - Easier to add new adapters
   - Consistent behavior across adapters

4. **Better naming**:
   - `agent_session_id` instead of `opencode_session_id`
   - Clear that any adapter can use it
   - Less confusing for new developers

5. **Simplified deployment**:
   - Single deployment path (wrangler or Terraform)
   - No duplicate configuration
   - Clearer documentation

6. **Configurable adapter selection**:
   - Easy to switch between adapters without redeploy
   - Per-repo adapter configuration possible
   - Better testing workflow

### Test Improvements

- Tests will be more explicit (using `adapter.` instead of `bridge.adapter.`)
- Better isolation (adapter tests don't depend on bridge internals)
- Easier to test new adapters (no special bridge handling needed)
- Clearer test intent (testing adapter behavior, not bridge internals)

---

## Risk Assessment

| Cleanup                          | Risk        | Test Changes | Breaking Changes   | DB Migration |
| -------------------------------- | ----------- | ------------ | ------------------ | ------------ |
| #1: Bridge backward compat       | Low         | ~20 tests    | No (tests updated) | No           |
| #2: Entrypoint start_opencode    | Low         | ~5 tests     | No                 | No           |
| #3: Dual session ID tracking     | Medium      | ~10 tests    | No                 | No           |
| #4: Adapter registry             | None        | 0 tests      | No                 | No           |
| #5: Consolidate installation     | Low         | ~5 tests     | No                 | No           |
| #6: Configurable AGENT_ADAPTER   | None        | 0 tests      | No                 | No           |
| #7: Rename opencode_session_id   | Medium-High | ~15 tests    | No (migration)     | Yes          |
| #8: Consolidate deployment paths | Medium      | 0 tests      | No (CI/CD only)    | No           |

**Overall Risk**: **Medium** - Most cleanups are low-risk, but #7 requires a database migration and
#8 affects deployment infrastructure.

### Risk Mitigation

- **Phase 1-2**: Can be done safely with test coverage
- **Phase 3**: Requires careful test updates but no data changes
- **Phase 4 (#7)**: Requires migration plan, testing in staging first
- **Phase 4 (#8)**: Document deployment process, update team docs

---

## Success Criteria

1. All existing tests pass after each phase
2. No changes to public API (adapter interface, bridge interface)
3. Pi adapter continues to work in production
4. OpenCode adapter continues to work as before
5. Code is more maintainable and easier to understand for new adapters
6. Deployment process is simplified (single path)
7. Naming reflects multi-adapter architecture (agent_session_id)
8. Adapter selection is configurable without code changes

---

## Detailed Cleanup Items

### Item 1: Remove Bridge Backward Compat Layer

**Files to modify:**

- `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`

**Methods to remove (all marked "Backward compat"):**

- `opencode_session_id` property (getter/setter)
- `_sync_adapter_http_client()`
- `sse_inactivity_timeout` property (getter/setter)
- `_transform_part_to_event()`
- `_build_prompt_request_body()`
- `_stream_opencode_response_sse()`
- `_fetch_final_message_state()`
- `_extract_error_message()` (static)
- `_create_opencode_session()`
- `_request_opencode_stop()`
- `_load_session_id()`
- `_save_session_id()`

**Tests to update:**

- Any test calling `bridge.opencode_session_id` → `bridge._session_id`
- Any test calling `bridge._transform_part_to_event()` → `adapter._transform_part_to_event()`
- Any test calling `bridge._create_opencode_session()` → `adapter.create_session()`
- etc.

**Verification:**

- Run `npm test -w @open-inspect/sandbox-runtime`
- Ensure all bridge tests pass with adapter interface

---

### Item 2: Simplify Entrypoint start_opencode()

**Files to modify:**

- `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` (remove ~80 lines)
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py` (add ~80 lines)

**Code to move from entrypoint to OpenCodeAdapter:**

```python
# From entrypoint.start_opencode() (lines 694-776):
# - _setup_openai_oauth()
# - Build opencode_config dict
# - Register custom models
# - Install MCP packages
# - Build MCP config
# - _install_tools()
# - _install_skills()
# - _install_bin_scripts()
# - Deploy codex-auth-plugin
# - Start opencode subprocess
# - Store process in adapter
# - _forward_opencode_logs()
# - _wait_for_health()
```

**New entrypoint.start_opencode():**

```python
async def start_opencode(self) -> None:
    """Start agent server via adapter."""
    workdir = self.workspace_path
    if self.repo_path.exists() and (self.repo_path / ".git").exists():
        workdir = self.repo_path

    await self.adapter.install(workdir, self.session_config)
    await self.adapter.start(workdir, self.session_config)
    self.agent_ready.set()
    self.log.info("agent.ready", adapter=type(self.adapter).__name__)
```

**Tests to update:**

- Entry point tests that mock `start_opencode()` internals
- Tests that expect OpenCode-specific behavior in entrypoint

**Verification:**

- Run entrypoint tests
- Run integration tests with real OpenCode adapter
- Ensure OpenCode still starts correctly

---

### Item 3: Remove Dual Session ID Tracking

**Files to modify:**

- `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py`

**Changes:**

1. Remove `OpenCodeAdapter._session_id` attribute
2. Remove `OpenCodeAdapter._session_id_file` attribute
3. Pass session_id as parameter to adapter methods
4. Bridge keeps `bridge._session_id` as source of truth
5. Update `OpenCodeAdapter.create_session()` to return session_id (doesn't store it)
6. Update `OpenCodeAdapter.send_prompt()` to accept session_id parameter
7. Update `OpenCodeAdapter.stop()` to accept session_id parameter

**Tests to update:**

- Tests that access `adapter._session_id` directly
- Tests that mock session ID state in adapter

**Verification:**

- Run adapter tests
- Run integration tests
- Verify session persistence works

---

### Item 4: Simplify Adapter Registry

**Files to modify:**

- `packages/sandbox-runtime/src/sandbox_runtime/adapters/__init__.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py`

**New registry implementation:**

```python
# __init__.py
from typing import type as type_type
from .base import AgentAdapter

_ADAPTERS: dict[str, type_type[AgentAdapter]] = {}

def register_adapter(name: str, adapter_class: type_type[AgentAdapter]) -> None:
    """Register an adapter class."""
    _ADAPTERS[name] = adapter_class

def load_adapter(name: str) -> AgentAdapter:
    """Load an agent adapter by name."""
    if name not in _ADAPTERS:
        raise ValueError(f"Unknown agent adapter: {name}")
    return _ADAPTERS[name]()

__all__ = ["AgentAdapter", "load_adapter", "register_adapter"]

# opencode.py (at bottom)
from . import register_adapter
register_adapter("opencode", OpenCodeAdapter)

# pi.py (at bottom)
from . import register_adapter
register_adapter("pi", PiAdapter)
```

**Verification:**

- Run all adapter tests
- Test loading unknown adapter raises error
- Test loading known adapter works

---

### Item 5: Consolidate Tool/Skill Installation

**Files to create:**

- `packages/sandbox-runtime/src/sandbox_runtime/install.py` (new file)

**Files to modify:**

- `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/pi.py`
- `packages/sandbox-runtime/src/sandbox_runtime/adapters/opencode.py`

**New shared utilities:**

```python
# install.py
def install_tools(workdir: Path, adapter_name: str) -> None:
    """Copy custom tools into adapter-specific tool directory."""
    tool_dir = workdir / f".{adapter_name}" / "tool"
    # ... implementation

def install_skills(workdir: Path, adapter_name: str) -> None:
    """Copy bundled skills into adapter-specific skills directory."""
    skills_source = Path("/app/sandbox_runtime/skills")
    skills_dest = workdir / f".{adapter_name}" / "agent" / "skills"
    # ... implementation

def install_bin_scripts() -> None:
    """Install standalone CLI scripts into /usr/local/bin."""
    # ... implementation
```

**Adapter changes:**

```python
# Both adapters call:
from ..install import install_tools, install_skills, install_bin_scripts

async def install(self, workdir: Path, session_config: dict) -> None:
    install_tools(workdir, "opencode")  # or "pi"
    install_skills(workdir, "opencode")  # or "pi"
    install_bin_scripts()
```

**Verification:**

- Run all adapter tests
- Verify tools/skills installed in correct directories
- Test with both OpenCode and Pi

---

### Item 6: Make AGENT_ADAPTER Configurable

**Files to modify:**

- `packages/control-plane/src/sandbox/providers/daytona-provider.ts`
- `terraform/variables.tf` (if keeping Terraform)
- `wrangler.production.jsonc` (if using wrangler)

**Changes:**

```typescript
// daytona-provider.ts
buildEnvVars() {
  return {
    // ... other vars
    AGENT_ADAPTER: process.env.DEFAULT_AGENT_ADAPTER || 'pi',
  }
}
```

**Terraform variable:**

```hcl
variable "default_agent_adapter" {
  type    = string
  default = "pi"
}
```

**Wrangler var:**

```jsonc
{
  "vars": {
    "DEFAULT_AGENT_ADAPTER": "pi",
  },
}
```

**Verification:**

- Deploy with DEFAULT_AGENT_ADAPTER=pi
- Deploy with DEFAULT_AGENT_ADAPTER=opencode
- Verify correct adapter is used in sandbox

---

### Item 7: Rename opencode_session_id to agent_session_id

**Files to modify:**

- `packages/shared/src/types/index.ts`
- `packages/control-plane/src/session/durable-object.ts`
- `packages/control-plane/src/sandbox/providers/daytona-provider.ts`
- `terraform/d1/migrations/` (new migration file)
- All files referencing `opencode_session_id`

**Migration steps:**

1. Create D1 migration:

```sql
-- migrate/004_rename_opencode_session_id.sql
ALTER TABLE sessions RENAME COLUMN opencode_session_id TO agent_session_id;
```

2. Update TypeScript types:

```typescript
// shared/src/types/index.ts
export interface SessionState {
  // ...
  agentSessionId: string | null; // was opencodeSessionId
}
```

3. Update control plane logic (find/replace):

- `opencode_session_id` → `agent_session_id`
- `opencodeSessionId` → `agentSessionId`

4. Deploy migration to production
5. Verify existing sessions work
6. Remove any backward compat code

**Verification:**

- Run migration in staging
- Test session creation with new column name
- Test session retrieval with new column name
- Verify Pi and OpenCode both work

---

### Item 8: Consolidate Deployment Paths

**Option A: Keep wrangler.production.jsonc (Recommended)**

**Files to remove:**

- `terraform/` directory (entire directory)

**Files to update:**

- `docs/GETTING_STARTED.md` (update deployment docs)
- `CLAUDE.md` (remove Terraform references)
- CI/CD configuration (if exists)

**New deployment docs:**

```bash
# Deploy control plane
cd packages/control-plane
npx wrangler deploy -c wrangler.production.jsonc

# Set secrets
npx wrangler secret put ANTHROPIC_API_KEY -c wrangler.production.jsonc
# ... other secrets
```

**Option B: Keep Terraform**

**Files to remove:**

- `packages/control-plane/wrangler.production.jsonc`

**Files to update:**

- Deployment documentation
- CI/CD to use Terraform

**Verification:**

- Deploy using chosen method
- Verify all services deployed correctly
- Test in staging environment
- Update team documentation

---

## Next Steps

1. **Review and approve this plan** - Confirm all cleanup items make sense
2. **Prioritize cleanup items** - Decide which phases to tackle first
3. **Start with Phase 1** (low-risk cleanups):
   - Item #4: Simplify adapter registry
   - Item #5: Consolidate tool/skill installation
   - Item #6: Make AGENT_ADAPTER configurable
4. **Proceed to Phase 2** (medium-risk cleanups):
   - Item #3: Remove dual session ID tracking
   - Item #2: Simplify entrypoint start_opencode()
5. **Proceed to Phase 3** (high-risk cleanups):
   - Item #1: Remove bridge backward compat layer
6. **Proceed to Phase 4** (naming & deployment):
   - Item #7: Rename opencode_session_id (requires migration planning)
   - Item #8: Consolidate deployment paths
7. **Final verification**:
   - Run full test suite
   - Integration tests in staging
   - Deploy to production
   - Monitor for issues

---

## Notes

- All cleanup items maintain backward compatibility at the API level
- Tests will need updates but external behavior is unchanged
- Database migration (#7) is the highest-risk item - plan carefully
- Deployment consolidation (#8) is a one-time decision
- Can stop at any phase - each phase delivers value independently
