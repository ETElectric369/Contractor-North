"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { assignMemberToJob } from "./actions";

interface MemberRow {
  id: string;
  full_name: string | null;
}
interface JobOpt {
  id: string;
  job_number: string;
  name: string;
}

/**
 * The office's crew-assignment list on /timeclock (staff only): every active member
 * with a Select of active jobs showing where they're assigned today. Changing it calls
 * assignMemberToJob — one active job per person (removed from the others, added to the
 * chosen one via the canonical setJobCrew), and the member gets the bell + "assigned"
 * push. This is what a tech's job-less Clock In resolves against.
 */
export function CrewAssignments({
  members,
  jobs,
  current,
}: {
  members: MemberRow[];
  jobs: JobOpt[];
  current: Record<string, string>;
}) {
  const router = useRouter();
  const [assign, setAssign] = useState<Record<string, string>>(current);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onChange(memberId: string, jobId: string) {
    const prev = assign[memberId] ?? "";
    setAssign((p) => ({ ...p, [memberId]: jobId }));
    setBusyId(memberId);
    setError(null);
    try {
      const res = await assignMemberToJob(memberId, jobId || null);
      if (!res.ok) {
        setAssign((p) => ({ ...p, [memberId]: prev })); // roll the picker back
        setError(res.error ?? "Could not update the assignment.");
      } else {
        router.refresh();
      }
    } catch {
      setAssign((p) => ({ ...p, [memberId]: prev }));
      setError("No connection — try again.");
    } finally {
      setBusyId(null);
    }
  }

  if (!members.length) return null;

  return (
    <Card>
      <CardContent className="py-5">
        <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-900">
          <Users className="h-4 w-4 text-slate-400" /> Today&apos;s crew assignments
        </h3>
        <p className="mb-3 text-xs text-slate-500">
          Who&apos;s on which job — a tech&apos;s Clock In lands on their assigned job automatically.
        </p>
        <div className="space-y-2">
          {members.map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate text-sm font-medium text-slate-700">
                {m.full_name ?? "—"}
              </span>
              <Select
                value={assign[m.id] ?? ""}
                onChange={(e) => onChange(m.id, e.target.value)}
                disabled={busyId === m.id}
                className="h-9 min-w-0 flex-1"
                aria-label={`Job for ${m.full_name ?? "member"}`}
              >
                <option value="">— No job —</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.job_number} · {j.name}
                  </option>
                ))}
              </Select>
              {busyId === m.id && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />}
            </div>
          ))}
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
