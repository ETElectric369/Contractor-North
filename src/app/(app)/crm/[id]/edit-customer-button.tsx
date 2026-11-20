"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { CustomerFields, customerFormValue, type CustomerFormValue } from "@/components/customer-fields";
import { updateCustomer } from "../actions";
import type { Customer } from "@/lib/types";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

export function EditCustomerButton({
  customer,
  pricingLevels = [],
  label,
}: {
  customer: Customer;
  pricingLevels?: { id: string; name: string; markup_pct: number }[];
  /** The button's words where it is a door for one field (the portal card's "Add Their Email"); Edit
   *  in the reader's language when none is named. */
  label?: string;
}) {
  // Shared (crm/[id], jobs/[id], the estimate's customer card): it reads the language itself.
  const t = translator(useLang());
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const c = customer;
  // THE ONE CUSTOMER FORM (cn-v1171, components/customer-fields), the same New Customer draws.
  const [form, setForm] = useState<CustomerFormValue>(() => customerFormValue(c));
  const [formKey, setFormKey] = useState(0);

  /** Opened, it starts from the customer as they are now: the page re-reads them after every save,
   *  and the phone and the street inside the person block show a new value only on a remount. The
   *  fields are re-seeded BEFORE the sheet opens; the sheet itself is never remounted. */
  function openSheet() {
    setError(null);
    const fresh = customerFormValue(c);
    // Remounted only when something differs (a save elsewhere, or words left by a Cancel).
    if (JSON.stringify(fresh) !== JSON.stringify(form)) {
      setForm(fresh);
      setFormKey((k) => k + 1);
    }
    setOpen(true);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await updateCustomer(c.id, formData);
      if (!res.ok) {
        setError(res.error ?? t("cu_somethingWrong"));
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button variant="outline" onClick={openSheet}>
        <Pencil className="h-4 w-4" /> {label ?? t("cu_btn_edit")}
      </Button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title={t("cu_editCustomerTitle")}
          footer={
            <ModalActions onCancel={() => setOpen(false)} submit saving={pending} saveLabel={t("cu_btn_saveChanges")} />
          }
        >
          <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <CustomerFields key={formKey} mode="edit" value={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} pricingLevels={pricingLevels} />
          </div>
        </Modal>
      </form>
    </>
  );
}
