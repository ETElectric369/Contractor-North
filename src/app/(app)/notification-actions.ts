"use server";

import { createClient } from "@/lib/supabase/server";
import { BELL_LIST_SIZE } from "@/lib/bell-words";

export type Notif = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  read_at: string | null;
  created_at: string;
};

/**
 * WHAT THE BELL SHOWS (Wave 1): the newest 20 lines, whether older ones exist, and how many are
 * unread, counted by the database (an exact head count on read_at is null, which
 * notifications_user_unread_idx serves) rather than read off the 20 rows: a 21st unread line used to
 * vanish from the badge. RLS scopes every read to the caller (their own lines, their own company);
 * the explicit user filter is what lets the partial index serve the count. `failed` when the list
 * itself couldn't be read, so the bell says so instead of "all caught up".
 */
export async function getMyBell(): Promise<{ items: Notif[]; unread: number; more: boolean; failed: boolean }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { items: [], unread: 0, more: false, failed: false };
  const [list, count] = await Promise.all([
    supabase
      .from("notifications")
      .select("id, type, title, body, url, read_at, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(BELL_LIST_SIZE + 1),
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("read_at", null),
  ]);
  if (list.error) return { items: [], unread: count.error ? 0 : (count.count ?? 0), more: false, failed: true };
  const rows = (list.data ?? []) as Notif[];
  const items = rows.slice(0, BELL_LIST_SIZE);
  // A count that couldn't be read falls back to the lines in hand: short, never a false zero.
  const unread = count.error || count.count == null ? items.filter((n) => !n.read_at).length : count.count;
  return { items, unread, more: rows.length > BELL_LIST_SIZE, failed: false };
}

/** Mark specific notifications (or ALL my unread, when ids omitted) as read. RLS ensures a user can
 *  only ever touch their own rows. The write asks its rows back (the silent-write law): an error is
 *  ok: false, so the bell puts the unread dot back and says so. Nothing left to mark is not an error. */
export async function markNotificationsRead(ids?: string[]): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  let q = supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (ids && ids.length) q = q.in("id", ids);
  const { error } = await q.select("id");
  return { ok: !error };
}
