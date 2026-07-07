import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

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
 */
export async function createNotifications(
  orgId: string | null | undefined,
  userIds: (string | null | undefined)[],
  n: NotificationInput,
): Promise<void> {
  try {
    const ids = Array.from(new Set(userIds.filter((x): x is string => !!x)));
    if (!orgId || ids.length === 0 || !n.title) return;
    const rows = ids.map((user_id) => ({
      org_id: orgId,
      user_id,
      type: n.type ?? "general",
      title: n.title,
      body: n.body ?? null,
      url: n.url ?? null,
    }));
    const sb = createServiceClient();
    await sb.from("notifications").insert(rows);
  } catch {
    /* best-effort — observability/notifications must never break the caller */
  }
}
