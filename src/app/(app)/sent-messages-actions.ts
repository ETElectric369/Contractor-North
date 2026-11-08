"use server";

import { requireStaff } from "@/lib/staff-guard";
import { readSentMessages, type SentMessage } from "@/lib/sent-messages";
import { reportError } from "@/lib/observe";
import type { SendKind } from "@/lib/send-review";

/**
 * THE SENT MESSAGES LIST'S ONE READ (cn-v1155): what went out for a document, word for word, newest
 * first. Staff only, and the read names the caller's company. A receipt is sent from its invoice's
 * page, so an invoice lists both its own rows and its receipt rows (two reads, merged, because
 * readSentMessages takes one kind). A read that fails is filed and comes back empty: the list is a
 * convenience beside the send, never a reason for the page to break.
 */
export async function listSentMessages(kind: SendKind, id: string): Promise<SentMessage[]> {
  const ctx = await requireStaff();
  if ("error" in ctx) return [];
  try {
    const orgId = ctx.orgId;
    if (!orgId) return [];
    const kinds: ("invoice" | "receipt" | "quote" | "contract" | "portal")[] = kind === "invoice" ? ["invoice", "receipt"] : [kind];
    const lists = await Promise.all(kinds.map((k) => readSentMessages(ctx.supabase, orgId, k, id, 20)));
    return lists
      .flat()
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0))
      .slice(0, 20);
  } catch (e) {
    reportError("send:list", e, { kind });
    return [];
  }
}
