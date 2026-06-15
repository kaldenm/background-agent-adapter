import { toast } from "sonner";

/**
 * Permanently deletes a session AND its Daytona sandbox (frees disk).
 *
 * This is NOT the same as archive:
 * - Archive: hides session from sidebar, sandbox keeps running, disk still used.
 * - Delete: stops sandbox, destroys it on Daytona, removes D1 record. Irreversible.
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

    toast.success("Session deleted and sandbox destroyed");
    return true;
  } catch {
    toast.error("Failed to delete session");
    return false;
  }
}
