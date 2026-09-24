import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";

export type NotificationInput = {
  type?: string;
  title: string;
  body?: string | null;
  url?: string | null;
};

/**
 * Persist an in-app notification (the bell) for each recipient. This is the always-works
 * channel that does NOT depend on push permission — the canonical event log the bell and
 * My Day read from. Fire-and-forget; NEVER throws (like reportError, a notification must
 * never break the action that triggered it). Written with the service client so RLS can
 * lock the table to "recipient reads their own" while the server still writes for anyone.
 *
 * Returns false when the write failed (and reports it), true otherwise, including when there was
 * nobody to write to. Every existing caller ignores it; a caller whose only output IS the bell line
 * (the long-shift job's 10-hour step) reads it, so a lost line is never counted as sent.
 */
export async function createNotifications(
  orgId: string | null | undefined,
  userIds: (string | null | undefined)[],
  n: NotificationInput,
): Promise<boolean> {
  try {
    const ids = Array.from(new Set(userIds.filter((x): x is string => !!x)));
    if (!orgId || ids.length === 0 || !n.title) return true;
    const rows = ids.map((user_id) => ({
      org_id: orgId,
      user_id,
      type: n.type ?? "general",
      title: n.title,
      body: n.body ?? null,
      url: n.url ?? null,
    }));
    const sb = createServiceClient();
    // Supabase RETURNS a failed insert; it does not throw it.
    const { error } = await sb.from("notifications").insert(rows);
    if (error) throw error;
    return true;
  } catch (e) {
    // Best-effort: a notification must never break the caller. But not silent.
    reportError("createNotifications", e, { orgId, type: n.type ?? "general" });
    return false;
  }
}
