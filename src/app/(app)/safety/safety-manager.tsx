"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, AlertTriangle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs } from "@/components/tabs";
import { formatDate } from "@/lib/utils";
import { addSafetyRecord, deleteSafetyRecord } from "./actions";

interface Person { id: string; full_name: string | null; }
interface JobOpt { id: string; job_number: string; name: string; }
interface Rec {
  id: string;
  kind: string;
  record_date: string;
  title: string;
  profile_id: string | null;
  job_id: string | null;
  severity: string | null;
  recordable: boolean;
  description: string | null;
  attendees: string | null;
  profiles?: { full_name: string | null } | null;
  jobs?: { name: string } | null;
}

const SEV: Record<string, { tone: "slate" | "amber" | "red"; label: string }> = {
  first_aid: { tone: "slate", label: "First aid" },
  recordable: { tone: "amber", label: "Recordable" },
  lost_time: { tone: "red", label: "Lost time" },
};

export function SafetyManager({
  employees,
  jobs,
  records,
}: {
  employees: Person[];
  jobs: JobOpt[];
  records: Rec[];
}) {
  const incidents = records.filter((r) => r.kind === "incident");
  const toolbox = records.filter((r) => r.kind === "toolbox");
  return (
    <Tabs
      urlSync
      paramKey="kind"
      tabs={[
        {
          id: "incident",
          label: "Incidents",
          count: incidents.length,
          icon: <AlertTriangle className="h-4 w-4" />,
          content: <SafetyPanel kind="incident" employees={employees} jobs={jobs} records={incidents} />,
        },
        {
          id: "toolbox",
          label: "Toolbox talks",
          count: toolbox.length,
          icon: <Users className="h-4 w-4" />,
          content: <SafetyPanel kind="toolbox" employees={employees} jobs={jobs} records={toolbox} />,
        },
      ]}
    />
  );
}

function SafetyPanel({
  kind,
  employees,
  jobs,
  records,
}: {
  kind: "incident" | "toolbox";
  employees: Person[];
  jobs: JobOpt[];
  records: Rec[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [title, setTitle] = useState("");
  const [profileId, setProfileId] = useState("");
  const [jobId, setJobId] = useState("");
  const [severity, setSeverity] = useState("first_aid");
  const [recordable, setRecordable] = useState(false);
  const [attendees, setAttendees] = useState("");
  const [description, setDescription] = useState("");

  const isIncident = kind === "incident";

  function add() {
    setError(null);
    if (!title.trim()) return setError("Title is required.");
    start(async () => {
      const res = await addSafetyRecord({
        kind,
        record_date: date,
        title,
        profile_id: isIncident ? profileId || null : null,
        job_id: isIncident ? jobId || null : null,
        severity: isIncident ? severity : null,
        recordable: isIncident ? recordable : false,
        attendees: isIncident ? null : attendees,
        description,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setTitle(""); setProfileId(""); setJobId(""); setRecordable(false); setAttendees(""); setDescription("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><Label htmlFor="s-date">Date</Label><Input id="s-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="col-span-2 sm:col-span-3"><Label htmlFor="s-title">{isIncident ? "What happened *" : "Topic *"}</Label><Input id="s-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isIncident ? "e.g. Cut hand on conduit" : "e.g. Ladder safety"} /></div>
          {isIncident ? (
            <>
              <div><Label htmlFor="s-emp">Employee</Label><Select id="s-emp" value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name ?? "Unnamed"}</option>)}</Select></div>
              <div><Label htmlFor="s-job">Job</Label><Select id="s-job" value={jobId} onChange={(e) => setJobId(e.target.value)}><option value="">—</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>)}</Select></div>
              <div><Label htmlFor="s-sev">Severity</Label><Select id="s-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="first_aid">First aid only</option><option value="recordable">OSHA recordable</option><option value="lost_time">Lost time</option></Select></div>
              <label className="flex items-end gap-2 pb-2 text-sm text-slate-600"><input type="checkbox" checked={recordable} onChange={(e) => setRecordable(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" /> OSHA 300 recordable</label>
            </>
          ) : (
            <div className="col-span-2 sm:col-span-4"><Label htmlFor="s-att">Attendees</Label><Input id="s-att" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Names of crew present" /></div>
          )}
        </div>
        <div><Label htmlFor="s-desc">{isIncident ? "Details / corrective action" : "Notes"}</Label><Textarea id="s-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="flex justify-end"><Button size="sm" onClick={add} disabled={pending || !title.trim()}><Plus className="h-3.5 w-3.5" /> Add {isIncident ? "incident" : "talk"}</Button></div>
      </Card>

      <ul className="space-y-2">
        {records.map((r) => (
          <li key={r.id}>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                {isIncident ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> : <Users className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900">{r.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                    <span>{formatDate(r.record_date)}</span>
                    {r.profiles?.full_name && <span>· {r.profiles.full_name}</span>}
                    {r.jobs?.name && <span>· {r.jobs.name}</span>}
                    {r.attendees && <span>· {r.attendees}</span>}
                  </div>
                  {r.description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{r.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {r.severity && SEV[r.severity] && <Badge tone={SEV[r.severity].tone}>{SEV[r.severity].label}</Badge>}
                  {r.recordable && <Badge tone="red">OSHA 300</Badge>}
                  <button onClick={() => start(async () => { await deleteSafetyRecord(r.id); router.refresh(); })} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </Card>
          </li>
        ))}
        {records.length === 0 && (
          <li className="py-8 text-center text-sm text-slate-400">{isIncident ? "No incidents logged — keep it that way." : "No toolbox talks logged yet."}</li>
        )}
      </ul>
    </div>
  );
}
