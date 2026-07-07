"use server";

import { createClient } from "@/lib/supabase/server";

export type Notif = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  url: string | null;
  read_at: string | null;
  created_at: string;
};

/** The current user's 20 most-recent notifications. RLS scopes the read to them + their org. */
export async function getMyNotifications(): Promise<Notif[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, type, title, body, url, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  return (data ?? []) as Notif[];
}

/** Mark specific notifications (or ALL my unread, when ids omitted) as read. RLS ensures a
 *  user can only ever touch their own rows, so no explicit user filter is needed. */
export async function markNotificationsRead(ids?: string[]): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  let q = supabase.from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (ids && ids.length) q = q.in("id", ids);
  await q;
  return { ok: true };
}
