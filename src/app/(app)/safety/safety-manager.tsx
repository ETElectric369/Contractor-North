"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Trash2, AlertTriangle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Tabs } from "@/components/tabs";
import { formatDate } from "@/lib/utils";
import { addSafetyRecord, updateSafetyRecord, deleteSafetyRecord } from "./actions";

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
          label: "Toolbox Talks",
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
        <div className="flex justify-end"><Button size="sm" onClick={add} disabled={pending || !title.trim()}><Plus className="h-3.5 w-3.5" /> Add {isIncident ? "Incident" : "Talk"}</Button></div>
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
                    {r.jobs?.name && <Link href={`/jobs/${r.job_id}`} className="hover:text-brand">· {r.jobs.name}</Link>}
                    {r.attendees && <span>· {r.attendees}</span>}
                  </div>
                  {r.description && <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{r.description}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {r.severity && SEV[r.severity] && <Badge tone={SEV[r.severity].tone}>{SEV[r.severity].label}</Badge>}
                  {r.recordable && <Badge tone="red">OSHA 300</Badge>}
                  <EditSafetyButton kind={kind} employees={employees} jobs={jobs} record={r} />
                  <button onClick={() => { if (!confirm("Delete this safety record? This removes a legal OSHA record.")) return; start(async () => { const res = await deleteSafetyRecord(r.id); if (!res.ok) return alert(res.error ?? "Could not delete."); router.refresh(); }); }} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
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

function EditSafetyButton({
  kind,
  employees,
  jobs,
  record,
}: {
  kind: "incident" | "toolbox";
  employees: Person[];
  jobs: JobOpt[];
  record: Rec;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(record.record_date);
  const [title, setTitle] = useState(record.title);
  const [profileId, setProfileId] = useState(record.profile_id ?? "");
  const [jobId, setJobId] = useState(record.job_id ?? "");
  const [severity, setSeverity] = useState(record.severity ?? "first_aid");
  const [recordable, setRecordable] = useState(record.recordable);
  const [attendees, setAttendees] = useState(record.attendees ?? "");
  const [description, setDescription] = useState(record.description ?? "");

  const isIncident = kind === "incident";

  function reset() {
    setDate(record.record_date);
    setTitle(record.title);
    setProfileId(record.profile_id ?? "");
    setJobId(record.job_id ?? "");
    setSeverity(record.severity ?? "first_aid");
    setRecordable(record.recordable);
    setAttendees(record.attendees ?? "");
    setDescription(record.description ?? "");
    setError(null);
  }

  function save() {
    setError(null);
    if (!title.trim()) return setError("Title is required.");
    start(async () => {
      const res = await updateSafetyRecord(record.id, {
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
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button onClick={() => { reset(); setOpen(true); }} className="text-slate-300 hover:text-brand" title="Edit"><Pencil className="h-4 w-4" /></button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={isIncident ? "Edit incident" : "Edit toolbox talk"}
        footer={<ModalActions onCancel={() => setOpen(false)} onSave={save} saving={pending} disabled={!title.trim()} />}
      >
        <div className="space-y-3">
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div><Label htmlFor="e-date">Date</Label><Input id="e-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="col-span-2 sm:col-span-3"><Label htmlFor="e-title">{isIncident ? "What happened *" : "Topic *"}</Label><Input id="e-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isIncident ? "e.g. Cut hand on conduit" : "e.g. Ladder safety"} /></div>
            {isIncident ? (
              <>
                <div><Label htmlFor="e-emp">Employee</Label><Select id="e-emp" value={profileId} onChange={(e) => setProfileId(e.target.value)}><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.full_name ?? "Unnamed"}</option>)}</Select></div>
                <div><Label htmlFor="e-job">Job</Label><Select id="e-job" value={jobId} onChange={(e) => setJobId(e.target.value)}><option value="">—</option>{jobs.map((j) => <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>)}</Select></div>
                <div><Label htmlFor="e-sev">Severity</Label><Select id="e-sev" value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="first_aid">First aid only</option><option value="recordable">OSHA recordable</option><option value="lost_time">Lost time</option></Select></div>
                <label className="flex items-end gap-2 pb-2 text-sm text-slate-600"><input type="checkbox" checked={recordable} onChange={(e) => setRecordable(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" /> OSHA 300 recordable</label>
              </>
            ) : (
              <div className="col-span-2 sm:col-span-4"><Label htmlFor="e-att">Attendees</Label><Input id="e-att" value={attendees} onChange={(e) => setAttendees(e.target.value)} placeholder="Names of crew present" /></div>
            )}
          </div>
          <div><Label htmlFor="e-desc">{isIncident ? "Details / corrective action" : "Notes"}</Label><Textarea id="e-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </div>
      </Modal>
    </>
  );
}
