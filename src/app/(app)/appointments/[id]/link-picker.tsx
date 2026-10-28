"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Loader2, Search, UserPlus, X } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { useToast } from "@/components/toast";
import { linkAppointmentTo, linkAppointmentToNewLead, searchLinkTargets, type LinkTarget } from "../actions";

/** What a tap that never reached the server says (the same words the visit's other buttons use). */
export const LINK_NO_SIGNAL_LINE = "No connection, so that didn't go through. Try again when you have a bar or two.";

/** What a link write came to: its answer, or the ONE line to show. A refusal speaks in the action's own
 *  words (or the caller's fallback); a throw is a tap that never landed. Never rethrows — a rejected
 *  server action used to escape the transition with nothing said and the picker still open. */
export async function settleLink<T extends { ok: boolean; error?: string }>(
  what: Promise<T>,
  fallback: string,
): Promise<{ res: T } | { error: string }> {
  let res: T;
  try {
    res = await what;
  } catch {
    return { error: LINK_NO_SIGNAL_LINE };
  }
  if (!res?.ok) return { error: res?.error ?? fallback };
  return { res };
}

/**
 * WHAT IS THIS VISIT FOR — one control over three tables.
 *
 * Erik: "if there is a lead to pick or match to the inspection then yes it should fill whatever
 * data it has naturally, if i start an inspection yes i should be able to connect it to something
 * that exists, fragment first, simplicity rules."
 *
 * ONE BOX, NOT THREE PICKERS. Lead, customer and job are three tables and one idea — "who this is
 * for". Three labelled dropdowns would force a person to classify the thing before they can find
 * it, and standing at a job the honest answer is "it's the Dale place", not "it is an inquiry
 * record". So the kind is an OUTCOME of the pick, not a question asked first.
 *
 * FRAGMENT FIRST. Nothing is required. You can capture a whole inspection connected to nothing
 * and link it afterwards — or never. This is an offer, not a gate. It exists because the create
 * paths made linking impossible, not because a person was careless: only 2 of the 7 doors that
 * make an inspection can set `inquiry_id` at all, which is why 10 of 13 in production float free.
 *
 * IT OFFERS THE MATCH. When the address is already typed, that text seeds the search — so the
 * common case is "look down, the Dale lead is already sitting there, tap it" rather than
 * remembering a name and typing it again. Matching on address is the whole point: the address is
 * the fact that names the lead, the estimate, the job and the invoice.
 */
export function LinkPicker({
  appointmentId,
  linked,
  seed,
  kinds = null,
  openLabel = "Connect this to a lead, customer or job",
  label = "For",
}: {
  appointmentId: string;
  /** What it's already connected to, for the resting state. */
  linked: { kind: LinkTarget["kind"]; name: string } | null;
  /** The address typed on this visit — used to offer matches without anyone typing twice. */
  seed: string;
  /** Only these kinds are offered (the ending card's "Won · Pick The Job" is jobs only). null: all three. */
  kinds?: LinkTarget["kind"][] | null;
  /** The words on the closed picker's one button. */
  openLabel?: string;
  /** The small label over the box; null draws none (inside a card that already says what it is). */
  label?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<LinkTarget[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqId = useRef(0);
  // A NAME THAT MATCHES NOTHING IS OFFERED AS A NEW LEAD (Erik 2026-10-14, the Catbird visit: the
  // owner's name typed from memory "does not save to who is it for"). Only what the person TYPED
  // (never the address seed), only where a lead may be picked, and never while a search is running.
  const typed = q.replace(/\s+/g, " ").trim();
  const offerLead = !searching && open && typed.length >= 2 && (!kinds || kinds.includes("lead")) && !rows.some((r) => r.name.trim().toLowerCase() === typed.toLowerCase());

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
          if (mine === reqId.current) setRows(kinds ? r.filter((x) => kinds.includes(x.kind)) : r);
        })
        .finally(() => {
          if (mine === reqId.current) setSearching(false);
        });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- kinds is a stable literal per mount
  }, [q, seed, open]);

  const TONE: Record<LinkTarget["kind"], string> = {
    lead: "bg-emerald-100 text-emerald-800",
    customer: "bg-blue-100 text-blue-800",
    job: "bg-slate-200 text-slate-700",
  };

  if (linked && !open) {
    return (
      <div className="mt-3">
        {label && <Label className="mb-1.5">{label}</Label>}
        <div className="flex min-h-[44px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3">
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[linked.kind]}`}>{linked.kind}</span>
          <span className="flex-1 truncate text-sm text-slate-700">{linked.name}</span>
          <button type="button" onClick={() => setOpen(true)} className="text-xs text-slate-500 underline-offset-2 hover:underline">
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between">
        {label ? <Label className="mb-1.5">{label}</Label> : <span />}
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
          {openLabel}
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
                {kinds?.length === 1 && kinds[0] === "job" ? "No job matches yet — try the street or the customer's name." : offerLead ? "Nobody by that name yet." : "Nothing matches yet — carry on, you can connect this later."}
              </p>
            )}
            {offerLead && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const done = await settleLink(linkAppointmentToNewLead(appointmentId, typed), "Couldn't make the lead.");
                    if ("error" in done) {
                      setError(done.error);
                      return;
                    }
                    // The lead door's own word (several customers share the name, so it is linked to
                    // none) must be READ: the picker closes on ok, as the form does.
                    if (done.res.note) toast(done.res.note, "info", undefined, { sticky: true });
                    setOpen(false);
                    router.refresh();
                  })
                }
                className="flex min-h-[44px] w-full items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-left active:bg-emerald-100"
              >
                <UserPlus className="h-4 w-4 shrink-0 text-emerald-700" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-emerald-900">Add As A New Lead</span>
                  <span className="block truncate text-xs text-emerald-800/80">{typed} — this visit&rsquo;s address goes on the lead</span>
                </span>
              </button>
            )}
            {error && (
              <p role="alert" className="px-1 py-1 text-xs text-red-700">
                {error}
              </p>
            )}
            {rows.map((r) => (
              <button
                key={`${r.kind}:${r.id}`}
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const done = await settleLink(linkAppointmentTo(appointmentId, r.kind, r.id), "Couldn't connect it — try again.");
                    if ("error" in done) {
                      setError(done.error);
                      return;
                    }
                    if (done.res.warning) toast(done.res.warning, "info", undefined, { sticky: true });
                    // What the visit's work did on the job it won (cn-v1134: "3 tasks and 7 parts joined
                    // J-055 (…)", "Nothing was typed on the visit, so J-055 is as it was."): the door's own
                    // sentence, said as the ending card says Marked Lost. A failure rides the warning above.
                    if (done.res.note) toast(done.res.note, "success");
                    setOpen(false);
                    router.refresh();
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
