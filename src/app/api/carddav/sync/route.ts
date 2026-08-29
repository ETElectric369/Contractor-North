import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchCards, listCards } from "@/lib/carddav";
import { formatPhone } from "@/lib/utils";

export const runtime = "nodejs";
/** A first pull of a real address book (Erik's runs A to Z, thousands deep) is many batched
 *  REPORTs against iCloud — a route handler with a long leash, not a server action. */
export const maxDuration = 300;

/**
 * SYNC THE BOOK. Lists every card's etag, pulls only what's new or changed (the etag is the
 * change key), deletes what iCloud deleted. Runs as the signed-in user, so RLS scopes every
 * write to their own rows.
 */
export async function POST() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Sign in first." }, { status: 401 });

  const { data: acct } = await supabase
    .from("carddav_accounts")
    .select("apple_id, app_password, addressbook_url")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!acct?.addressbook_url) return NextResponse.json({ ok: false, error: "Connect iCloud in Settings first." }, { status: 400 });

  const listed = await listCards(acct.addressbook_url, acct.apple_id, acct.app_password);
  if (!listed.ok) return NextResponse.json({ ok: false, error: listed.error }, { status: 502 });

  // What we already hold, keyed by card href — only changed etags re-download.
  const { data: haveRows } = await supabase
    .from("phone_contacts")
    .select("uid, etag")
    .eq("user_id", user.id)
    .limit(20000);
  const have = new Map(((haveRows ?? []) as { uid: string; etag: string | null }[]).map((r) => [r.uid, r.etag ?? ""]));

  const remote = new Set(listed.items.map((i) => i.href));
  const toFetch = listed.items.filter((i) => have.get(i.href) !== i.etag).map((i) => i.href);
  const toDelete = [...have.keys()].filter((uid) => !remote.has(uid));

  let pulled = 0;
  const BATCH = 50;
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const res = await fetchCards(acct.addressbook_url, acct.apple_id, acct.app_password, toFetch.slice(i, i + BATCH));
    if (!res.ok) return NextResponse.json({ ok: false, error: res.error, pulled }, { status: 502 });
    if (res.contacts.length) {
      const { error } = await supabase.from("phone_contacts").upsert(
        res.contacts.map((c) => ({
          user_id: user.id,
          uid: c.uid,
          etag: c.etag,
          name: c.name || c.phone || "Contact",
          company: c.company_name || null,
          phone: c.phone ? formatPhone(c.phone) : null, // ONE format, same as everywhere
          email: c.email || null,
          address: c.address || null,
          city: c.city || null,
          state: c.state || null,
          zip: c.zip || null,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,uid" },
      );
      if (error) return NextResponse.json({ ok: false, error: error.message, pulled }, { status: 500 });
      pulled += res.contacts.length;
    }
  }
  if (toDelete.length) {
    await supabase.from("phone_contacts").delete().eq("user_id", user.id).in("uid", toDelete.slice(0, 1000));
  }

  const { count } = await supabase
    .from("phone_contacts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id);
  await supabase
    .from("carddav_accounts")
    .update({ last_synced_at: new Date().toISOString(), contact_count: count ?? 0 })
    .eq("user_id", user.id);

  return NextResponse.json({ ok: true, pulled, removed: toDelete.length, total: count ?? 0 });
}
