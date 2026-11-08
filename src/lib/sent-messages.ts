import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "@/lib/observe";

/**
 * THE WORDS THAT WENT OUT (0407, cn-v1155). After a message leaves for a bill, quote, contract,
 * portal link or receipt, logSend keeps it word for word, and the document's Sent Messages list
 * reads it back. Plain functions that take the caller's Supabase client (this is not a "use server"
 * file); every read and write names the company.
 */

type Db = SupabaseClient<any>;

export type SentMessageRow = {
  orgId: string;
  docKind: "invoice" | "quote" | "contract" | "portal" | "receipt";
  docId: string | null;
  customerId: string | null;
  channel: "email" | "sms";
  to: string;
  subject: string | null;
  body: string;
  copyTo: string | null;
  sentBy: string | null;
  auto: boolean;
};

/**
 * Keep what went out. BEST-EFFORT: the message has already left, so a log that cannot be written is
 * filed in the error sink and the send still counts, the same rule the sent_at stamp follows. It
 * never throws, not even when the client itself does.
 */
export async function logSend(supabase: Db, row: SentMessageRow): Promise<void> {
  try {
    const { error } = await supabase
      .from("sent_messages")
      .insert({
        org_id: row.orgId,
        doc_kind: row.docKind,
        doc_id: row.docId,
        customer_id: row.customerId,
        channel: row.channel,
        to_addr: row.to,
        subject: row.subject,
        body: row.body,
        copy_to: row.copyTo,
        sent_by: row.sentBy,
        auto: row.auto,
      })
      .select("id");
    if (error) reportError("send:log", error, { orgId: row.orgId, docKind: row.docKind });
  } catch (e) {
    reportError("send:log", e, { orgId: row.orgId, docKind: row.docKind });
  }
}

export type SentMessage = {
  id: string;
  channel: "email" | "sms";
  to: string;
  subject: string | null;
  body: string;
  copyTo: string | null;
  sentBy: string | null;
  sentByName: string | null;
  sentAt: string;
  auto: boolean;
};

/** What went out for one document, newest first. The sender's name comes from the profiles embed. */
export async function readSentMessages(
  supabase: Db,
  orgId: string,
  docKind: SentMessageRow["docKind"],
  docId: string,
  limit = 20,
): Promise<SentMessage[]> {
  const { data, error } = await supabase
    .from("sent_messages")
    .select("id, channel, to_addr, subject, body, copy_to, sent_by, sent_at, auto, profiles:sent_by(full_name)")
    .eq("org_id", orgId)
    .eq("doc_kind", docKind)
    .eq("doc_id", docId)
    .order("sent_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as any[]).map((r) => {
    const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    return {
      id: r.id as string,
      channel: r.channel as "email" | "sms",
      to: r.to_addr as string,
      subject: (r.subject ?? null) as string | null,
      body: r.body as string,
      copyTo: (r.copy_to ?? null) as string | null,
      sentBy: (r.sent_by ?? null) as string | null,
      sentByName: (p?.full_name ?? null) as string | null,
      sentAt: r.sent_at as string,
      auto: r.auto === true,
    };
  });
}

/** The address on a person's own profile: where their copy goes. One read; null when there is none. */
export async function senderEmail(supabase: Db, userId: string): Promise<string | null> {
  const { data } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
  const e = ((data as { email?: string | null } | null)?.email ?? "").trim();
  return e || null;
}
