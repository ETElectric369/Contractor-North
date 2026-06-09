"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Trash2, FileText, Loader2, Camera } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CameraCapture } from "@/components/camera-capture";
import { formatDate, initials } from "@/lib/utils";
import { addEmployeeDoc, deleteEmployeeDoc } from "./actions";

interface Employee { id: string; full_name: string | null; }
interface Doc {
  id: string;
  profile_id: string;
  type: string;
  name: string;
  file_url: string;
  expires_date: string | null;
  signedUrl: string | null;
}

const TYPES = ["Driver License", "I-9", "W-2", "W-4", "Certification", "Insurance", "Background Check", "Other"];

function expiry(date: string | null) {
  if (!date) return null;
  const d = Math.ceil((new Date(date + "T00:00:00").getTime() - Date.now()) / 86_400_000);
  if (d < 0) return { tone: "red" as const, label: `Expired` };
  if (d <= 30) return { tone: "red" as const, label: `Expires ${d}d` };
  if (d <= 60) return { tone: "amber" as const, label: `Expires ${d}d` };
  return { tone: "green" as const, label: `Valid` };
}

export function EmployeeDocsManager({
  orgId,
  employees,
  docs,
}: {
  orgId: string;
  employees: Employee[];
  docs: Doc[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [emp, setEmp] = useState(employees[0]?.id ?? "");
  const [type, setType] = useState("Driver License");
  const [expires, setExpires] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCamera, setShowCamera] = useState(false);

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    if (!emp) { setError("Pick an employee first."); return; }
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      for (const file of files) {
        if (file.size > 15 * 1024 * 1024) { setError(`${file.name} is over 15 MB.`); continue; }
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/employees/${emp}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        const res = await addEmployeeDoc({ profile_id: emp, type, name: file.name, file_url: path, expires_date: expires || null });
        if (!res.ok) throw new Error(res.error);
      }
      setExpires("");
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  const byEmp = employees.map((e) => ({ emp: e, items: docs.filter((d) => d.profile_id === e.id) }));

  return (
    <div className="space-y-5">
      <Card className="p-4">
        {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="ed-emp">Employee</Label>
            <Select id="ed-emp" value={emp} onChange={(e) => setEmp(e.target.value)}>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.full_name ?? "Unnamed"}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="ed-type">Type</Label>
            <Select id="ed-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </div>
          <div>
            <Label htmlFor="ed-exp">Expires (optional)</Label>
            <Input id="ed-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
          <div className="flex items-end gap-2">
            <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { uploadFiles(Array.from(e.target.files ?? [])); if (fileRef.current) fileRef.current.value = ""; }} />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Upload
            </Button>
            <Button variant="outline" type="button" onClick={() => setShowCamera(true)} disabled={busy}><Camera className="h-4 w-4" /></Button>
          </div>
        </div>
      </Card>

      {showCamera && (
        <CameraCapture onCapture={(file) => { setShowCamera(false); uploadFiles([file]); }} onClose={() => setShowCamera(false)} />
      )}

      <div className="space-y-4">
        {byEmp.map(({ emp: e, items }) => (
          <Card key={e.id} className="overflow-hidden">
            <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{initials(e.full_name)}</div>
              <span className="text-sm font-semibold text-slate-900">{e.full_name ?? "Unnamed"}</span>
              <Badge tone="slate">{items.length}</Badge>
            </div>
            <ul className="divide-y divide-slate-100">
              {items.map((d) => {
                const ex = expiry(d.expires_date);
                return (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      {d.signedUrl ? (
                        <a href={d.signedUrl} target="_blank" rel="noopener noreferrer" className="truncate font-medium text-slate-900 hover:text-brand">{d.name}</a>
                      ) : (
                        <span className="truncate font-medium text-slate-900">{d.name}</span>
                      )}
                      <div className="text-xs text-slate-400">{d.type}{d.expires_date ? ` · ${formatDate(d.expires_date)}` : ""}</div>
                    </div>
                    {ex && <Badge tone={ex.tone}>{ex.label}</Badge>}
                    <button onClick={() => start(async () => { await deleteEmployeeDoc(d.id, d.file_url); router.refresh(); })} className="text-slate-300 hover:text-red-600" title="Delete"><Trash2 className="h-4 w-4" /></button>
                  </li>
                );
              })}
              {items.length === 0 && <li className="px-5 py-4 text-center text-xs text-slate-400">No documents.</li>}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
