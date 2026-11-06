"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CopyCheck, Loader2, Merge, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { findDuplicateContacts, mergeCustomers } from "./actions";
import type { DupGroup } from "@/lib/crm/duplicates";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

/**
 * "Find duplicates" — scans the whole contact book (findDuplicateContacts) for likely-same records
 * by shared phone/email/name, then lets the office pick which one to KEEP and fold the rest into it
 * via the existing mergeCustomers. Detection only suggests; the merge (destructive) needs a click.
 *
 * State is keyed by a STABLE group id (each contact is in exactly one group, so members[0].id is a
 * unique, position-independent key) — NOT array index, so removing a merged group can't shift a
 * later group's keeper selection onto the wrong record.
 */
const groupId = (g: DupGroup) => g.members[0].id;

/** Words with one piece of markup inside: the words split at the slot, the piece between them. */
function aroundSlot(words: string, slot: string, piece: React.ReactNode) {
  const [before, after = ""] = words.split(slot);
  return (
    <>
      {before}
      {piece}
      {after}
    </>
  );
}

export function DuplicatesButton() {
  const router = useRouter();
  const toast = useToast();
  const t = translator(useLang());
  /** "phone + email" in the reader's language: each reason the scan found (lib/crm/duplicates), its own word. */
  const reasonWords = (reason: string) =>
    reason
      .split(" + ")
      .map((r) => (["phone", "email", "name", "similar"].includes(r) ? t(`cu_reason_${r}`) : r))
      .join(" + ");
  const [open, setOpen] = useState(false);
  const [loading, startLoad] = useTransition();
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [keepers, setKeepers] = useState<Record<string, string>>({}); // gid → chosen keeper id
  const [mergingId, setMergingId] = useState<string | null>(null);

  function scan() {
    setOpen(true);
    setGroups(null);
    setKeepers({});
    startLoad(async () => {
      const res = await findDuplicateContacts();
      if (!res.ok) { toast(res.error ?? t("cu_cantScan")); setOpen(false); return; }
      setGroups(res.groups ?? []);
    });
  }

  async function mergeGroup(g: DupGroup) {
    const gid = groupId(g);
    const keeperId = keepers[gid] ?? g.members[0].id;
    const others = g.members.filter((m) => m.id !== keeperId);
    if (!others.length) return;
    setMergingId(gid);
    try {
      for (const o of others) {
        const res = await mergeCustomers(o.id, keeperId);
        if (!res.ok) { toast(res.error ?? t("cu_mergeFailed")); return; }
      }
      toast(fillText(t(others.length === 1 ? "cu_mergedOne" : "cu_mergedMany"), { n: String(others.length) }));
      setGroups((gs) => (gs ?? []).filter((x) => groupId(x) !== gid));
      router.refresh();
    } finally {
      setMergingId(null);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={scan}>
        <CopyCheck className="h-4 w-4" /> {t("cu_btn_findDuplicates")}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t("cu_findMergeTitle")}>
        {loading || groups === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> {t("cu_scanning")}
          </div>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            {t("cu_noDupes")}
          </p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              {aroundSlot(
                fillText(t(groups.length === 1 ? "cu_dupeGroupsOne" : "cu_dupeGroupsMany"), { n: String(groups.length) }),
                "{keep}",
                <strong>{t("cu_keep")}</strong>,
              )}
            </p>
            {groups.map((g) => {
              const gid = groupId(g);
              const keeperId = keepers[gid] ?? g.members[0].id;
              const nameOnly = g.reason === "name"; // weak signal — no phone/email corroboration
              const busy = mergingId !== null;
              return (
                <div key={gid} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{fillText(t("cu_records"), { n: String(g.members.length) })}</span>
                    <Badge tone={nameOnly ? "red" : "amber"}>{fillText(t("cu_matchedBy"), { reason: reasonWords(g.reason) })}</Badge>
                    {nameOnly && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                        <AlertTriangle className="h-3.5 w-3.5" /> {t("cu_sameNameOnly")}
                      </span>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    {g.members.map((m) => (
                      <label key={m.id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${keeperId === m.id ? "border-brand bg-brand/5" : "border-slate-100"}`}>
                        <input
                          type="radio"
                          name={`dupe-${gid}`}
                          checked={keeperId === m.id}
                          onChange={() => setKeepers((k) => ({ ...k, [gid]: m.id }))}
                          className="mt-0.5"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium text-slate-900">{m.name || t("cu_noName")}</span>
                          {m.company_name ? <span className="text-slate-400"> · {m.company_name}</span> : null}
                          <span className="block text-xs text-slate-500">
                            {[m.email, m.phone].filter(Boolean).join(" · ") || t("cu_noContactInfo")}
                            {m.created_at ? fillText(t("cu_addedOn"), { date: m.created_at.slice(0, 10) }) : ""}
                          </span>
                        </span>
                        {keeperId === m.id && <span className="text-xs font-semibold text-brand">{t("cu_keep")}</span>}
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" onClick={() => mergeGroup(g)} disabled={busy}>
                      {mergingId === gid ? <Loader2 className="h-4 w-4 animate-spin" /> : <Merge className="h-4 w-4" />}
                      {fillText(t("cu_btn_mergeIntoKept"), { n: String(g.members.length - 1) })}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </>
  );
}
