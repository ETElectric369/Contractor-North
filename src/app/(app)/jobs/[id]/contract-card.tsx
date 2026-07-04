"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileSignature } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { generateContractFromJob, updateContract, sendContract, voidContract } from "../../contracts/actions";

type ContractRow = {
  id: string;
  status: string;
  contract_number: string | null;
  title: string;
  body: string;
  public_token: string;
  signed_name: string | null;
  signed_at: string | null;
};

/** Contract hub on the job (Phase 2 spine): generate a signable agreement from the
 *  job, review/edit while it's a draft, send it for the customer to e-sign, and see
 *  the signed result. */
export function ContractCard({ jobId, contract }: { jobId: string; contract: ContractRow | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      router.refresh();
    });
  }

  const c = contract;
  const link = c ? `/c/${c.public_token}` : "#";

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <FileSignature className="h-4 w-4" /> Contract{c?.contract_number ? ` · ${c.contract_number}` : ""}
          </div>
          {c && <Badge tone={statusTone(c.status)}>{c.status}</Badge>}
        </div>
        {error && <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        {!c ? (
          <div>
            <p className="text-sm text-slate-600">
              Generate a signable contract from this job — parties, scope, dates, payment schedule, and terms auto‑fill.
            </p>
            <Button className="mt-3" onClick={() => run(() => generateContractFromJob(jobId))} disabled={pending}>
              Generate Contract
            </Button>
          </div>
        ) : c.status === "signed" ? (
          <div className="rounded-lg bg-green-50 px-3 py-3 text-sm text-green-800">
            <div className="font-medium">Signed</div>
            <div className="mt-0.5">
              By {c.signed_name}
              {c.signed_at ? ` on ${formatDate(c.signed_at)}` : ""}.{" "}
              <a href={link} target="_blank" rel="noopener" className="font-medium text-emerald-700 underline">
                View Signed Contract
              </a>
            </div>
          </div>
        ) : c.status === "sent" ? (
          <div>
            <p className="text-sm text-slate-600">Sent to the customer — awaiting signature.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a href={link} target="_blank" rel="noopener" className="text-sm font-medium text-brand underline">
                Open Signing Page
              </a>
              <Button variant="outline" size="sm" onClick={() => run(() => sendContract(c.id))} disabled={pending}>
                Resend
              </Button>
              <Button variant="ghost" size="sm" onClick={() => run(() => voidContract(c.id))} disabled={pending}>
                Void
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <p className="text-sm text-slate-600">Draft ready. Review the terms, then send it to the customer to sign.</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setEditing(true)}>Review &amp; Edit</Button>
              <Button variant="outline" size="sm" onClick={() => run(() => sendContract(c.id))} disabled={pending}>
                Send to Customer
              </Button>
              <Button variant="ghost" size="sm" onClick={() => run(() => generateContractFromJob(jobId))} disabled={pending}>
                Regenerate
              </Button>
              <Button variant="ghost" size="sm" onClick={() => run(() => voidContract(c.id))} disabled={pending}>
                Void
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {editing && c && (
        <ContractEditor
          contract={c}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      )}
    </Card>
  );
}

function ContractEditor({ contract, onClose, onSaved }: { contract: ContractRow; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(contract.title);
  const [body, setBody] = useState(contract.body);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save() {
    setError(null);
    start(async () => {
      const res = await updateContract(contract.id, { title, body });
      if (!res.ok) {
        setError(res.error ?? "Could not save.");
        return;
      }
      onSaved();
    });
  }

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title="Review contract"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save Draft" />}
    >
      <div className="space-y-3">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Title</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1" />
        </div>
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-slate-400">Agreement</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs leading-relaxed"
          />
          <p className="mt-1 text-xs text-slate-400">Edit freely while it&apos;s a draft. Once sent, the wording is locked.</p>
        </div>
      </div>
    </Modal>
  );
}
