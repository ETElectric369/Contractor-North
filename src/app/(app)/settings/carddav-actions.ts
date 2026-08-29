"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { discoverAddressbook } from "@/lib/carddav";
import { formatPhone } from "@/lib/utils";

/**
 * iCLOUD CONTACTS — connect, disconnect, search. The sync itself runs in /api/carddav/sync
 * (a route handler, so it can hold the long leash a 2,000-contact first pull needs).
 *
 * PERSONAL SCOPE: everything here keys on the signed-in USER, and 0235's RLS binds the rows to
 * auth.uid() — an office seat can never browse the owner's personal address book. The token-portal
 * law holds too: the connection is visible in Settings, disconnect wipes it, and the app-specific
 * password is revocable at appleid.apple.com independent of us.
 */

type Result = { ok: boolean; error?: string };

export async function connectCardDav(appleId: string, appPassword: string): Promise<Result> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const id = appleId.trim().toLowerCase();
  const pw = appPassword.trim();
  if (!id || !pw) return { ok: false, error: "Both the Apple ID and the app-specific password are needed." };

  // Verify against iCloud BEFORE storing — a stored credential that never worked is a support
  // ticket wearing a checkmark.
  const found = await discoverAddressbook(id, pw);
  if (!found.ok) return { ok: false, error: found.error };

  const { error } = await supabase.from("carddav_accounts").upsert({
    user_id: user.id,
    apple_id: id,
    app_password: pw,
    addressbook_url: found.addressbookUrl,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export async function disconnectCardDav(): Promise<Result> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };
  // The synced copy goes with the connection — keeping a book the user just unplugged would be
  // exactly the silent data retention the token-portal law forbids.
  await supabase.from("phone_contacts").delete().eq("user_id", user.id);
  const { error } = await supabase.from("carddav_accounts").delete().eq("user_id", user.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}

export type MyContact = {
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
};

/** The picker's search — LOCAL rows, so it answers in milliseconds where Safari chewed for a
 *  minute. Empty query returns the front of the book so the sheet is never blank. */
export async function searchMyContacts(q: string): Promise<{ ok: boolean; error?: string; contacts: MyContact[] }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first.", contacts: [] };

  const needle = q.trim().replace(/[%_\\]/g, "\\$&");
  let query = supabase
    .from("phone_contacts")
    .select("name, company, phone, email, address, city, state, zip")
    .eq("user_id", user.id)
    .order("name")
    .limit(30);
  if (needle) query = query.or(`name.ilike.%${needle}%,company.ilike.%${needle}%,phone.ilike.%${needle}%`);
  const { data, error } = await query;
  if (error) return { ok: false, error: error.message, contacts: [] };
  return {
    ok: true,
    contacts: ((data ?? []) as MyContact[]).map((c) => ({ ...c, phone: c.phone ? formatPhone(c.phone) : c.phone })),
  };
}

export async function cardDavStatus(): Promise<{ connected: boolean; appleId?: string; count?: number; lastSynced?: string | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { connected: false };
  const { data } = await supabase
    .from("carddav_accounts")
    .select("apple_id, contact_count, last_synced_at")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data) return { connected: false };
  return {
    connected: true,
    appleId: data.apple_id,
    count: Number(data.contact_count ?? 0),
    lastSynced: data.last_synced_at ?? null,
  };
}
