"""
Web API endpoints for Open-Inspect Modal functions.

These endpoints expose Modal functions as HTTP APIs that can be called
from the control plane (Cloudflare Workers).

Note: These endpoints call the underlying Python logic directly rather than
using .remote() to avoid nested Modal function calls.

SECURITY: All sensitive endpoints require authentication via HMAC-signed tokens.
The control plane must include an Authorization header with a valid token.
"""

import os
import time
from typing import Any, cast

from fastapi import Header, HTTPException
from modal import fastapi_endpoint

from .app import (
    app,
    function_image,
    github_app_secrets,
    internal_api_secret,
    validate_server_url,
)
from .auth import AuthConfigurationError, verify_internal_token
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("web_api")

RequestBody = dict[str, Any]
ResponseBody = dict[str, Any]


def _optional_str(request: RequestBody, key: str) -> str | None:
    value = request.get(key)
    return value if isinstance(value, str) else None


def _str_value(request: RequestBody, key: str, default: str = "") -> str:
    value = request.get(key, default)
    return value if isinstance(value, str) else default


def _optional_str_dict(request: RequestBody, key: str) -> dict[str, str] | None:
    value = request.get(key)
    if not isinstance(value, dict):
        return None
    return {str(k): str(v) for k, v in value.items() if v is not None}


def _optional_any_dict(request: RequestBody, key: str) -> dict[str, Any] | None:
    value = request.get(key)
    return value if isinstance(value, dict) else None


def require_auth(authorization: str | None) -> None:
    """
    Verify authentication, raising HTTPException on failure.

    Args:
        authorization: The Authorization header value

    Raises:
        HTTPException: 401 if authentication fails, 503 if auth is misconfigured
    """
    try:
        if not verify_internal_token(authorization):
            raise HTTPException(
                status_code=401,
                detail="Unauthorized: Invalid or missing authentication token",
            )
    except AuthConfigurationError as e:
        # Auth system is misconfigured - this is a server error, not client error
        raise HTTPException(
            status_code=503,
            detail=f"Service unavailable: Authentication not configured. {e}",
        )


def _resolve_clone_token() -> str | None:
    """Resolve a VCS clone token based on SCM_PROVIDER.

    - "gitlab": reads GITLAB_ACCESS_TOKEN from the environment.
    - "github" (default): generates a short-lived GitHub App installation token.

    Returns None if credentials are missing or token generation fails.
    """
    from .auth import generate_installation_token

    scm_provider = os.environ.get("SCM_PROVIDER", "github")

    if scm_provider == "gitlab":
        token = os.environ.get("GITLAB_ACCESS_TOKEN")
        if not token:
            log.warn("gitlab.token_missing")
        return token

    try:
        app_id = os.environ.get("GITHUB_APP_ID")
        private_key = os.environ.get("GITHUB_APP_PRIVATE_KEY")
        installation_id = os.environ.get("GITHUB_APP_INSTALLATION_ID")

        if app_id and private_key and installation_id:
            return cast(
                "str",
                generate_installation_token(
                    app_id=app_id,
                    private_key=private_key,
                    installation_id=installation_id,
                ),
            )
    except Exception as e:
        log.warn("github.token_error", exc=e)

    return None


def require_valid_server_url(url: str | None) -> None:
    """
    Validate server_url, raising HTTPException on failure.

    Args:
        url: The control plane URL to validate

    Raises:
        HTTPException: 400 if URL is invalid
    """
    if url and not validate_server_url(url):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid server_url: {url}. URL must match allowed patterns.",
        )


@app.function(
    image=function_image,
    secrets=[github_app_secrets, internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_create_sandbox(
    request: RequestBody,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> ResponseBody:
    """
    HTTP endpoint to create a sandbox.

    Requires authentication via Authorization header.

    POST body:
    {
        "session_id": "...",
        "sandbox_id": "...",  // Optional: expected sandbox ID from control plane
        "repo_owner": "...",
        "repo_name": "...",
        "server_url": "...",
        "sandbox_auth_token": "...",
        "snapshot_id": null,
        "provider": "anthropic",
        "model": "claude-sonnet-4-6"
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    server_url = _str_value(request, "server_url")
    require_valid_server_url(server_url)

    try:
        # Import types and manager directly
        from .sandbox import SessionConfig
        from .sandbox.manager import SandboxConfig, SandboxManager

        manager = SandboxManager()

        clone_token = _resolve_clone_token()

        session_config = SessionConfig(
            session_id=_optional_str(request, "session_id"),
            repo_owner=_str_value(request, "repo_owner"),
            repo_name=_str_value(request, "repo_name"),
            branch=_optional_str(request, "branch"),
            opencode_session_id=_optional_str(request, "opencode_session_id"),
            provider=_str_value(request, "provider", "anthropic"),
            model=_str_value(request, "model", "claude-sonnet-4-6"),
            mcp_servers=request.get("mcp_servers"),
        )

        config = SandboxConfig(
            repo_owner=_str_value(request, "repo_owner"),
            repo_name=_str_value(request, "repo_name"),
            sandbox_id=_optional_str(
                request, "sandbox_id"
            ),  # Use control-plane-provided ID for auth
            snapshot_id=_optional_str(request, "snapshot_id"),
            session_config=session_config,
            server_url=server_url,
            sandbox_auth_token=_str_value(request, "sandbox_auth_token"),
            clone_token=clone_token,
            user_env_vars=_optional_str_dict(request, "user_env_vars"),
            repo_image_id=_optional_str(request, "repo_image_id"),
            repo_image_sha=_optional_str(request, "repo_image_sha"),
            code_server_enabled=bool(request.get("code_server_enabled", False)),
            settings=_optional_any_dict(request, "sandbox_settings"),
        )

        handle = await manager.create_sandbox(config)

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,  # Modal's internal ID for snapshot API
                "status": handle.status.value,
                "created_at": handle.created_at,
                "code_server_url": handle.code_server_url,
                "code_server_password": handle.code_server_password,
                "ttyd_url": handle.ttyd_url,
                "tunnel_urls": handle.tunnel_urls,
            },
        }
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_create_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_create_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_create_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_warm_sandbox(
    request: RequestBody,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> ResponseBody:
    """
    HTTP endpoint to warm a sandbox.

    Requires authentication via Authorization header.

    POST body:
    {
        "repo_owner": "...",
        "repo_name": "...",
        "server_url": "..."
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    server_url = _str_value(request, "server_url")
    require_valid_server_url(server_url)

    try:
        from .sandbox.manager import SandboxManager

        manager = SandboxManager()
        handle = await manager.warm_sandbox(
            repo_owner=_str_value(request, "repo_owner"),
            repo_name=_str_value(request, "repo_name"),
            server_url=server_url,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "status": handle.status.value,
            },
        }
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_warm_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_warm_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_warm_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(image=function_image)
@fastapi_endpoint(method="GET")
def api_health() -> ResponseBody:
    """Health check endpoint. Does not require authentication."""
    return {"success": True, "data": {"status": "healthy", "service": "open-inspect-modal"}}


@app.function(image=function_image, secrets=[internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_snapshot_sandbox(
    request: RequestBody,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> ResponseBody:
    """
    Take a filesystem snapshot of a running sandbox using Modal's native API.

    Requires authentication via Authorization header.

    This creates a point-in-time copy of the sandbox's filesystem that can be
    used to restore the sandbox later. The snapshot is stored as a Modal Image
    and persists indefinitely.

    POST body:
    {
        "sandbox_id": "...",
        "session_id": "...",
        "reason": "execution_complete" | "pre_timeout" | "heartbeat_timeout"
    }

    Returns:
    {
        "success": true,
        "data": {
            "image_id": "...",
            "sandbox_id": "...",
            "session_id": "...",
            "reason": "..."
        }
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    sandbox_id = request.get("sandbox_id")
    if not sandbox_id:
        raise HTTPException(status_code=400, detail="sandbox_id is required")

    try:
        from .sandbox.manager import SandboxManager

        session_id = request.get("session_id")
        reason = request.get("reason", "manual")

        manager = SandboxManager()

        # Get the sandbox handle by ID
        handle = await manager.get_sandbox_by_id(sandbox_id)
        if not handle:
            raise HTTPException(status_code=404, detail=f"Sandbox not found: {sandbox_id}")

        # Take filesystem snapshot using Modal's native API (sync method)
        image_id = manager.take_snapshot(handle)

        return {
            "success": True,
            "data": {
                "image_id": image_id,
                "sandbox_id": sandbox_id,
                "session_id": session_id,
                "reason": reason,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_snapshot_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_snapshot_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_snapshot_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id or sandbox_id,
        )


@app.function(image=function_image, secrets=[github_app_secrets, internal_api_secret])
@fastapi_endpoint(method="POST")
async def api_restore_sandbox(
    request: RequestBody,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
    x_session_id: str | None = Header(None),
    x_sandbox_id: str | None = Header(None),
) -> ResponseBody:
    """
    Create a new sandbox from a filesystem snapshot.

    Requires authentication via Authorization header.

    This restores a sandbox from a previously taken snapshot Image,
    allowing the session to resume with full workspace state intact.
    Git clone is skipped since the workspace already contains all changes.

    POST body:
    {
        "snapshot_image_id": "...",
        "session_config": {
            "session_id": "...",
            "repo_owner": "...",
            "repo_name": "...",
            "provider": "anthropic",
            "model": "claude-sonnet-4-6"
        },
        "sandbox_id": "...",
        "server_url": "...",
        "sandbox_auth_token": "..."
    }

    Returns:
    {
        "success": true,
        "data": {
            "sandbox_id": "...",
            "status": "warming"
        }
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    server_url = request.get("server_url", "")
    require_valid_server_url(server_url)

    snapshot_image_id = request.get("snapshot_image_id")
    if not snapshot_image_id:
        raise HTTPException(status_code=400, detail="snapshot_image_id is required")

    try:
        from .sandbox.manager import DEFAULT_SANDBOX_TIMEOUT_SECONDS, SandboxManager

        session_config = request.get("session_config", {})
        sandbox_id = request.get("sandbox_id")
        sandbox_auth_token = request.get("sandbox_auth_token", "")
        user_env_vars = request.get("user_env_vars") or None
        timeout_seconds = int(request.get("timeout_seconds", DEFAULT_SANDBOX_TIMEOUT_SECONDS))

        manager = SandboxManager()
        clone_token = _resolve_clone_token()

        code_server_enabled = bool(request.get("code_server_enabled", False))
        sandbox_settings = request.get("sandbox_settings") or None

        # Restore sandbox from snapshot
        handle = await manager.restore_from_snapshot(
            snapshot_image_id=snapshot_image_id,
            session_config=session_config,
            sandbox_id=sandbox_id,
            server_url=server_url,
            sandbox_auth_token=sandbox_auth_token,
            clone_token=clone_token,
            user_env_vars=user_env_vars,
            timeout_seconds=timeout_seconds,
            code_server_enabled=code_server_enabled,
            settings=sandbox_settings,
        )

        return {
            "success": True,
            "data": {
                "sandbox_id": handle.sandbox_id,
                "modal_object_id": handle.modal_object_id,
                "status": handle.status.value,
                "code_server_url": handle.code_server_url,
                "code_server_password": handle.code_server_password,
                "ttyd_url": handle.ttyd_url,
                "tunnel_urls": handle.tunnel_urls,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_restore_sandbox")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_restore_sandbox",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_restore_sandbox",
            trace_id=x_trace_id,
            request_id=x_request_id,
            session_id=x_session_id,
            sandbox_id=x_sandbox_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret, github_app_secrets],
)
@fastapi_endpoint(method="POST")
async def api_build_repo_image(
    request: RequestBody,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> ResponseBody:
    """
    Kick off an async image build. Returns immediately.

    Spawns a build_repo_image async worker that will:
    1. Create a build sandbox
    2. Wait for it to finish (git clone + setup)
    3. Snapshot the filesystem
    4. POST the result to callback_url

    POST body:
    {
        "repo_owner": "...",
        "repo_name": "...",
        "default_branch": "main",
        "build_id": "...",
        "callback_url": "..."
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    try:
        from .scheduler.image_builder import build_repo_image

        repo_owner = _optional_str(request, "repo_owner")
        repo_name = _optional_str(request, "repo_name")
        default_branch = _str_value(request, "default_branch", "main")
        build_id = _str_value(request, "build_id")
        callback_url = _str_value(request, "callback_url")
        user_env_vars = _optional_str_dict(request, "user_env_vars")

        if not repo_owner or not repo_name:
            raise HTTPException(status_code=400, detail="repo_owner and repo_name are required")

        if not build_id:
            raise HTTPException(status_code=400, detail="build_id is required")

        # Spawn the async builder — returns immediately
        await build_repo_image.spawn.aio(
            repo_owner=repo_owner,
            repo_name=repo_name,
            default_branch=default_branch,
            callback_url=callback_url,
            build_id=build_id,
            user_env_vars=user_env_vars,
        )

        return {
            "success": True,
            "data": {
                "build_id": build_id,
                "status": "building",
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_build_repo_image")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_build_repo_image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_build_repo_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )


@app.function(
    image=function_image,
    secrets=[internal_api_secret],
)
@fastapi_endpoint(method="POST")
async def api_delete_provider_image(
    request: RequestBody,
    authorization: str | None = Header(None),
    x_trace_id: str | None = Header(None),
    x_request_id: str | None = Header(None),
) -> ResponseBody:
    """
    Delete a single provider image (best-effort).

    Used to clean up old pre-built images after they're replaced by newer builds.

    POST body:
    {
        "provider_image_id": "..."
    }
    """
    start_time = time.time()
    http_status = 200
    outcome = "success"

    require_auth(authorization)

    provider_image_id = request.get("provider_image_id")
    if not provider_image_id:
        raise HTTPException(status_code=400, detail="provider_image_id is required")

    try:
        # Modal doesn't have an explicit delete API for images;
        # images are garbage-collected when no longer referenced.
        # We log the request for auditability.
        log.info(
            "image.delete_requested",
            provider_image_id=provider_image_id,
        )

        return {
            "success": True,
            "data": {
                "provider_image_id": provider_image_id,
                "deleted": True,
            },
        }
    except HTTPException as e:
        outcome = "error"
        http_status = e.status_code
        raise
    except Exception as e:
        outcome = "error"
        http_status = 500
        log.error("api.error", exc=e, endpoint_name="api_delete_provider_image")
        return {"success": False, "error": str(e)}
    finally:
        duration_ms = int((time.time() - start_time) * 1000)
        log.info(
            "modal.http_request",
            http_method="POST",
            http_path="/api_delete_provider_image",
            http_status=http_status,
            duration_ms=duration_ms,
            outcome=outcome,
            endpoint_name="api_delete_provider_image",
            trace_id=x_trace_id,
            request_id=x_request_id,
        )
