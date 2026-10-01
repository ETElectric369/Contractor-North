"use client";

import { useEffect, useState } from "react";
import { Label, Select } from "@/components/ui/input";
import { jobScopeOptions } from "@/app/(app)/bills/scope-actions";

/**
 * THE ONE SCOPE QUESTION, drawn the same way at every door that writes or edits a cost (item C1).
 *
 * Which part of the job a cost belongs to is what joins ACTUAL spend to the estimate's BUDGET by
 * scope, so Chris can see that framing specifically is over while decking has not started. Before
 * this, ONE door in the app asked it: the AI reading a snapped receipt. Type the cost in, file it
 * from the tray or ask Nort and the same $900 of decking landed under nothing — and no screen could
 * set it afterwards.
 *
 * ONE PLACE, so four doors cannot drift: the words ("Part Of The Job"), the options, when the
 * question appears at all, and what it does when the estimate can't be read all live here.
 *   · no job picked yet, or this job's estimate isn't broken into parts → NOTHING is drawn. There is
 *     nothing to ask, and an empty dropdown is a dead end.
 *   · the estimate couldn't be read → it SAYS so (nothing silent) instead of quietly vanishing.
 * 44px target, phone first. Staff only: the server action behind it is requireStaff, so a tech is
 * never shown a control that would refuse (TECHS NEVER SEE PRICES, and these words are the estimate's).
 */
export function JobScopePicker({
  jobId,
  value,
  onChange,
  id = "cost-scope",
  className,
}: {
  /** The job this cost is on. null/"" (a business cost) draws nothing. */
  jobId: string | null | undefined;
  /** The stored part, or "" for none of them. */
  value: string | null | undefined;
  onChange: (next: string) => void;
  id?: string;
  className?: string;
}) {
  const [scopes, setScopes] = useState<string[] | null>(null);
  const [unread, setUnread] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!jobId) {
      setScopes(null);
      setUnread(null);
      return;
    }
    setScopes(null);
    setUnread(null);
    void jobScopeOptions(jobId).then((res) => {
      if (!alive) return;
      setScopes(res.scopes);
      setUnread(res.unread ? (res.error ?? "Couldn't read this job's estimate, so the parts of the job aren't listed.") : null);
    });
    return () => {
      alive = false;
    };
  }, [jobId]);

  // A PART THE JOB NO LONGER HAS IS STILL SHOWN, so the dropdown can never silently re-file a cost
  // under nothing just by being opened: the stored word rides in the list, and saving it again
  // saves what is already there.
  const stored = String(value ?? "").trim();
  const options = scopes && stored && !scopes.includes(stored) ? [stored, ...scopes] : scopes;

  if (!jobId) return null;
  if (unread)
    return (
      <p className={`text-sm text-amber-800 ${className ?? ""}`} role="alert">
        {unread}
      </p>
    );
  // Still loading, or this job's estimate has no parts: nothing to ask.
  if (!options || options.length === 0) return null;

  return (
    <div className={className}>
      <Label htmlFor={id}>Part Of The Job</Label>
      <Select id={id} className="h-11" value={stored} onChange={(e) => onChange(e.target.value)}>
        <option value="">No Part Of The Job</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </Select>
      <p className="mt-1 text-xs text-slate-500">
        This is what puts the spend beside the part of the estimate it belongs to.
      </p>
    </div>
  );
}
