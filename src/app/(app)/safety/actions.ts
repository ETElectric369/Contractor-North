"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export type Result = { ok: boolean; error?: string };

export async function addSafetyRecord(input: {
  kind: "incident" | "toolbox";
  record_date?: string | null;
  title: string;
  profile_id?: string | null;
  job_id?: string | null;
  severity?: string | null;
  recordable?: boolean;
  description?: string | null;
  attendees?: string | null;
}): Promise<Result> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (!input.title?.trim()) return { ok: false, error: "Title is required." };

  const { error } = await supabase.from("safety_records").insert({
    kind: input.kind === "toolbox" ? "toolbox" : "incident",
    record_date: input.record_date || new Date().toISOString().slice(0, 10),
    title: input.title.trim(),
    profile_id: input.profile_id || null,
    job_id: input.job_id || null,
    severity: input.severity || null,
    recordable: !!input.recordable,
    description: input.description?.trim() || null,
    attendees: input.attendees?.trim() || null,
    created_by: user.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/safety");
  return { ok: true };
}

export async function deleteSafetyRecord(id: string): Promise<Result> {
  const supabase = await createClient();
  const { error } = await supabase.from("safety_records").delete().eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/safety");
  return { ok: true };
}
