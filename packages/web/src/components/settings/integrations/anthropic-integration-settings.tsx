"use client";

import { useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";

interface SecretsResponse {
  secrets: { key: string }[];
}

export function AnthropicIntegrationSettings() {
  const { data, isLoading } = useSWR<SecretsResponse>("/api/secrets");

  const isConnected =
    data?.secrets?.some((s) => s.key === "ANTHROPIC_OAUTH_TOKEN") ?? false;

  if (isLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">
        Anthropic (Claude Code)
      </h3>
      <p className="text-sm text-muted-foreground mb-6">
        Connect your Claude Code subscription to use it for AI sessions in the
        sandbox. Each connection gets its own independent credentials.
      </p>

      <Section
        title="Connection"
        description="Connect your Claude Code subscription to use it in sandbox sessions."
      >
        {isConnected ? (
          <ConnectedState />
        ) : (
          <DisconnectedState />
        )}
      </Section>

      <Section
        title="How to get a token"
        description="You need an OAuth token from a machine where Pi is installed."
      >
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Run this command on any machine with Pi installed:
          </p>
          <CodeBlock command="bun scripts/get-sandbox-token.ts" />
          <p>
            This opens your browser to authorize with Anthropic and prints a
            token. Paste it above to connect.
          </p>
          <p className="text-xs">
            Each token is independent — connecting here won&apos;t affect your
            local Pi installation.
          </p>
        </div>
      </Section>
    </div>
  );
}

function ConnectedState() {
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);

    try {
      const res = await fetch("/api/secrets/ANTHROPIC_OAUTH_TOKEN", {
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
        <span className="text-sm text-foreground">Connected</span>
      </div>
      <Button
        variant="destructive"
        size="sm"
        onClick={handleDisconnect}
        disabled={disconnecting}
      >
        {disconnecting ? "Disconnecting..." : "Disconnect"}
      </Button>
    </div>
  );
}

function DisconnectedState() {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;

    if (!trimmed.startsWith("sk-ant-ort01-")) {
      toast.error(
        "This doesn't look like an OAuth token. It should start with sk-ant-ort01-"
      );
      return;
    }

    setSaving(true);

    try {
      const res = await fetch("/api/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secrets: { ANTHROPIC_OAUTH_TOKEN: trimmed },
        }),
      });

      if (res.ok) {
        mutate("/api/secrets");
        setToken("");
        toast.success("Anthropic connected successfully");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save token");
      }
    } catch {
      toast.error("Failed to save token");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="inline-block w-2 h-2 rounded-full bg-muted-foreground" />
        <span className="text-sm text-muted-foreground">Not connected</span>
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
          placeholder="sk-ant-ort01-..."
          className="flex-1 font-mono text-sm"
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !token.trim()}
        >
          {saving ? "Saving..." : "Connect"}
        </Button>
      </div>
    </div>
  );
}

function CodeBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted border border-border rounded-sm font-mono text-sm">
      <code className="text-foreground">{command}</code>
      <button
        type="button"
        onClick={handleCopy}
        className="text-xs text-muted-foreground hover:text-foreground transition shrink-0"
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

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
