import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { isStaffRole } from "@/lib/actions/perms";
import { sendPushToProfiles } from "@/lib/push";

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

/**
 * WHO HEARS ABOUT A CREW CHANGE: every OTHER active staff member of the actor's org, read through the
 * caller's own session client (so RLS keeps it to one org), exactly the set requestMaterials rings.
 */
export async function officeRecipients(
  // The caller's cookie-bound client. Typed loosely so this file doesn't pull the server client in.
  supabase: { from: (t: string) => any },
  actorId: string,
): Promise<string[]> {
  const { data: staff } = await supabase.from("profiles").select("id, role").neq("id", actorId).eq("active", true);
  return ((staff ?? []) as { id: string; role?: string | null }[])
    .filter((p) => isStaffRole(p.role ?? ""))
    .map((p) => p.id);
}

export type RingInput = NotificationInput & {
  type: string;
  url: string;
  /** How long one ring covers. */
  windowMinutes: number;
  /**
   * bell_each_push_once (the materials ring): every event lands on the bell, the PUSH waits out the
   *   window. Keyed on type + url + title, so each person's adds debounce on their own.
   * once_per_window (the panel ring): ONE bell line and one push per job per window. Inside the
   *   window the line already on the bell is refreshed with the new words (a running count) and
   *   comes back UNREAD, so a change after the office read the line is never silent; nobody is
   *   buzzed again. Keyed on type + url, whoever made the change.
   */
  mode: "bell_each_push_once" | "once_per_window";
};

/**
 * THE OFFICE HEARS ABOUT A CREW CHANGE, WITHOUT BEING BUZZED FOR EACH ONE (pulled out of
 * materials/actions.ts for the Panel tab, 2026-09-25). A man walking a panel and relabelling eight
 * circuits is one event to the boss, not eight (NOT-ANNOYING); nothing is lost, because the bell
 * line is always there to read. The ledger for the window is the notifications table itself, read
 * with the service client (a notification is readable only by its recipient, and the actor is not
 * one), always inside the actor's org.
 *
 * Never throws: a notification must never unsave the change that caused it. Returns what it did.
 * If the window can't be read, the bell line is still written (the line is never dropped) and the
 * push is skipped, since it can't be known whether the office was just buzzed.
 */
export async function ringOffice(
  orgId: string | null | undefined,
  recipients: string[],
  n: RingInput,
): Promise<"rang" | "refreshed" | "bell_only" | "nobody" | "failed"> {
  try {
    const ids = Array.from(new Set(recipients.filter(Boolean)));
    if (!orgId || !ids.length) return "nobody";
    const since = new Date(Date.now() - n.windowMinutes * 60 * 1000).toISOString();
    const sb = createServiceClient();
    // Look for the window's ring BEFORE this event's rows land, or the check would find itself.
    let q = sb
      .from("notifications")
      .select("id")
      .eq("org_id", orgId)
      .eq("type", n.type)
      .eq("url", n.url)
      .gte("created_at", since);
    if (n.mode === "bell_each_push_once") q = q.eq("title", n.title);
    const { data: recent, error: rErr } = await q.limit(50);
    if (rErr) reportError("ringOffice.window", rErr, { orgId, type: n.type });
    const inWindow = (recent ?? []) as { id: string }[];

    if (!rErr && n.mode === "once_per_window" && inWindow.length) {
      const { data: refreshed, error } = await sb
        .from("notifications")
        .update({ title: n.title, body: n.body ?? null, read_at: null })
        .in("id", inWindow.map((r) => r.id))
        .select("id");
      if (error) throw error;
      // Every line in the window had gone (cleared from the bell): write a new one.
      if ((refreshed ?? []).length) return "refreshed";
    }

    const wrote = await createNotifications(orgId, ids, { type: n.type, title: n.title, body: n.body, url: n.url });
    if (!wrote) return "failed";
    if (rErr || inWindow.length) return "bell_only";
    // "assigned" is the push kind for "something landed that is yours to deal with", so it respects
    // the same per-boss toggle requestMaterials's ask does.
    await sendPushToProfiles(ids, "assigned", { title: n.title, body: n.body ?? "", url: n.url }).catch(() => {});
    return "rang";
  } catch (e) {
    reportError("ringOffice", e, { orgId, type: n.type });
    return "failed";
  }
}
