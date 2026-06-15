"use client";

import { useState, useCallback, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";

// ---------------------------------------------------------------------------
// OAuth constants — must match the server exchange route
// ---------------------------------------------------------------------------
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface SecretsResponse {
  secrets: { key: string }[];
}

type FlowState =
  | { step: "idle" }
  | { step: "authorizing"; verifier: string }
  | { step: "exchanging" }
  | { step: "error"; message: string };

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function AnthropicIntegrationSettings() {
  const { data, isLoading } = useSWR<SecretsResponse>("/api/secrets");

  const hasApiKey = data?.secrets?.some((s) => s.key === "ANTHROPIC_API_KEY") ?? false;
  const hasOAuthToken = data?.secrets?.some((s) => s.key === "ANTHROPIC_OAUTH_TOKEN") ?? false;

  if (isLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">Anthropic</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Use an Anthropic API key for sandbox AI sessions. Claude Code OAuth remains available for
        subscription-based setups.
      </p>

      <div className="space-y-6">
        <Section title="API Key" description="Preferred for direct Anthropic API billing.">
          {hasApiKey ? (
            <ConnectedState label="API key connected" secretKey="ANTHROPIC_API_KEY" />
          ) : (
            <ApiKeyForm />
          )}
        </Section>

        <details className="rounded border border-border-muted p-4">
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Advanced: Claude Code OAuth
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Optional legacy Claude Code subscription auth. API keys are used first when present.
            </p>
            {hasOAuthToken ? (
              <ConnectedState label="Claude Code connected" secretKey="ANTHROPIC_OAUTH_TOKEN" />
            ) : (
              <ConnectFlow />
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected — green dot + disconnect
// ---------------------------------------------------------------------------
function ConnectedState({ label, secretKey }: { label: string; secretKey: string }) {
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/secrets/${encodeURIComponent(secretKey)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        mutate("/api/secrets");
        toast.success("Anthropic disconnected");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
        <span className="text-sm text-foreground">{label}</span>
      </div>
      <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
        {disconnecting ? "Disconnecting..." : "Disconnect"}
      </Button>
    </div>
  );
}

function ApiKeyForm() {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasUnsavedKey = apiKey.trim().length > 0;

  const handleSave = async () => {
    const trimmedApiKey = apiKey.trim();
    if (!trimmedApiKey) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { ANTHROPIC_API_KEY: trimmedApiKey } }),
      });
      const data = await res.json();

      if (res.ok) {
        await mutate("/api/secrets");
        setApiKey("");
        toast.success("Anthropic API key saved");
      } else {
        const message = data.error || "Failed to save API key";
        setError(message);
        toast.error(message);
      }
    } catch {
      setError("Failed to save API key");
      toast.error("Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full ${
            hasUnsavedKey ? "bg-warning" : "bg-muted-foreground"
          }`}
        />
        <span className={`text-sm ${hasUnsavedKey ? "text-warning" : "text-muted-foreground"}`}>
          {hasUnsavedKey ? "Unsaved API key entered" : "No API key saved"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
          placeholder="sk-ant-..."
          className="flex-1 font-mono text-sm"
        />
        <Button size="sm" onClick={handleSave} disabled={!apiKey.trim() || saving}>
          {saving ? "Saving..." : hasUnsavedKey ? "Save entered key" : "Save API key"}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect flow — idle → authorizing → exchanging → done/error
// ---------------------------------------------------------------------------
function ConnectFlow() {
  const [flow, setFlow] = useState<FlowState>({ step: "idle" });
  const [code, setCode] = useState("");

  // Step 1: Generate PKCE and open Anthropic's authorize page
  const handleConnect = useCallback(async () => {
    try {
      const { verifier, challenge } = await generatePKCE();

      const params = new URLSearchParams({
        code: "true",
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope: SCOPES,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: verifier,
      });

      // Store verifier in sessionStorage so it survives accidental refresh
      sessionStorage.setItem("anthropic_oauth_verifier", verifier);

      setFlow({ step: "authorizing", verifier });
      setCode("");

      window.open(
        `${AUTHORIZE_URL}?${params.toString()}`,
        "anthropic-auth",
        "width=550,height=700"
      );
    } catch {
      toast.error("Failed to start authorization");
    }
  }, []);

  // Step 2: Exchange the pasted code for tokens
  const handleExchange = useCallback(async () => {
    const verifier =
      flow.step === "authorizing"
        ? flow.verifier
        : sessionStorage.getItem("anthropic_oauth_verifier");

    if (!verifier) {
      setFlow({
        step: "error",
        message: "Session expired. Please start the connection again.",
      });
      return;
    }

    const trimmedCode = code.trim();
    if (!trimmedCode) return;

    setFlow({ step: "exchanging" });

    try {
      const res = await fetch("/api/auth/anthropic/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmedCode, verifier }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        sessionStorage.removeItem("anthropic_oauth_verifier");
        mutate("/api/secrets");
        setFlow({ step: "idle" });
        setCode("");
        toast.success("Anthropic connected successfully");
      } else {
        setFlow({
          step: "error",
          message:
            data.error || "Token exchange failed. The code may have expired — please try again.",
        });
      }
    } catch {
      setFlow({
        step: "error",
        message: "Network error. Please try again.",
      });
    }
  }, [flow, code]);

  const handleReset = useCallback(() => {
    sessionStorage.removeItem("anthropic_oauth_verifier");
    setFlow({ step: "idle" });
    setCode("");
  }, []);

  // ── Idle ──────────────────────────────────────────────────────────────
  if (flow.step === "idle") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground" />
          <span className="text-sm text-muted-foreground">Not connected</span>
        </div>
        <Button size="sm" onClick={handleConnect}>
          Connect with Anthropic
        </Button>
      </div>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────
  if (flow.step === "error") {
    return (
      <div className="space-y-3">
        <div className="bg-destructive-muted text-destructive px-4 py-3 border border-destructive-border text-sm rounded-sm">
          {flow.message}
        </div>
        <Button size="sm" onClick={handleReset}>
          Try Again
        </Button>
      </div>
    );
  }

  // ── Exchanging ────────────────────────────────────────────────────────
  if (flow.step === "exchanging") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Spinner />
          <span className="text-sm text-muted-foreground">Connecting to Anthropic…</span>
        </div>
      </div>
    );
  }

  // ── Authorizing (waiting for user to paste the code) ──────────────────
  return (
    <div className="space-y-4">
      <Steps />

      <div className="space-y-3">
        <label className="block text-sm font-medium text-foreground">
          Paste the authorization code
        </label>
        <div className="flex items-center gap-2">
          <Input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleExchange();
              }
            }}
            placeholder="Paste code from Anthropic here…"
            className="flex-1 font-mono text-sm"
            autoFocus
          />
          <Button size="sm" onClick={handleExchange} disabled={!code.trim()}>
            Connect
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          After you click Authorize on Anthropic&apos;s site, they&apos;ll show you a code to copy.
          Paste it above.
        </p>
      </div>

      <button
        type="button"
        onClick={handleReset}
        className="text-xs text-muted-foreground hover:text-foreground transition underline underline-offset-2"
      >
        Cancel
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps hint — shown during the "authorizing" state
// ---------------------------------------------------------------------------
function Steps() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <StepBadge n={1} label="Authorize on Anthropic" active />
      <ChevronRight />
      <StepBadge n={2} label="Copy the code" />
      <ChevronRight />
      <StepBadge n={3} label="Paste it here" />
    </div>
  );
}

function StepBadge({ n, label, active = false }: { n: number; label: string; active?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold ${
          active ? "bg-foreground text-background" : "bg-muted text-muted-foreground"
        }`}
      >
        {n}
      </span>
      <span className={active ? "text-foreground font-medium" : ""}>{label}</span>
    </span>
  );
}

function ChevronRight() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className="text-muted-foreground/50 shrink-0"
    >
      <path
        d="M4.5 2.5L7.5 6L4.5 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-muted-foreground" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared layout
// ---------------------------------------------------------------------------
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}
