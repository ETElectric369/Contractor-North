"use server";

import { revalidatePath } from "next/cache";
import { updateOrgSettings } from "@/app/(app)/settings/actions";
import { supplierPaperLine } from "./supplier-reconcile";

/**
 * THE DAY THIS COMPANY'S BOOKS IN NORTH BEGIN (Wave 0): settings.books_begin. A supplier paper
 * dated before it never needs a person. Null clears it, and the earliest scanned bill stands in.
 *
 * Written through updateOrgSettings, the one settings writer: it merges into the company's own
 * row, reads the write back, and says so in words when the role can't change company settings
 * (organizations_update is owner/admin).
 */
export async function setBooksBegin(day: string | null): Promise<{ ok: boolean; error?: string }> {
  const books_begin = day === null || day === "" ? null : supplierPaperLine({ books_begin: day });
  if (day && !books_begin) return { ok: false, error: "Pick a day on the calendar." };
  const res = await updateOrgSettings({ books_begin });
  if (!res.ok) return { ok: false, error: res.error ?? "That didn't save." };
  revalidatePath("/bills");
  revalidatePath("/planner"); // My Day's supplier cards draw the same line
  return { ok: true };
}
