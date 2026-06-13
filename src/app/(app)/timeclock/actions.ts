"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { GeoPoint } from "@/lib/types";

export type ClockResult = { ok: boolean; error?: string };

export async function clockIn(input: {
  job_id: string | null;
  job_code: string | null;
  gps: GeoPoint | null;
  clock_in_at?: string | null; // optional backdated start (e.g. forgot to clock in)
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // Allow backdating the start (never into the future, capped at 12h ago).
  let clockInIso = new Date().toISOString();
  let backdated = false;
  if (input.clock_in_at) {
    const d = new Date(input.clock_in_at);
    const ms = d.getTime();
    if (!isNaN(ms) && ms <= Date.now() + 60_000 && ms >= Date.now() - 12 * 3_600_000) {
      clockInIso = d.toISOString();
      backdated = true;
    }
  }

  // The DB has a unique index preventing two open entries; surface a friendly msg.
  const { error } = await supabase.from("time_entries").insert({
    profile_id: user.id,
    job_id: input.job_id,
    job_code: input.job_code,
    gps_in: input.gps,
    clock_in: clockInIso,
    status: "open",
    source: backdated ? "manual" : input.gps ? "app" : "manual",
  });

  if (error) {
    return {
      ok: false,
      error: error.message.includes("one_open_entry")
        ? "You're already clocked in."
        : error.message,
    };
  }

  revalidatePath("/timeclock");
  return { ok: true };
}

export interface JobAllocationInput {
  job_id: string | null;
  job_code: string | null;
  hours: number;
  description: string;
}

export async function clockOut(input: {
  entry_id: string;
  lunch_minutes: number;
  notes: string;
  gps: GeoPoint | null;
  auto?: boolean;
  allocations?: JobAllocationInput[];
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { error } = await supabase
    .from("time_entries")
    .update({
      clock_out: new Date().toISOString(),
      lunch_minutes: input.lunch_minutes || 0,
      notes: input.notes || null,
      gps_out: input.gps,
      status: "closed",
      source: input.auto ? "auto_gps" : undefined,
    })
    .eq("id", input.entry_id)
    .eq("profile_id", user.id);

  if (error) return { ok: false, error: error.message };

  // Replace any existing allocations for this entry with the submitted set.
  const allocations = (input.allocations ?? []).filter(
    (a) => a.hours > 0 || a.description.trim() || a.job_id || a.job_code,
  );
  await supabase.from("time_allocations").delete().eq("time_entry_id", input.entry_id);
  if (allocations.length) {
    const rows = allocations.map((a, idx) => ({
      time_entry_id: input.entry_id,
      job_id: a.job_id,
      job_code: a.job_code,
      hours: a.hours || 0,
      description: a.description || null,
      sort_order: idx,
    }));
    const { error: allocErr } = await supabase.from("time_allocations").insert(rows);
    if (allocErr) return { ok: false, error: allocErr.message };
  }

  revalidatePath("/timeclock");
  return { ok: true };
}

/**
 * Add a past (manual) timecard entry. Techs can add their own; owner/admin/
 * office can add for any crew member. clock_in/clock_out are ISO strings built
 * on the client (so the user's local time is used).
 */
export async function createManualEntry(input: {
  profile_id: string;
  clock_in: string;
  clock_out: string;
  job_id: string | null;
  job_code: string | null;
  lunch_minutes: number;
  notes: string;
  miles?: number;
  rate_override?: number | null;
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const isStaff = !!me && ["owner", "admin", "office"].includes(me.role);
  const profileId = isStaff ? input.profile_id || user.id : user.id;

  const ci = new Date(input.clock_in);
  const co = new Date(input.clock_out);
  if (isNaN(ci.getTime()) || isNaN(co.getTime())) {
    return { ok: false, error: "Invalid date/time." };
  }
  if (co <= ci) return { ok: false, error: "End must be after start." };

  const { error } = await supabase.from("time_entries").insert({
    profile_id: profileId,
    job_id: input.job_id,
    job_code: input.job_code,
    clock_in: ci.toISOString(),
    clock_out: co.toISOString(),
    lunch_minutes: input.lunch_minutes || 0,
    notes: input.notes || null,
    miles: input.miles ?? 0,
    rate_override: input.rate_override ?? null,
    status: "closed",
    source: "manual",
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timeclock");
  revalidatePath("/timecards");
  return { ok: true };
}

/** Edit an existing time entry (office payroll correction). RLS allows the
 *  entry owner or org staff. */
export async function updateTimeEntry(input: {
  id: string;
  clock_in: string;
  clock_out: string;
  lunch_minutes: number;
  job_code: string | null;
  notes: string;
  miles?: number;
  profile_id?: string | null; // reassign the entry to a different team member
}): Promise<ClockResult> {
  const supabase = await createClient();
  const ci = new Date(input.clock_in);
  const co = new Date(input.clock_out);
  if (isNaN(ci.getTime()) || isNaN(co.getTime())) {
    return { ok: false, error: "Invalid date/time." };
  }
  if (co <= ci) return { ok: false, error: "End must be after start." };

  const patch: Record<string, unknown> = {
    clock_in: ci.toISOString(),
    clock_out: co.toISOString(),
    lunch_minutes: input.lunch_minutes || 0,
    job_code: input.job_code,
    notes: input.notes || null,
    miles: input.miles ?? 0,
    status: "closed",
  };
  if (input.profile_id) patch.profile_id = input.profile_id;

  const { error } = await supabase
    .from("time_entries")
    .update(patch)
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  return { ok: true };
}

export async function deleteTimeEntry(id: string): Promise<ClockResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("time_entries").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timecards");
  revalidatePath("/timeclock");
  return { ok: true };
}

/** Save the "what did you do today?" note (and optional translation) mid-shift. */
export async function saveEntryNotes(
  entry_id: string,
  notes: string,
  translated_notes: string | null,
): Promise<ClockResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("time_entries")
    .update({ notes, translated_notes })
    .eq("id", entry_id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timeclock");
  return { ok: true };
}
