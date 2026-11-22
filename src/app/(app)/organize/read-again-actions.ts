"use server";

import { requireStaff } from "@/lib/staff-guard";
import { aiAllowed } from "@/lib/ai-cost";
import { billJobReceipt, fileItem, readPaperworkItem, undoPaperwork } from "./actions";
import { readFiledPaperAgainWith } from "./read-again-core";

/**
 * READ AGAIN, ON A PAPER THAT IS ALREADY FILED (cn-v1181). Undo through the door that undoes a
 * filing, read the same picture with today's readers, and file it again the way it was filed; any
 * step that fails leaves the paper waiting, and the answer says where. The steps and every refusal
 * live in read-again-core.ts, with the doors passed in; these are the real ones. Staff only (each
 * door asks again). A "use server" file exports only async functions.
 */
export async function readFiledPaperAgain(billId: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  return readFiledPaperAgainWith({ supabase: ctx.supabase, orgId: ctx.orgId }, billId, {
    canRead: async () => {
      const gate = await aiAllowed(ctx.orgId);
      return gate.ok ? { ok: true } : { ok: false, why: gate.why };
    },
    undo: undoPaperwork,
    readTray: readPaperworkItem,
    fileTray: fileItem,
    billJob: billJobReceipt,
  });
}
