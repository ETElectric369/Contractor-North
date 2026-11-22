"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";
import { deleteEndedVisit } from "../appointments/actions";

/**
 * DELETE…, IN THE NOT SOLD FOLD (cn-v1181, I2b). The owner, 2026-11-22: "theres no way to access it
 * [...] shouldnt each item be clickable to open or delete?". Each fold row still opens its visit; this
 * is the door beside it. The first tap asks in place (never the browser's own dialog), in the reader's
 * words: what goes, and that a visit with anything on it stays. The second tap asks the ONE server door
 * (appointments/actions deleteEndedVisit), which deletes only when nothing is on the visit.
 *
 * THREE ENDINGS. Deleted: said, the fold re-reads. Kept (something is on it): the server's one sentence
 * says what and that it stays on file; nothing moves. Refused or no connection: said in red, the ask
 * closes, and the same tap can be tried again.
 */

type ToastFn = ReturnType<typeof useToast>;

/** An outline door on a 44px target (the row menu's lone door, never a filled one). */
const OUTLINE_DOOR =
  "btn-gloss inline-flex h-11 items-center justify-center whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-800 hover:border-brand hover:text-brand disabled:opacity-50";

/** The second tap, with its server door as `deps` so its endings are proven without a server. */
export async function deleteFoldVisit(
  id: string,
  io: { toast: ToastFn; refresh: () => void; t: (key: string) => string },
  deps: { del: typeof deleteEndedVisit } = { del: deleteEndedVisit },
): Promise<boolean> {
  let res: Awaited<ReturnType<typeof deleteEndedVisit>>;
  try {
    res = await deps.del(id);
  } catch {
    io.toast(io.t("vp_thatDidntSave"), "error");
    return false;
  }
  if (res.ok && res.did === "deleted") {
    io.toast(io.t("vp_deletedNothingOnIt"), "success");
    io.refresh();
    return true;
  }
  // Kept on file is an answer, not a failure: said plainly. Anything else is a refusal, said in red.
  io.toast(res.error ?? io.t("vp_thatDidntSave"), res.kept ? "info" : "error");
  if (!res.kept) io.refresh();
  return false;
}

/** The ask, drawn from what it is handed (so a test reads the face a tap opens). */
export function FoldDeleteAsk({ pending, onYes, onKeep }: { pending: boolean; onYes: () => void; onKeep: () => void }) {
  const t = translator(useLang());
  return (
    <div className="w-full rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" data-fold-ask="">
      <p>{t("ip_deleteVisitAsk")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="text-red-600" disabled={pending} onClick={onYes}>
          {pending ? t("vp_btn_saving") : t("ip_btn_deleteVisitIt")}
        </Button>
        <Button type="button" variant="ghost" disabled={pending} onClick={onKeep}>
          {t("vp_btn_keepIt")}
        </Button>
      </div>
    </div>
  );
}

/** The fold row's Delete…: an outline door on a 44px target; the ask replaces it in place. */
export function FoldDelete({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  const [asking, setAsking] = useState(false);
  const [pending, start] = useTransition();
  if (asking) {
    return (
      <FoldDeleteAsk
        pending={pending}
        onKeep={() => setAsking(false)}
        onYes={() =>
          start(async () => {
            const gone = await deleteFoldVisit(id, { toast, refresh: () => router.refresh(), t });
            if (!gone) setAsking(false);
          })
        }
      />
    );
  }
  return (
    <button type="button" className={OUTLINE_DOOR} data-fold-delete={id} onClick={() => setAsking(true)}>
      {t("ip_btn_deleteVisit")}
    </button>
  );
}
