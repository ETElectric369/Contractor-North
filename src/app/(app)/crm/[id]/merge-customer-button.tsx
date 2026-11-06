"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Label, Select } from "@/components/ui/input";
import { mergeCustomers } from "../actions";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

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
  const t = translator(useLang());
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  function onMerge() {
    setError(null);
    if (!targetId) {
      setError(t("cu_pickToMerge"));
      return;
    }
    const target = others.find((o) => o.id === targetId);
    if (
      !confirm(fillText(t("cu_mergeConfirm"), { name: customer.name, target: target?.name ?? t("cu_theSelectedCustomer") }))
    )
      return;
    start(async () => {
      const res = await mergeCustomers(customer.id, targetId);
      if (!res.ok) {
        setError(res.error ?? t("cu_somethingWrong"));
        return;
      }
      setOpen(false);
      // The source is gone — land on the target customer.
      router.push(`/crm/${res.id ?? targetId}`);
      router.refresh();
    });
  }

  if (others.length === 0) return null;
  // The sheet's heading, a name in the middle ("Merge {name} into…" — today's English).
  const mergeTitle = fillText(t("cu_mergeTitle"), { name: customer.name });
  const [beforeWho, afterWho = ""] = fillText(t("cu_mergeExplainer"), { name: customer.name }).split("{who}");

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <GitMerge className="h-4 w-4" /> {t("cu_btn_thisIsADuplicate")}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={mergeTitle}
        footer={
          <ModalActions
            onCancel={() => setOpen(false)}
            onSave={onMerge}
            saving={pending}
            destructive
            saveLabel={t("cu_btn_mergeDelete")}
          />
        }
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <p className="text-sm text-slate-500">
            {beforeWho}
            <span className="font-medium text-slate-700">{customer.name}</span>
            {afterWho}
          </p>
          <div>
            <Label htmlFor="merge_target">{t("cu_mergeInto")}</Label>
            <Select
              id="merge_target"
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="">{t("cu_optSelectCustomer")}</option>
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
