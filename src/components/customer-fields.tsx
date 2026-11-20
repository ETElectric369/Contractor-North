"use client";

import { Label, Select, Textarea } from "@/components/ui/input";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { PersonFields, personValue, type PersonValue } from "@/components/person-fields";
import type { Customer } from "@/lib/types";

/** The customer form as ONE serializable object, owned by the door around it (New or Edit). */
export interface CustomerFormValue extends PersonValue {
  notes: string;
  type: string;
  status: string;
  pricing_level_id: string;
}

type CustomerRow = Pick<Customer, "name" | "company_name" | "email" | "phone" | "address" | "city" | "state" | "zip" | "notes" | "type" | "status"> & {
  pricing_level_id?: string | null;
};

/** The form's value from a stored customer (Edit), or a new one's defaults: residential, active. */
export const customerFormValue = (c?: Partial<CustomerRow> | null): CustomerFormValue => ({
  ...personValue(c),
  notes: c?.notes ?? "",
  type: c?.type ?? "residential",
  status: c?.status ?? "active",
  pricing_level_id: c?.pricing_level_id ?? "",
});

const TYPES = [
  ["residential", "cu_btn_typeResidential"],
  ["commercial", "cu_btn_typeCommercial"],
  ["industrial", "cu_btn_typeIndustrial"],
  ["contractor", "cu_btn_typeContractor"],
  ["subcontractor", "cu_btn_typeSubcontractor"],
] as const;

/**
 * ONE CUSTOMER FORM, TWO DOORS (cn-v1171): New Customer and Edit Customer draw this, so a customer is
 * typed in one way. Erik, 2026-11-19: "the lead manual entry form might be one of a few, can we check
 * on the one thing many doors for that one". The person is the lead form's own block (Name, Business
 * behind its link, Address with the town behind its link, Phone, Email); then Notes; then what only a
 * customer has: Type, Status and, on Edit when the company has any, the Pricing Level. Every field
 * posts under the name crm/actions createCustomer and updateCustomer read.
 *
 * The status word for a stored `lead` is the one the customer's page draws on its badge (cn-v1171:
 * the select said Inquiry where the badge said Lead).
 *
 * The parent remounts this (key) to show a filled-in card or a reset: the phone and the street are
 * uncontrolled inside the person block.
 */
export function CustomerFields({
  value,
  onChange,
  mode,
  pricingLevels = [],
}: {
  value: CustomerFormValue;
  onChange: (patch: Partial<CustomerFormValue>) => void;
  mode: "new" | "edit";
  pricingLevels?: { id: string; name: string; markup_pct: number }[];
}) {
  const t = translator(useLang());
  const markup = (pct: number) => fillText(t("cu_markupPct"), { pct: String(pct) });
  // New offers Active and Inactive, as it always did; Edit keeps the stored Lead reachable.
  const statuses = mode === "edit"
    ? ([["lead", "cu_btn_statusLead"], ["active", "cu_btn_statusActive"], ["inactive", "cu_btn_statusInactive"]] as const)
    : ([["active", "cu_btn_statusActive"], ["inactive", "cu_btn_statusInactive"]] as const);

  return (
    <div className="space-y-4">
      <PersonFields value={value} onChange={onChange} namePlaceholder={t("cu_namePlaceholder")} />
      <div>
        <Label htmlFor="notes">{t("cu_notes")}</Label>
        <Textarea id="notes" name="notes" rows={2} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="type">{t("cu_type")}</Label>
          <Select id="type" name="type" value={value.type} onChange={(e) => onChange({ type: e.target.value })}>
            {TYPES.map(([v, k]) => (
              <option key={v} value={v}>{t(k)}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="status">{t("cu_status")}</Label>
          <Select id="status" name="status" value={value.status} onChange={(e) => onChange({ status: e.target.value })}>
            {statuses.map(([v, k]) => (
              <option key={v} value={v}>{t(k)}</option>
            ))}
          </Select>
        </div>
      </div>
      {mode === "edit" && pricingLevels.length > 0 && (
        <div>
          <Label htmlFor="pricing_level_id">{t("cu_pricingLevel")}</Label>
          <Select id="pricing_level_id" name="pricing_level_id" value={value.pricing_level_id} onChange={(e) => onChange({ pricing_level_id: e.target.value })}>
            <option value="">{t("cu_optDefault")}</option>
            {pricingLevels.map((l) => (
              <option key={l.id} value={l.id}>{l.name} ({markup(Number(l.markup_pct))})</option>
            ))}
          </Select>
        </div>
      )}
      {/* A door that draws no Pricing Level (the job page, the estimate's card) posts none, and
          updateCustomer then leaves the column as it is (cn-v1171, skeptic #74). */}
    </div>
  );
}
