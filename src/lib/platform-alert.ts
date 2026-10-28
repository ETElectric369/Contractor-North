import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { notifyPeople } from "@/lib/notifications";

export type PlatformAdmin = { id: string; org_id: string | null };

/**
 * NORTH'S OWN TEAM, AS PEOPLE TO NOTIFY (cn-v1136). platform_admins (0176) holds the user ids; the
 * profiles row carries each one's company and whether they are still active. Read with the service
 * client: the platform_admins table has no policies, and the caller is a cron or a webhook with no
 * session of its own. A removed person (active false) is not on the list — a page about the platform
 * must not reach a phone that no longer belongs to it. A failed read THROWS: the caller decides what
 * a page that could not find its people means (the blocker door files it as "platform-alert").
 */
export async function platformAdminProfiles(): Promise<PlatformAdmin[]> {
  const sb = createServiceClient();
  const { data: admins, error: aErr } = await sb.from("platform_admins").select("user_id");
  if (aErr) throw aErr;
  const ids = (admins ?? []).map((a: { user_id: string }) => a.user_id).filter(Boolean);
  if (!ids.length) return [];
  const { data: profs, error: pErr } = await sb.from("profiles").select("id, org_id, active").in("id", ids);
  if (pErr) throw pErr;
  return (profs ?? [])
    .filter((p: { active?: boolean | null }) => p.active !== false)
    .map((p: { id: string; org_id?: string | null }) => ({ id: p.id, org_id: p.org_id ?? null }));
}

/**
 * THE PAGE ITSELF: one bell line and one push per admin, through notifyPeople (the one door for a
 * push that writes its own line), under the bug_watch kind — its own kind, so muting a company alert
 * never mutes it, and muting it never mutes a company alert. The words name the culprit and say when
 * a fixed blocker is back; an ESCALATION (a known error that is a blocker for the first time,
 * skeptic #42 S2) is titled as a first blocker, because it is one — it was never a blocker before,
 * whatever its status did; the body is the error's first 120 characters; the door is /bugs.
 *
 * An admin with no company is SKIPPED and counted: notifyPeople writes the bell line under an org
 * (notifications.org_id is not null), and a page with no line to go back to is the thing the Bell
 * exists to prevent. The caller reads `sent`: zero means nobody was paged (S7). A failed admins read
 * throws (platformAdminProfiles); the caller files it.
 */
export async function alertPlatformAdmins(input: { where: string; message: string; reopened: boolean; escalated?: boolean }): Promise<{ sent: number; skipped: number }> {
  const admins = await platformAdminProfiles();
  const title = input.reopened && !input.escalated ? `Blocker Is Back: ${input.where}` : `Blocker: ${input.where}`;
  const body = String(input.message ?? "").slice(0, 120);
  let sent = 0;
  let skipped = 0;
  await Promise.all(
    admins.map(async (admin) => {
      if (!admin.org_id) {
        skipped++;
        return;
      }
      await notifyPeople(admin.org_id, [admin.id], "bug_watch", { title, body, url: "/bugs" });
      sent++;
    }),
  );
  return { sent, skipped };
}
