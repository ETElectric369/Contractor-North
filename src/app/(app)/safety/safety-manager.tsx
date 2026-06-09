"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, AlertTriangle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  const router = useRouter();
  const [tab, setTab] = useState<"incident" | "toolbox">("incident");
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

  const incidents = records.filter((r) => r.kind === "incident");
  const toolbox = records.filter((r) => r.kind === "toolbox");

  function add() {
    setError(null);
    if (!title.trim()) return setError("Title is required.");
    start(async () => {
      const res = await addSafetyRecord({
        kind: tab,
        record_date: date,
        title,
        profile_id: tab === "incident" ? profileId || null : null,
        job_id: tab === "incident" ? jobId || null : null,
        severity: tab === "incident" ? severity : null,
        recordable: tab === "incident" ? recordable : false,
        attendees: tab === "toolbox" ? attendees : null,
        description,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setTitle(""); setProfileId(""); setJobId(""); setRecordable(false); setAttendees(""); setDescription("");
      router.refresh();
    });
  }

  const tabBtn = (id: typeof tab, label: string, n: number) => (
    <button onClick={() => setTab(id)} className={`flex-1 rounded-md px-3 py-1.5 font-medium ${tab === id ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"}`}>
      {label} ({n})
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
        {tabBtn("incident", "Incidents", incidents.length)}
        {tabBtn("toolbox", "Toolbox talks", toolbox.length)}
      </div>

      <Card className="space-y-3 p-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div><Label htmlFor="s-date">Date</Label><Input id="s-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="col-span-2 sm:col-span-3"><Label htmlFor="s-title">{tab === "incident" ? "What happened *" : "Topic *"}</Label><Input id="s-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={tab === "incident" ? "e.g. Cut hand on conduit" : "e.g. Ladder safety"} /></div>
          {tab === "incident" ? (
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
        <div><Label htmlFor="s-desc">{tab === "incident" ? "Details / corrective action" : "Notes"}</Label><Textarea id="s-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <div className="flex justify-end"><Button size="sm" onClick={add} disabled={pending || !title.trim()}><Plus className="h-3.5 w-3.5" /> Add {tab === "incident" ? "incident" : "talk"}</Button></div>
      </Card>

      <ul className="space-y-2">
        {(tab === "incident" ? incidents : toolbox).map((r) => (
          <li key={r.id}>
            <Card className="p-4">
              <div className="flex items-start gap-3">
                {tab === "incident" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> : <Users className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
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
        {(tab === "incident" ? incidents : toolbox).length === 0 && (
          <li className="py-8 text-center text-sm text-slate-400">{tab === "incident" ? "No incidents logged — keep it that way." : "No toolbox talks logged yet."}</li>
        )}
      </ul>
    </div>
  );
}
