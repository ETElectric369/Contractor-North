"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Landmark, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { createClient } from "@/lib/supabase/client";
import { INSURANCE_FILTER, AUDIT_TYPES } from "@/lib/compliance-types";
import { importPolicyDoc, importFromCslb } from "./actions";

/** Where an item of this type actually shows up (mirrors the three page filters). */
function destinationFor(type: string): "Insurance" | "Audits" | "Compliance" {
  if (INSURANCE_FILTER.includes(type)) return "Insurance";
  if (AUDIT_TYPES.includes(type)) return "Audits";
  return "Compliance";
}

/** Same rails as insurance certificates: private "documents" bucket, org folder (RLS 0013). */
async function uploadDoc(orgId: string, file: File): Promise<string> {
  if (file.size > 15 * 1024 * 1024) throw new Error(`${file.name} is over 15 MB.`);
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${orgId}/insurance/${Date.now()}-${safe}`;
  const supabase = createClient();
  const { error } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

type Row = { state: "reading" | "filed" | "review" | "failed"; label: string };

const CSLB_NUM_RE = /^\d{4,8}$/;

/**
 * "Import documents" — drop any stack of policy/bond/license PDFs or photos and
 * every one gets FILED, no typing required: the AI fills in the details, and a
 * failed read still saves the document for review (fragment-first law).
 * Also carries the zero-paperwork sibling: "From CSLB" pulls the public board
 * record (license + bond + workers' comp) straight off cslb.ca.gov by license
 * number — re-running updates the same items, so it doubles as a re-check.
 * Shared by /insurance and /compliance; `page` names the surface it sits on so a
 * per-file line can say when an item routed to the other page.
 */
export function ImportDocsButton({ orgId, page }: { orgId: string; page: "Insurance" | "Compliance" }) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [cslbOpen, setCslbOpen] = useState(false);
  const [cslbNum, setCslbNum] = useState("");

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    setBusy(true);
    setRows(files.map((f) => ({ state: "reading" as const, label: `Reading ${f.name}…` })));
    let imported = 0;
    let review = 0;
    let failed = 0;
    // Sequential on purpose: one AI read at a time, and one bad file never aborts the batch.
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const set = (state: Row["state"], label: string) =>
        setRows((r) => r.map((row, idx) => (idx === i ? { state, label } : row)));
      try {
        const path = await uploadDoc(orgId, f);
        const res = await importPolicyDoc({ path, mime: f.type, fileName: f.name });
        if (!res.ok) throw new Error(res.error || "Import failed.");
        imported++;
        if (res.reviewNeeded) {
          review++;
          set("review", `Filed for review: ${res.name ?? f.name}`);
        } else {
          const dest = destinationFor(res.type ?? "Other");
          const where = dest === page ? "Filed" : `Filed to ${dest}`;
          set("filed", `${where}: ${res.name}${res.summary ? ` — ${res.summary}` : ""}`);
        }
      } catch (err: any) {
        failed++;
        set("failed", `${f.name}: ${err?.message ?? "Upload failed."}`);
      }
    }
    setBusy(false);
    router.refresh();
    const bits = [`${imported} imported`];
    if (review) bits.push(`${review} need${review === 1 ? "s" : ""} a look`);
    if (failed) bits.push(`${failed} failed`);
    toast(bits.join(" — "), failed ? "error" : review ? "info" : "success");
  }

  /** Open the CSLB modal, best-effort prefilling the number from an already-filed
   *  Contractor License item (fetched here, not passed down: /insurance filters its
   *  items to policy types, so the license row isn't in EITHER page's props — one
   *  client read works the same on both surfaces, RLS-scoped to the org). */
  function openCslb() {
    setCslbOpen(true);
    if (cslbNum) return;
    void (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("compliance_items")
          .select("policy_number")
          .eq("type", "Contractor License")
          .not("policy_number", "is", null)
          .limit(1);
        const num = String(data?.[0]?.policy_number ?? "").trim();
        // Only prefill something that IS a CSLB number — never a stray cert id.
        if (CSLB_NUM_RE.test(num)) setCslbNum((v) => v || num);
      } catch {
        /* prefill is a nicety — the field just starts blank */
      }
    })();
  }

  function runCslb() {
    const num = cslbNum.trim();
    if (!CSLB_NUM_RE.test(num)) return;
    setCslbOpen(false);
    setBusy(true);
    setRows([{ state: "reading", label: `Checking CSLB #${num}…` }]);
    void (async () => {
      const res = await importFromCslb(num);
      // Anything the board DID file narrates like a filed document line.
      const done: Row[] = (res.results ?? []).map((r) => {
        const dest = destinationFor(r.type);
        const where = dest === page ? "" : ` to ${dest}`;
        return {
          state: "filed" as const,
          label: `${r.action === "created" ? "Created" : "Updated"}${where}: ${r.type} — ${r.name}${r.detail ? ` — ${r.detail}` : ""}`,
        };
      });
      if (!res.ok) {
        setRows([...done, { state: "failed", label: res.error ?? "CSLB import failed." }]);
        toast(res.error ?? "CSLB import failed.", "error");
      } else {
        setRows(done);
        toast(`CSLB #${num} imported — ${done.length} item${done.length === 1 ? "" : "s"} up to date`, "success");
      }
      setBusy(false);
      if (done.length) router.refresh();
    })();
  }

  return (
    <div className="flex min-w-0 flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf,image/*"
        className="hidden"
        onChange={(e) => {
          void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={openCslb} disabled={busy}>
          <Landmark className="h-3.5 w-3.5" /> From CSLB
        </Button>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
          <Upload className="h-3.5 w-3.5" /> {busy ? "Importing…" : "Import documents"}
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="w-full max-w-md space-y-1 rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              {r.state === "reading" && <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />}
              {r.state === "filed" && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />}
              {r.state === "review" && <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />}
              {r.state === "failed" && <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />}
              <span
                className={
                  r.state === "failed"
                    ? "min-w-0 break-words text-red-600"
                    : r.state === "review"
                      ? "min-w-0 break-words text-amber-700"
                      : "min-w-0 break-words text-slate-600"
                }
              >
                {r.label}
              </span>
            </div>
          ))}
          {!busy && (
            <div className="flex justify-end pt-0.5">
              <button onClick={() => setRows([])} className="text-[11px] text-slate-400 hover:text-slate-600">
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}

      <Modal
        open={cslbOpen}
        onClose={() => setCslbOpen(false)}
        title="Import from CSLB"
        size="sm"
        footer={
          <ModalActions
            onCancel={() => setCslbOpen(false)}
            onSave={runCslb}
            saveLabel="Import"
            disabled={!CSLB_NUM_RE.test(cslbNum.trim())}
          />
        }
      >
        <Label htmlFor="cslb-num">CSLB license number</Label>
        <Input
          id="cslb-num"
          inputMode="numeric"
          autoComplete="off"
          value={cslbNum}
          onChange={(e) => setCslbNum(e.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="e.g. 1023456"
        />
        <p className="mt-2 text-xs text-slate-400">
          Pulls the public board record — license, contractor&apos;s bond &amp; workers&apos; comp — with
          numbers and dates exactly as CSLB shows them. Run it again anytime to re-check; it updates
          the same items instead of duplicating.
        </p>
      </Modal>
    </div>
  );
}
