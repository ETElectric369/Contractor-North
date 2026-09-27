import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { isStaffRole } from "@/lib/actions/perms";
import { pushKindIsOptIn, sendPushToProfiles, type PushKind } from "@/lib/push";

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
 * THE BELL RECORDS EVERY PUSH (Wave 1, W1-10 rewritten). Erik kept the Bell: "where would push
 * notifications be recorded?" Sixteen push sites wrote no bell line, so a push dismissed on the lock
 * screen (or never delivered: no signal, a muted kind, the app not installed) left nothing to go
 * back to. This is the one door for a push that doesn't write its own line: it writes the bell line
 * (createNotifications) and pushes, in that order, so the line is there even when the push isn't.
 *
 *   DEFAULT-ON KINDS (every kind but day_ahead): the line goes to every intended recipient, even one
 *   who muted the push. Muting a buzz is not asking to lose the record.
 *   OPT-IN KINDS (day_ahead: the morning digest and the 6 PM close-out): the line goes only to the
 *   people the push went to (sendPushToProfiles' answer). Nobody who never asked for a daily digest
 *   finds one on the bell every morning.
 *
 * Nothing new reaches a tech: the line says exactly what the push to him says, to exactly the people
 * the push was for. The line's type is the push kind. Never throws: a notification must never unsave
 * what caused it. Returns whether the line was written and who was pushed.
 *
 * NOT for a site that already writes its own line (ringOffice, the materials and stock rings, the
 * quote-accepted and daily-report alerts, crew-notify, the long-shift job, ...): wrapping those would
 * put every line on the bell twice. every-push-rings-the-bell.test.ts holds the list.
 */
export async function notifyPeople(
  orgId: string | null | undefined,
  profileIds: (string | null | undefined)[],
  kind: PushKind,
  n: { title: string; body?: string | null; url?: string | null },
): Promise<{ bell: boolean; pushed: string[] }> {
  try {
    const ids = Array.from(new Set(profileIds.filter((x): x is string => !!x)));
    if (!orgId || !ids.length || !n.title) return { bell: true, pushed: [] };
    const line = { type: kind, title: n.title, body: n.body ?? null, url: n.url ?? null };
    const payload = { title: n.title, body: n.body ?? "", ...(n.url ? { url: n.url } : {}) };
    if (pushKindIsOptIn(kind)) {
      const pushed = ((await sendPushToProfiles(ids, kind, payload).catch(() => [])) ?? []) as string[];
      const bell = pushed.length ? await createNotifications(orgId, pushed, line) : true;
      return { bell, pushed };
    }
    const bell = await createNotifications(orgId, ids, line);
    const pushed = ((await sendPushToProfiles(ids, kind, payload).catch(() => [])) ?? []) as string[];
    return { bell, pushed };
  } catch (e) {
    reportError("notifyPeople", e, { orgId, kind });
    return { bell: false, pushed: [] };
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
