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

export function DuplicatesButton() {
  const router = useRouter();
  const toast = useToast();
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
      if (!res.ok) { toast(res.error ?? "Couldn't scan contacts."); setOpen(false); return; }
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
        if (!res.ok) { toast(res.error ?? "Merge failed."); return; }
      }
      toast(`Merged ${others.length} duplicate${others.length === 1 ? "" : "s"} in.`);
      setGroups((gs) => (gs ?? []).filter((x) => groupId(x) !== gid));
      router.refresh();
    } finally {
      setMergingId(null);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline" onClick={scan}>
        <CopyCheck className="h-4 w-4" /> Find duplicates
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Find & merge duplicate contacts">
        {loading || groups === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Scanning your contact book…
          </div>
        ) : groups.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            No likely duplicates found — your contact book looks clean. 🎉
          </p>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-500">
              {groups.length} possible duplicate group{groups.length === 1 ? "" : "s"}. Pick the record to <strong>keep</strong> — everything attached to the others (jobs, quotes, invoices) moves to it, then the extras are deleted.
            </p>
            {groups.map((g) => {
              const gid = groupId(g);
              const keeperId = keepers[gid] ?? g.members[0].id;
              const nameOnly = g.reason === "name"; // weak signal — no phone/email corroboration
              const busy = mergingId !== null;
              return (
                <div key={gid} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">{g.members.length} records</span>
                    <Badge tone={nameOnly ? "red" : "amber"}>matched by {g.reason}</Badge>
                    {nameOnly && (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600">
                        <AlertTriangle className="h-3.5 w-3.5" /> same name only — verify these are the same person before merging
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
                          <span className="font-medium text-slate-900">{m.name || "(no name)"}</span>
                          {m.company_name ? <span className="text-slate-400"> · {m.company_name}</span> : null}
                          <span className="block text-xs text-slate-500">
                            {[m.email, m.phone].filter(Boolean).join(" · ") || "no contact info"}
                            {m.created_at ? ` · added ${m.created_at.slice(0, 10)}` : ""}
                          </span>
                        </span>
                        {keeperId === m.id && <span className="text-xs font-semibold text-brand">keep</span>}
                      </label>
                    ))}
                  </div>
                  <div className="mt-2 flex justify-end">
                    <Button size="sm" onClick={() => mergeGroup(g)} disabled={busy}>
                      {mergingId === gid ? <Loader2 className="h-4 w-4 animate-spin" /> : <Merge className="h-4 w-4" />}
                      Merge {g.members.length - 1} into kept
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
