"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatDate } from "@/lib/utils";
import { copyPlace, type DuplicateBillGroup, type SupplierActionResult } from "./supplier-balance";

export interface SupplierDuplicateActions {
  /**
   * HE picks which job keeps the ticket. The other copy is marked as the duplicate so it stops
   * counting as that job's cost - and NOTHING IS DELETED, by contract. Both rows stay in the bills
   * list, where he can still open, edit or remove either one himself.
   */
  resolveDuplicate: (input: {
    groupId: string;
    keepBillId: string;
    duplicateBillIds: string[];
  }) => Promise<SupplierActionResult>;
  /** Optional, and asked for: put the group back the way it was. A pick on a phone can be a mis-tap. */
  unresolveDuplicate?: (groupId: string) => Promise<SupplierActionResult>;
}

/**
 * THE SAME TICKET, FILED TO TWO JOBS (Erik, 2026-09-18).
 *
 * An identical CED ticket - $95.27, eight lines, line for line to the penny - is filed to BOTH
 * "13631 Northwoods" (07-29, from the CED portal PDF) and "85 Whitney Place" (08-28, from a file
 * he saved as "85 Whit.pdf"). It is not a near match and not a guess: it is the same ticket twice,
 * which means one of those two jobs is carrying $95.27 of cost that is not its own, and its profit
 * is wrong by exactly that much. That is the quiet kind of wrong - both jobs look fine on their own.
 *
 * SAY IT OUT LOUD, AND THEN GET OUT OF THE WAY. Nothing here deletes a bill. Which copy is the
 * real one is Erik's knowledge - he was on those jobs - and two identical counter runs a month
 * apart are a perfectly ordinary thing for an electrician to do. He picks; the other copy stops
 * counting against the wrong job; both rows stay on the page.
 *
 * Built from whatever matched, never hard-coded to that one bill: the day a second duplicate is
 * scanned it shows up here the same way, with no code change.
 */
export function SupplierDuplicates({
  groups,
  actions,
}: {
  groups: DuplicateBillGroup[];
  actions: SupplierDuplicateActions;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; groupId: string | null } | null>(null);

  if (!groups.length) return null;

  function run(fn: () => Promise<SupplierActionResult>, key: string, fallback: string, undoGroupId?: string | null) {
    setError(null);
    setBusy(key);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (!res.ok) {
        setDone(null);
        setError(res.error ?? "Nothing was changed. Try again.");
        return;
      }
      setDone({ text: res.message ?? fallback, groupId: undoGroupId ?? null });
      router.refresh();
    });
  }

  const openGroups = groups.filter((g) => !g.resolution);

  return (
    <Card id="same-ticket-two-jobs" className="mb-6 scroll-mt-4 p-4">
      <div className="mb-3">
        <h2 className="text-base font-semibold text-slate-900">The Same Ticket On Two Jobs</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          {openGroups.length > 0
            ? "These receipts match line for line, to the penny, so one job is carrying a cost that is not its own. You say which job it belongs to. Nothing gets deleted either way."
            : "Nothing is waiting on you here. The picks you made are below, and you can change any of them."}
        </p>
      </div>

      {error && <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      {done && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5">
          <span className="min-w-0 text-sm text-slate-700">{done.text}</span>
          {done.groupId && actions.unresolveDuplicate && (
            <Button
              variant="outline"
              className="shrink-0"
              disabled={pending}
              onClick={() =>
                run(
                  () => actions.unresolveDuplicate!(done.groupId as string),
                  `unresolve:${done.groupId}`,
                  "Put back. Both copies are counting again, the way they were.",
                )
              }
            >
              <Undo2 className="h-4 w-4" /> Undo
            </Button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {groups.map((g) => {
          const kept = g.resolution ? (g.copies.find((c) => c.billId === g.resolution?.keptBillId) ?? null) : null;
          return (
            <div
              key={g.id}
              className={`rounded-lg border p-3 ${g.resolution ? "border-slate-200" : "border-amber-200 bg-amber-50/50"}`}
            >
              <p className={`text-sm font-medium ${g.resolution ? "text-slate-700" : "text-amber-900"}`}>
                {g.resolution
                  ? `${g.copies[0]?.supplier || "This ticket"} · ${formatCurrency(g.amount)} · you kept it on ${kept ? copyPlace(kept) : "one job"}.`
                  : `${g.copies[0]?.supplier || "This ticket"} · ${formatCurrency(g.amount)} · ${g.lineCount} ${g.lineCount === 1 ? "line" : "lines"}, filed ${g.copies.length} times and identical every time.`}
              </p>
              {!g.resolution && (
                <p className="mt-0.5 text-xs text-amber-800">
                  {g.copies.length === 2
                    ? `If that was one trip, one of these two jobs is carrying ${formatCurrency(g.amount)} that is not its own. Two identical runs a month apart are normal too, so nothing changes until you say which.`
                    : `If that was one trip, ${g.copies.length - 1} of these jobs are carrying ${formatCurrency(g.amount)} that is not theirs.`}
                </p>
              )}

              <ul className="mt-2 space-y-1.5">
                {g.copies.map((c) => {
                  const isKept = g.resolution?.keptBillId === c.billId;
                  const others = g.copies.filter((o) => o.billId !== c.billId).map((o) => o.billId);
                  return (
                    <li
                      key={c.billId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-white px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">
                          {copyPlace(c)}
                          {g.resolution ? (isKept ? " · kept here" : " · marked the duplicate") : ""}
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {c.billDate ? formatDate(c.billDate) : "No date"}
                          {c.source ? ` · ${c.source}` : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {c.jobId && (
                          <Link
                            href={`/jobs/${c.jobId}`}
                            className="flex min-h-11 items-center px-2 text-xs font-medium text-brand hover:underline"
                          >
                            Open The Job
                          </Link>
                        )}
                        {/* The job's name rides ON the button, so a tap at arm's length says what it
                            is doing without re-reading the row above it. Long addresses truncate
                            rather than shoving the row off a 375px phone. */}
                        {!g.resolution && (
                          <Button
                            variant="outline"
                            className="max-w-[60vw]"
                            disabled={pending && busy === `keep:${c.billId}`}
                            onClick={() =>
                              run(
                                () =>
                                  actions.resolveDuplicate({
                                    groupId: g.id,
                                    keepBillId: c.billId,
                                    duplicateBillIds: others,
                                  }),
                                `keep:${c.billId}`,
                                `Kept on ${copyPlace(c)}. The other copy stops counting as a job cost.`,
                                g.id,
                              )
                            }
                          >
                            <span className="min-w-0 truncate">Keep It On {copyPlace(c)}</span>
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>

              <p className="mt-2 text-xs leading-relaxed text-slate-500">
                {g.resolution ? (
                  <>
                    The other copy is still on file, marked as the duplicate, so it no longer counts against that
                    job.{" "}
                    {actions.unresolveDuplicate ? (
                      <button
                        type="button"
                        className="font-medium text-brand hover:underline"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => actions.unresolveDuplicate!(g.id),
                            `unresolve:${g.id}`,
                            "Put back. Both copies are counting again, the way they were.",
                          )
                        }
                      >
                        Change Your Mind
                      </button>
                    ) : (
                      <>To change it, open that bill in the list further down this page.</>
                    )}
                  </>
                ) : (
                  <>
                    Picking a job marks the other copy as the duplicate so it stops counting as that job&apos;s
                    cost. Neither one is deleted, and you can change your mind.
                  </>
                )}
              </p>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
