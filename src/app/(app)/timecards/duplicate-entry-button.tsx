"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { duplicateTimeEntry } from "../timeclock/actions";
import { useToast } from "@/components/toast";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

type Member = {
  id: string;
  full_name: string | null;
  // The page hands this list straight from `profile_pay` (the same source the edit
  // modal reads), so the pay columns ride along. Nothing here shows or sends them.
  hourly_rate?: number | null;
  bill_rate?: number | null;
};

/**
 * COPY THIS TIMECARD *FOR SOMEBODY* (Erik, 2026-09-18).
 *
 * "I'm supposed to be able to copy this time card for jimmy who worked with me."
 *
 * This was a one-tap duplicate onto THE SAME PERSON, which is the one write the sanity
 * trigger can never accept (a byte-identical second shift for one person), so every tap
 * ended in a refusal and the control could not succeed at anything. Two men on one job
 * for the same hours is the most ordinary day in this trade, so the control is now a
 * picker: tap the person the shift also belongs to, and it lands on them.
 *
 * The refusal, when there is one, is the app's normal toast in plain words, not a red
 * slab across the page.
 */
export function DuplicateEntryButton({
  id,
  profileId,
  personName,
  members,
}: {
  id: string;
  /** Whose shift this is, so the picker can mark them instead of offering a copy that
   *  can only be refused. Optional: without it the server still answers in plain words. */
  profileId?: string | null;
  personName?: string | null;
  /** The org's active members, already fetched by the page for the edit modal. */
  members?: Member[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  // The page owns this list (same source as the edit modal). When a caller hasn't got it
  // to hand, the picker loads it itself rather than opening empty: a picker with nobody in
  // it is a dead end, and this control has no other way to do its one job. Same shape the
  // rest of the app reads members with (active, by name); RLS keeps it to this org.
  const given = members ?? [];
  const [loaded, setLoaded] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    // loadError is in the guard as well as the deps: without it a failed fetch (loading
    // false, loaded still null) re-armed this effect and hammered the network forever.
    if (!open || given.length > 0 || loaded || loading || loadError) return;
    let alive = true;
    setLoading(true);
    (async () => {
      const { data, error } = await createClient()
        .from("profiles")
        .select("id, full_name")
        .eq("active", true)
        .order("full_name");
      if (!alive) return;
      setLoading(false);
      if (error) {
        setLoadError("Couldn't load the crew list. Close this and open it again.");
        return;
      }
      setLoaded((data ?? []) as Member[]);
    })();
    return () => {
      alive = false;
    };
  }, [open, given.length, loaded, loading, loadError]);

  const list = given.length > 0 ? given : (loaded ?? []);
  // Do we actually KNOW the crew yet? Without this the first frame after opening (before the
  // effect runs) claimed "nobody on the crew", which is a lie that flashes.
  const known = given.length > 0 || loaded !== null;
  const isSource = (m: Member) => !!profileId && m.id === profileId;
  const others = list.filter((m) => !isSource(m));

  function copyTo(m: Member) {
    setBusyId(m.id);
    start(async () => {
      let res: { ok: boolean; error?: string; warning?: string; message?: string };
      try {
        res = await duplicateTimeEntry(id, m.id);
      } catch {
        setBusyId(null);
        toast("No connection, so that didn't go through. Try again in a moment.", "error");
        return;
      }
      setBusyId(null);
      if (!res?.ok) {
        // Stay open on a refusal: he can pick someone else without starting over.
        toast(res?.error ?? "That copy didn't go through. Try again.", "error");
        return;
      }
      toast(res.message ?? `Copied to ${m.full_name ?? "them"}.`, "success");
      if (res.warning) toast(res.warning, "info");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          // Reopening is the retry the message promises, so the last failure is cleared here.
          setLoadError(null);
          setOpen(true);
        }}
        /* EXACTLY the pencil's className, and nothing more. This carried
           `relative after:absolute after:-inset-1.5` to grow a 22px icon into a thumb
           target — but the row wrapper already does that: timecard-stack.tsx stretches
           BOTH controls with `[&>button]:h-11 [&>button]:w-11`, so this is a real 44x44
           box before any pseudo-element runs. The ::after was therefore a transparent,
           still-hit-testable 56x56 overlay reaching 6px past every edge, including 6px
           over the pencil sitting right beside it with no gap. Positioned descendants
           paint (and hit-test) above the in-flow content of later siblings, and the
           pencil is neither positioned nor z-indexed, so a thumb landing on its left
           edge opened Copy To instead of the editor — on the very row Erik reported
           for alignment. The row owns the 44px; this button owns the icon. */
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
        title="Copy To…"
        aria-label="Copy This Timecard To Someone"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>

      {/* ── PORTAL, BECAUSE THIS PICKER OPENS FROM A ROW INSIDE THE WEEK STACK ──────────────
          Same trap the pencil beside it just escaped (edit-entry-button.tsx). Modal renders IN
          PLACE by default, and this one is mounted from the stack's row: inside
          `<span className="pointer-events-auto …">`, inside `<Card className="overflow-clip">`,
          inside the stack's own `max-h-[70dvh] overflow-y-auto` scroller. That pair is what
          catches an in-place fixed overlay on Erik's iPhone — which is report 3, "Alignment and
          visibility". Without this the fix for report 2 would ship carrying the defect from
          report 3: he taps Copy and the crew list is clipped inside the week card.

          Safe here by the documented rule: NO <form> wraps this Modal and the footer is a plain
          Button with onClick, so nothing depends on DOM nesting to submit.
          See Modal's `portal` prop and [[modal-in-glass-menu-portal]]. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Copy To"
        size="sm"
        portal
        footer={
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            {personName
              ? `Same shift, for whoever worked it alongside ${personName}.`
              : "Same shift, for whoever worked it alongside this person."}{" "}
            The times, job, job code, lunch and notes come along. Miles and any pay rate
            override stay on the original.
          </p>

          {!known && !loadError && <p className="text-sm text-slate-500">Loading the crew…</p>}
          {loadError && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{loadError}</p>
          )}

          {known && others.length === 0 && (
            <p className="text-sm text-slate-600">
              {list.length === 0
                ? "Nobody on the crew yet. Add people in Settings, then copy this shift to them."
                : "Nobody else on the crew yet. Add people in Settings, then copy this shift to them."}
            </p>
          )}

          {others.length > 0 && (
            <div className="space-y-2">
              {others.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => copyTo(m)}
                  disabled={pending}
                  className="flex min-h-[44px] w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left text-sm font-medium text-slate-800 hover:border-brand hover:bg-slate-50 disabled:opacity-50"
                >
                  <span>{m.full_name ?? "Unnamed"}</span>
                  {busyId === m.id && <span className="text-xs text-slate-500">Copying…</span>}
                </button>
              ))}
            </div>
          )}

          {/* The person who already has these hours, shown and not offered: tapping them
              could only ever come back as a refusal. */}
          {profileId && list.some(isSource) && (
            <p className="text-xs text-slate-400">
              {`${list.find(isSource)?.full_name ?? "This person"} already has these hours on this entry.`}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
