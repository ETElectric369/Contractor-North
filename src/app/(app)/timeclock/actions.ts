"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import type { GeoPoint } from "@/lib/types";

export type ClockResult = { ok: boolean; error?: string };

export async function clockIn(input: {
  job_id: string | null;
  job_code: string | null;
  gps: GeoPoint | null;
}): Promise<ClockResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  // The DB has a unique index preventing two open entries; surface a friendly msg.
  const { error } = await supabase.from("time_entries").insert({
    profile_id: user.id,
    job_id: input.job_id,
    job_code: input.job_code,
    gps_in: input.gps,
    clock_in: new Date().toISOString(),
    status: "open",
    source: input.gps ? "app" : "manual",
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

export async function clockOut(input: {
  entry_id: string;
  lunch_minutes: number;
  notes: string;
  gps: GeoPoint | null;
  auto?: boolean;
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
