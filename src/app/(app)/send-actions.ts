"use server";

import { previewInvoiceSend, emailInvoice, textInvoice } from "@/app/(app)/billing/actions";
import { previewQuoteSend, emailQuote, textQuote } from "@/app/(app)/quotes/actions";
import { previewContractSend, sendContract } from "@/app/(app)/contracts/actions";
import { previewPortalSend, emailPortalLink } from "@/app/(app)/crm/actions";
import { createClient } from "@/lib/supabase/server";
import { callerLang } from "@/lib/lang-of";
import { translator } from "@/lib/i18n";
import type { PreviewResult, SendChannel, SendKind, SendMessage } from "@/lib/send-review";

/**
 * THE REVIEW SHEET'S TWO DOORS (cn-v1155). The sheet (components/send-sheet) is one component for
 * every document that goes out, so it talks to one pair of actions: previewSend asks the document's
 * own door for the words it WOULD send, and sendReviewed hands back what the owner let go. Each
 * document keeps its own send, its own checks and its own stamp; this file only picks which one.
 * A file marked "use server" exports only async functions, so the dispatch tables stay private.
 */

/** The kinds the sheet can send; anything else is refused instead of falling through to the portal door. */
const SEND_KINDS: readonly string[] = ["invoice", "receipt", "quote", "contract", "portal"];
function isSendKind(kind: unknown): kind is SendKind {
  return typeof kind === "string" && SEND_KINDS.includes(kind);
}
/** The sheet's own "didn't send" sentence, in the caller's language. */
async function unknownKindSentence(): Promise<string> {
  return translator(await callerLang(await createClient()))("sn_didntSend");
}

/** The words the sheet opens with, from the door that owns this kind of document. */
export async function previewSend(kind: SendKind, id: string): Promise<PreviewResult> {
  if (!isSendKind(kind)) return { ok: false, error: await unknownKindSentence() };
  if (kind === "invoice" || kind === "receipt") return previewInvoiceSend(id, kind);
  if (kind === "quote") return previewQuoteSend(id);
  if (kind === "contract") return previewContractSend(id);
  return previewPortalSend(id);
}

/** Send it, with whatever the owner changed. An absent field in `message` keeps the server's default. */
export async function sendReviewed(
  kind: SendKind,
  id: string,
  channel: SendChannel,
  message: SendMessage,
): Promise<{ ok: boolean; error?: string }> {
  if (!isSendKind(kind)) return { ok: false, error: await unknownKindSentence() };
  const m = message ?? {};
  let res: { ok: boolean; error?: string };
  if (kind === "invoice" || kind === "receipt") {
    res = channel === "email" ? await emailInvoice(id, m, kind) : await textInvoice(id, m, kind);
  } else if (kind === "quote") {
    res = channel === "email" ? await emailQuote(id, m) : await textQuote(id, m);
  } else if (channel === "sms") {
    // A contract and a portal link go by email only; say so in the caller's own language.
    const lang = await callerLang(await createClient());
    return { ok: false, error: translator(lang)("sn_emailOnly") };
  } else {
    res = kind === "contract" ? await sendContract(id, m) : await emailPortalLink(id, m);
  }
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
