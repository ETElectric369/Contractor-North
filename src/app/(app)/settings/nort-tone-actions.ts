"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { asRegister, clampHumor, clampNotes } from "@/lib/nort/tone";

/**
 * Save how Nort talks to THIS person (0183).
 *
 * Their own row, so no role gate beyond being signed in — and `.eq("id", user.id)` is the whole
 * boundary. The values are clamped and narrowed here as well as by the CHECK constraints, because
 * the row is reachable through PostgREST and a 200-humour setting that only the database refuses
 * is a save that reports success and does nothing.
 */
export async function saveNortTone(
  humor: number,
  register: string,
  /** Standing orders (0184). `undefined` = leave untouched, so the tone save can't clobber
   *  something Nort wrote mid-conversation; "" = deliberately cleared. */
  notes?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Sign in first." };

  const { data, error } = await supabase
    .from("profiles")
    .update({
      nort_humor: clampHumor(humor),
      nort_register: asRegister(register),
      ...(notes === undefined ? {} : { nort_notes: clampNotes(notes) }),
    })
    .eq("id", user.id)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  // A zero-row update is a 204, not an error — never report a save that didn't land.
  if (!data?.length) return { ok: false, error: "That didn't save. Try again?" };
  revalidatePath("/settings");
  return { ok: true };
}
