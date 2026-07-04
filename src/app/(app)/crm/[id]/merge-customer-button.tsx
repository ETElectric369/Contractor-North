"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Select } from "@/components/ui/input";
import { mergeCustomers } from "../actions";

/** "Merge into…" — folds THIS (duplicate) customer into another. All of this
 *  customer's jobs, estimates, invoices, links, credits, and inquiries move to
 *  the target, then this record is deleted. The only way to clean up a duplicate
 *  once it's referenced (plain Delete refuses while history points at it). */
export function MergeCustomerButton({
  customer,
  others,
}: {
  customer: { id: string; name: string };
  others: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onMerge() {
    setError(null);
    if (!targetId) {
      setError("Pick a customer to merge into.");
      return;
    }
    const target = others.find((o) => o.id === targetId);
    if (
      !confirm(
        `Merge "${customer.name}" into "${target?.name ?? "the selected customer"}"? ` +
          `All of ${customer.name}'s jobs, estimates, invoices, links, credits, and inquiries ` +
          `move over, then ${customer.name} is permanently deleted. This can't be undone.`,
      )
    )
      return;
    start(async () => {
      const res = await mergeCustomers(customer.id, targetId);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      // The source is gone — land on the target customer.
      router.push(`/crm/${res.id ?? targetId}`);
      router.refresh();
    });
  }

  if (others.length === 0) return null;

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <GitMerge className="h-4 w-4" /> Merge Into…
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Merge ${customer.name} into…`}
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={onMerge}
            saving={pending}
            destructive
            saveLabel="Merge & Delete"
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <p className="text-sm text-slate-500">
            Use this to fold a duplicate into the real record. Everything attached to{" "}
            <span className="font-medium text-slate-700">{customer.name}</span> moves to the
            customer you pick, then {customer.name} is deleted.
          </p>
          <div>
            <Label htmlFor="merge_target">Merge into customer</Label>
            <Select
              id="merge_target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">— Select a customer —</option>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Modal>
    </>
  );
}
