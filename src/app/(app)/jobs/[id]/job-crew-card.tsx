"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { initials } from "@/lib/utils";
import { applyCrewChange, type CrewChange } from "@/lib/crew-change";
import { changeJobCrew } from "../../schedule/actions";

export type CrewMember = { id: string; full_name: string | null };

const CHIP = "inline-flex min-h-11 items-center gap-2 rounded-full bg-slate-100 py-1 pl-1 pr-3 text-sm text-slate-700";

function Avatar({ name }: { name: string | null }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-[10px] font-semibold text-white">
      {initials(name ?? "")}
    </span>
  );
}

/**
 * THE CREW LOGIC, ONCE: the job page's crew card and the schedule tile's sheet (its initials chips)
 * both run this, never a second copy. The chips move at once and move back if the write is refused,
 * with the refusal said in a toast; every change is ONE person on or off through changeJobCrew, which
 * applies it to the crew as saved now and writes through setJobCrew, the job's one crew writer (it
 * rings the bell for someone new).
 */
export function useJobCrew(jobId: string, initialCrew: CrewMember[], team: CrewMember[]) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [crew, setCrew] = useState<string[]>(initialCrew.map((c) => c.id));
  // SERVER TRUTH COMES BACK IN. A refresh never remounts this card (any save on the Overview re-renders
  // the page around it), so when the server's crew changes and no write of ours is in flight, the chips
  // take it: the card never keeps showing a crew the page no longer has. React's "adjust state while
  // rendering" idiom, keyed on the server's ids in their stored order.
  const serverKey = initialCrew.map((c) => c.id).join(",");
  const [seenKey, setSeenKey] = useState(serverKey);
  if (serverKey !== seenKey && !pending) {
    setSeenKey(serverKey);
    setCrew(initialCrew.map((c) => c.id));
  }
  const [asking, setAsking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const known = new Map<string, CrewMember>([...team, ...initialCrew].map((m) => [m.id, m]));
  const nameOf = (id: string) => known.get(id)?.full_name ?? "Unnamed";

  // The optimistic move must be BACKED OUT when the write fails, or the card lies: a refresh never
  // remounts it, and useState ignores its initializer on re-render. The try/catch is not optional:
  // an async transition's rejection (offline, 5xx) otherwise reaches no handler at all.
  function write(change: CrewChange, said: string) {
    const prev = crew;
    setCrew(applyCrewChange(crew, change));
    setAsking(null);
    setAdding(false);
    start(async () => {
      try {
        const res = await changeJobCrew(jobId, change);
        if (!res.ok) {
          setCrew(prev);
          toast(res.error ?? `Couldn't ${said}. Try again.`, "error");
          return;
        }
        // The refresh brings the crew as written (which may hold someone this page hadn't seen yet),
        // and the server-truth sync above puts it on the chips once this write settles.
        router.refresh();
      } catch {
        setCrew(prev);
        toast(`Couldn't ${said}. You may be offline.`, "error");
      }
    });
  }

  const addable = team.filter((m) => !crew.includes(m.id));
  return { crew, pending, asking, setAsking, adding, setAdding, write, nameOf, addable };
}

/** The two panels a crew chip opens: "Take Brian Off This Job?" and the team list for + Add. */
function CrewPanels({ c }: { c: ReturnType<typeof useJobCrew> }) {
  const { asking, setAsking, adding, addable, write, nameOf } = c;
  return (
    <>
      {asking && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <span className="mr-auto">Take {nameOf(asking)} Off This Job?</span>
          <Button variant="outline" className="text-red-600" onClick={() => write({ remove: asking }, `take ${nameOf(asking)} off this job`)}>
            <X className="h-4 w-4" /> Take Off
          </Button>
          <Button variant="ghost" onClick={() => setAsking(null)}>
            Keep
          </Button>
        </div>
      )}

      {adding && (
        <div className="mt-3 rounded-lg border border-slate-200">
          {addable.length === 0 ? (
            <p className="px-3 py-3 text-sm text-slate-500">Everyone on the team is on this job.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {addable.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => write({ add: m.id }, `put ${m.full_name ?? "them"} on this job`)}
                    className="flex min-h-11 w-full items-center gap-2 px-3 text-left text-sm text-slate-700 hover:bg-slate-50"
                  >
                    <Avatar name={m.full_name} />
                    {m.full_name ?? "Unnamed"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** The + Add chip, the same on the card and the sheet. */
function AddChip({ c }: { c: ReturnType<typeof useJobCrew> }) {
  return (
    <button
      type="button"
      disabled={c.pending}
      aria-expanded={c.adding}
      onClick={() => {
        c.setAsking(null);
        c.setAdding((v) => !v);
      }}
      className="inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 text-sm font-medium text-brand hover:bg-slate-50 disabled:opacity-60"
    >
      <Plus className="h-4 w-4" /> Add
    </button>
  );
}

/**
 * THE CREW, ON THE OVERVIEW (W1-22): who is on this job, where the job is read, instead of a
 * checkbox list inside Edit Job. The office: each person is a 44px chip; tapping one asks "Take Brian
 * Off This Job?" and takes him off; "+ Add" opens the team to put someone on. Both go through
 * changeJobCrew (useJobCrew above). The crew reads the same chips, not tappable.
 */
export function JobCrewCard({
  jobId,
  crew: initialCrew,
  team = [],
  viewerIsStaff,
}: {
  jobId: string;
  /** The people on the job now (jobs.assigned_to, by name). */
  crew: CrewMember[];
  /** The office only: the active team, for + Add. */
  team?: CrewMember[];
  viewerIsStaff: boolean;
}) {
  const c = useJobCrew(jobId, initialCrew, team);
  const { crew, pending, asking, setAsking, nameOf } = c;

  if (!viewerIsStaff) {
    return (
      <Card>
        <CardContent className="py-5">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Crew</div>
          <div className="flex flex-wrap gap-2">
            {initialCrew.length === 0 && <span className="text-sm text-slate-400">No one is on this job yet.</span>}
            {initialCrew.map((s) => (
              <span key={s.id} className={CHIP}>
                <Avatar name={s.full_name} />
                {s.full_name ?? "Unnamed"}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Crew</div>
        <div className="flex flex-wrap items-center gap-2">
          {crew.length === 0 && <span className="text-sm text-slate-400">No one is on this job yet.</span>}
          {crew.map((id) => (
            <button
              key={id}
              type="button"
              disabled={pending}
              aria-pressed={asking === id}
              onClick={() => setAsking((cur) => (cur === id ? null : id))}
              className={`${CHIP} hover:bg-slate-200 disabled:opacity-60 ${asking === id ? "ring-2 ring-brand" : ""}`}
            >
              <Avatar name={nameOf(id)} />
              {nameOf(id)}
            </button>
          ))}
          <AddChip c={c} />
        </div>
        <CrewPanels c={c} />
      </CardContent>
    </Card>
  );
}

/**
 * THE CREW AS INITIALS, for the schedule tile's sheet (text to visual: the job and who's on it). The
 * same logic as the card (useJobCrew): tap a person to take them off, + Add to put someone on, and a
 * dashed "Nobody" when the job has no crew yet (blank is a fact, never an empty space). 44px chips.
 * `canEdit` false (the crew) reads the same chips with nothing to tap.
 */
export function JobCrewChips({
  jobId,
  crew: initialCrew,
  team = [],
  canEdit = true,
}: {
  jobId: string;
  crew: CrewMember[];
  team?: CrewMember[];
  canEdit?: boolean;
}) {
  const c = useJobCrew(jobId, initialCrew, team);
  const { crew, pending, asking, setAsking, nameOf } = c;
  const dot = "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-white";
  const nobody = (
    <span className="inline-flex h-11 items-center rounded-full border border-dashed border-slate-300 px-3 text-sm text-slate-400">
      Nobody
    </span>
  );

  if (!canEdit) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {initialCrew.length === 0 && nobody}
        {initialCrew.map((s) => (
          <span key={s.id} className={dot} title={s.full_name ?? "Unnamed"} aria-label={s.full_name ?? "Unnamed"}>
            {initials(s.full_name ?? "")}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {crew.length === 0 && nobody}
        {crew.map((id) => (
          <button
            key={id}
            type="button"
            disabled={pending}
            aria-pressed={asking === id}
            aria-label={nameOf(id)}
            title={nameOf(id)}
            onClick={() => setAsking((cur) => (cur === id ? null : id))}
            className={`${dot} disabled:opacity-60 ${asking === id ? "ring-2 ring-brand ring-offset-2" : ""}`}
          >
            {initials(nameOf(id))}
          </button>
        ))}
        <AddChip c={c} />
      </div>
      <CrewPanels c={c} />
    </div>
  );
}
