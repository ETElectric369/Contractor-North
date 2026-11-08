"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { formatDateTime } from "@/lib/utils";
import type { SendKind } from "@/lib/send-review";
import type { SentMessage } from "@/lib/sent-messages";
import { listSentMessages } from "@/app/(app)/sent-messages-actions";

/** A send that just landed can tell every list on the page to read again: window.dispatchEvent(new Event(SENT_MESSAGES_EVENT)). */
export const SENT_MESSAGES_EVENT = "cn:sent-messages";

/**
 * THE SENT MESSAGES LIST (cn-v1155): what went out for this document, word for word, newest first.
 * One 44px row per message: how (Email or Text), to whom, when, and who sent it (a name, or
 * Automatic for the app's own reminder). A tap opens the words (the subject on an email and the
 * message, kept as written) and, when a copy went to the owner, says so. Empty hides the whole
 * block, unless the page asks for the line (`showEmpty`: the invoice page says "Nothing sent yet").
 * It reads again when `refreshKey` changes, when a send announces itself (SENT_MESSAGES_EVENT) and when
 * the tab comes back, so a page that just sent shows the new row.
 */
export function SentMessagesList({
  kind,
  id,
  showEmpty = false,
  refreshKey,
}: {
  kind: SendKind;
  id: string;
  showEmpty?: boolean;
  refreshKey?: string | number;
}) {
  const [rows, setRows] = useState<SentMessage[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Bumped when a send lands (SENT_MESSAGES_EVENT) or the tab comes back, so the list reads again.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    listSentMessages(kind, id).then(
      (r) => live && setRows(r),
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [kind, id, refreshKey, tick]);

  useEffect(() => {
    const again = () => setTick((n) => n + 1);
    const visible = () => document.visibilityState === "visible" && again();
    window.addEventListener(SENT_MESSAGES_EVENT, again);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener(SENT_MESSAGES_EVENT, again);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  if (rows === null) return null;
  return <SentMessagesView rows={rows} open={open} onToggle={(mid) => setOpen(open === mid ? null : mid)} showEmpty={showEmpty} />;
}

/** The rows themselves, drawn from what was read (no reading here, so a test can hand it rows). */
export function SentMessagesView({
  rows,
  open,
  onToggle,
  showEmpty = false,
}: {
  rows: SentMessage[];
  open: string | null;
  onToggle: (id: string) => void;
  showEmpty?: boolean;
}) {
  const lang = useLang();
  const t = translator(lang);
  if (rows.length === 0 && !showEmpty) return null;
  // The viewer's own clock: the list loads after the page is up, so the zone is the device's.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <section className="space-y-2" data-sent-messages>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t("sn_sentTitle")}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t("sn_sentNone")}</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {rows.map((m) => {
            const isOpen = open === m.id;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onToggle(m.id)}
                  aria-expanded={isOpen}
                  title={isOpen ? t("sn_btn_hideWords") : t("sn_btn_showWords")}
                  className="flex min-h-11 w-full flex-wrap items-center gap-x-2 px-3 py-2 text-left text-sm text-slate-700"
                >
                  <span className="font-medium text-slate-900">{m.channel === "sms" ? t("sn_channelText") : t("sn_channelEmail")}</span>
                  <span className="min-w-0 break-all">{m.to}</span>
                  <span className="text-xs text-slate-500">
                    {formatDateTime(m.sentAt, tz, lang)} · {m.auto ? t("sn_auto") : (m.sentByName ?? "")}
                  </span>
                </button>
                {isOpen && (
                  <div className="space-y-1 px-3 pb-3 text-sm text-slate-700">
                    {m.subject && <div className="font-medium text-slate-900">{m.subject}</div>}
                    <div className="whitespace-pre-wrap">{m.body}</div>
                    {m.copyTo && <div className="text-xs text-slate-500">{fillText(t("sn_copyWent"), { email: m.copyTo })}</div>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
