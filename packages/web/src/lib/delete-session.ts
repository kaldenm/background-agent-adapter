import { toast } from "sonner";

/**
 * Permanently deletes a session and asks the server to clean up any attached sandbox.
 *
 * This is NOT the same as archive:
 * - Archive: hides session from sidebar and keeps it resumable.
 * - Delete: removes the session index record and attempts provider cleanup. Irreversible.
 *
 * Returns `true` when the request succeeds. Callers are responsible for
 * updating any client-side caches or navigation state.
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      toast.error((data as { error?: string }).error || "Failed to delete session");
      return false;
    }

    toast.success("Session deleted");
    return true;
  } catch {
    toast.error("Failed to delete session");
    return false;
  }
}
