"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Search, X } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { linkAppointmentTo, searchLinkTargets, type LinkTarget } from "../actions";

/**
 * WHAT IS THIS VISIT FOR — one control over three tables.
 *
 * Erik: "if there is a lead to pick or match to the inspection then yes it should fill whatever
 * data it has naturally, if i start an inspection yes i should be able to connect it to something
 * that exists, fragment first, simplicity rules."
 *
 * ONE BOX, NOT THREE PICKERS. Lead, customer and job are three tables and one idea — "who this is
 * for". Three labelled dropdowns would force a person to classify the thing before they can find
 * it, and standing at a job the honest answer is "it's the Cain place", not "it is an inquiry
 * record". So the kind is an OUTCOME of the pick, not a question asked first.
 *
 * FRAGMENT FIRST. Nothing is required. You can capture a whole walk-through connected to nothing
 * and link it afterwards — or never. This is an offer, not a gate. It exists because the create
 * paths made linking impossible, not because a person was careless: only 2 of the 7 doors that
 * make an inspection can set `inquiry_id` at all, which is why 10 of 13 in production float free.
 *
 * IT OFFERS THE MATCH. When the address is already typed, that text seeds the search — so the
 * common case is "look down, the Cain lead is already sitting there, tap it" rather than
 * remembering a name and typing it again. Matching on address is the whole point: the address is
 * the fact that names the lead, the estimate, the job and the invoice.
 */
export function LinkPicker({
  appointmentId,
  linked,
  seed,
}: {
  appointmentId: string;
  /** What it's already connected to, for the resting state. */
  linked: { kind: LinkTarget["kind"]; name: string } | null;
  /** The address typed on this visit — used to offer matches without anyone typing twice. */
  seed: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LinkTarget[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);

  // Debounced, and last-response-wins: typing fast otherwise lets a slow early query overwrite
  // the results for what is actually in the box.
  useEffect(() => {
    const term = q.trim() || seed.trim();
    if (timer.current) clearTimeout(timer.current);
    if (term.length < 2) {
      setRows([]);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      const mine = ++reqId.current;
      searchLinkTargets(term)
        .then((r) => {
          if (mine === reqId.current) setRows(r);
        })
        .finally(() => {
          if (mine === reqId.current) setSearching(false);
        });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q, seed, open]);

  const TONE: Record<LinkTarget["kind"], string> = {
    lead: "bg-emerald-100 text-emerald-800",
    customer: "bg-blue-100 text-blue-800",
    job: "bg-slate-200 text-slate-700",
  };

  if (linked && !open) {
    return (
      <div className="mt-3">
        <Label className="mb-1.5">For</Label>
        <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[linked.kind]}`}>{linked.kind}</span>
          <span className="flex-1 truncate text-sm text-slate-700">{linked.name}</span>
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-slate-500 underline-offset-2 hover:underline">
            change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        <Label className="mb-1.5">For</Label>
        {open && (
          <button type="button" onClick={() => setOpen(false)} className="mb-1.5 text-slate-400">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 text-sm text-slate-500 active:bg-slate-50"
        >
          <Link2 className="h-4 w-4" />
          {/* Says what it DOES, not what it is. "Link a record" means nothing at a job site. */}
          Connect this to a lead, customer or job
        </button>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              autoFocus
              value={q}
              placeholder={seed.trim() ? `Searching “${seed.trim()}” — or type a name` : "Name or address"}
              onChange={(e) => setQ(e.target.value)}
              className="pl-9"
            />
          </div>
          <div className="mt-2 space-y-1">
            {searching && (
              <p className="flex items-center gap-1.5 px-1 py-2 text-xs text-slate-400">
                <Loader2 className="h-3 w-3 animate-spin" /> looking…
              </p>
            )}
            {!searching && rows.length === 0 && (q.trim() || seed.trim()).length >= 2 && (
              // Not an error. Working unattached is a legitimate outcome, not a failure state.
              <p className="px-1 py-2 text-xs text-slate-400">
                Nothing matches yet — carry on, you can connect this later.
              </p>
            )}
            {rows.map((r) => (
              <button
                key={`${r.kind}:${r.id}`}
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await linkAppointmentTo(appointmentId, r.kind, r.id);
                    if (res.ok) {
                      setOpen(false);
                      router.refresh();
                    }
                  })
                }
                className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left active:bg-slate-50"
              >
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[r.kind]}`}>{r.kind}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-slate-800">{r.name}</span>
                  <span className="block truncate text-xs text-slate-400">{r.address ?? r.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
