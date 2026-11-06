"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { StateSelect } from "@/components/ui/state-select";
import { updateCustomer } from "../actions";
import type { Customer } from "@/lib/types";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

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
  const markup = (pct: number) => fillText(t("cu_markupPct"), { pct: String(pct) });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const c = customer;
  const [stateVal, setStateVal] = useState(c.state ?? "");

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
      <Button variant="outline" onClick={() => setOpen(true)}>
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
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="name">{t("cu_nameRequired")}</Label>
              <Input id="name" name="name" autoComplete="name" required defaultValue={c.name} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="company_name">{t("cu_company")}</Label>
              <Input id="company_name" name="company_name" autoComplete="organization" defaultValue={c.company_name ?? ""} />
            </div>
            <div>
              <Label htmlFor="type">{t("cu_type")}</Label>
              <Select id="type" name="type" defaultValue={c.type}>
                <option value="residential">{t("cu_btn_typeResidential")}</option>
                <option value="commercial">{t("cu_btn_typeCommercial")}</option>
                <option value="industrial">{t("cu_btn_typeIndustrial")}</option>
                <option value="contractor">{t("cu_btn_typeContractor")}</option>
                <option value="subcontractor">{t("cu_btn_typeSubcontractor")}</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="status">{t("cu_status")}</Label>
              <Select id="status" name="status" defaultValue={c.status}>
                <option value="lead">{t("cu_btn_statusInquiry")}</option>
                <option value="active">{t("cu_btn_statusActive")}</option>
                <option value="inactive">{t("cu_btn_statusInactive")}</option>
              </Select>
            </div>
            {pricingLevels.length > 0 && (
              <div className="col-span-2">
                <Label htmlFor="pricing_level_id">{t("cu_pricingLevel")}</Label>
                <Select id="pricing_level_id" name="pricing_level_id" defaultValue={(c as any).pricing_level_id ?? ""}>
                  <option value="">{t("cu_optDefault")}</option>
                  {pricingLevels.map((l) => (
                    <option key={l.id} value={l.id}>{l.name} ({markup(Number(l.markup_pct))})</option>
                  ))}
                </Select>
              </div>
            )}
            <div>
              <Label htmlFor="email">{t("cu_email")}</Label>
              <Input id="email" name="email" type="email" autoComplete="email" defaultValue={c.email ?? ""} />
            </div>
            <div>
              <Label htmlFor="phone">{t("cu_phone")}</Label>
              <PhoneInput id="phone" name="phone" defaultValue={c.phone ?? ""} />
            </div>
            <div className="col-span-2">
              <Label htmlFor="address">{t("cu_address")}</Label>
              <Input id="address" name="address" defaultValue={c.address ?? ""} />
            </div>
            <div>
              <Label htmlFor="city">{t("cu_city")}</Label>
              <Input id="city" name="city" defaultValue={c.city ?? ""} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="state">{t("cu_state")}</Label>
                <StateSelect id="state" name="state" value={stateVal} onChange={setStateVal} />
              </div>
              <div>
                <Label htmlFor="zip">{t("cu_zip")}</Label>
                <Input id="zip" name="zip" defaultValue={c.zip ?? ""} />
              </div>
            </div>
            <div className="col-span-2">
              <Label htmlFor="notes">{t("cu_notes")}</Label>
              <Textarea id="notes" name="notes" rows={2} defaultValue={c.notes ?? ""} />
            </div>
          </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
