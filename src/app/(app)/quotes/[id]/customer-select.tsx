"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { User, Pencil, X, Sprout, MapPin } from "lucide-react";
import { EditCustomerButton } from "../../crm/[id]/edit-customer-button";
import { InquiryModal } from "../../leads/inquiry-modal";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Customer, Inquiry } from "@/lib/types";
import { formatFullAddress } from "@/lib/utils";
import { setQuoteCustomer } from "../actions";
import { commitCustomerPick } from "./customer-pick";
import { createCustomer } from "../../crm/actions";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { useSaveInFlight } from "@/lib/saves-in-flight";

interface CustomerLite {
  id: string;
  name: string;
  company_name: string | null;
}

/** The lead this estimate came from. A lead is a PERSON WHO HASN'T BOUGHT ANYTHING YET — not a
 *  half-made customer — so it gets its own prop and its own words. */
interface LeadLite {
  id: string;
  name: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  /** The lead's WHOLE row (quotes/[id]/page reads `inquiry:inquiry_id(*)`): what the card's address
   *  line and its Edit Lead door read. Absent, the card shows neither. */
  row?: Inquiry | null;
}

/**
 * The quote's customer — readable (links to the contact) but also editable:
 * a saved quote's customer can be changed/cleared after creation. Mirrors the
 * builder's customer <Select>; persists via setQuoteCustomer.
 */
export function CustomerSelect({
  quoteId,
  customer,
  lead = null,
  customers,
}: {
  quoteId: string;
  /** Full customer row (from customers(*)) so EditCustomerButton has all fields. */
  customer: Customer | null;
  /** The lead on quotes.inquiry_id, when there is one. An estimate can sit on a lead alone —
   *  the printed document already coalesces the bill-to block onto it — and this card must say
   *  so instead of reporting a customer-shaped hole. */
  lead?: LeadLite | null;
  customers: CustomerLite[];
}) {
  const router = useRouter();
  const t = translator(useLang());
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(customer?.id ?? "");
  const [pending, start] = useTransition();
  // THE PICK IS A SAVE, SO IT IS COUNTED (cn-v1157): the header's Preview waits for the count, and the
  // paper is made out to whoever is attached. Counting only; the pick itself is unchanged.
  useSaveInFlight(pending);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // The "Saved" word clears itself after two seconds; the timer dies with the card (and with a second pick).
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (savedTimer.current) clearTimeout(savedTimer.current); }, []);
  // MAKING ONE FROM HERE. Erik, on the Sarah Dale estimate: "it says sarah dale punch list and no
  // address and i cant even edit it anywhere." The address on a quote comes from the attached
  // customer — quotes.address/city/state/zip are never rendered — and this picker could only
  // choose someone who already existed. First estimate for a new customer was therefore a dead
  // end: no record to pick, no way to make one without leaving the quote and losing your place.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddr, setNewAddr] = useState("");

  function createAndAttach() {
    if (!newName.trim()) return setError(t("qt_nameRequired"));
    setError(null);
    start(async () => {
      const fd = new FormData();
      fd.set("name", newName.trim());
      if (newAddr.trim()) fd.set("address", newAddr.trim());
      const made = await createCustomer(fd);
      if (!made.ok || !made.id) return setError(made.error ?? t("qt_couldntCreateCustomer"));
      // ATTACH IN THE SAME BREATH. A created-but-unattached customer is the same dead end one
      // step further along, and it's the step somebody walks away from.
      const res = await commitCustomerPick(quoteId, made.id, { setQuoteCustomer, fallbackError: t("qt_createdNotAttached") });
      if (!res.ok) return setError(res.error ?? t("qt_createdNotAttached"));
      setCreating(false);
      setEditing(false);
      setNewName("");
      setNewAddr("");
      router.refresh();
    });
  }

  // THE PICK IS THE SAVE: a changed select writes at once. A refusal puts the previous value back
  // and keeps the box open, saying the server's sentence.
  function pick(next: string) {
    const previous = value;
    setValue(next);
    setError(null);
    setSaved(false);
    start(async () => {
      const res = await commitCustomerPick(quoteId, next, { setQuoteCustomer, fallbackError: t("qt_couldntChangeCustomer") });
      if (!res.ok) {
        setValue(previous);
        return setError(res.error ?? t("qt_couldntChangeCustomer"));
      }
      setSaved(true);
      setEditing(false);
      router.refresh();
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    });
  }

  if (creating) {
    return (
      <div className="space-y-2">
        <div>
          <Label htmlFor="qc-name">{t("qt_name")}</Label>
          <Input id="qc-name" autoComplete="name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("qt_customerName")} />
        </div>
        <div>
          <Label htmlFor="qc-addr">{t("qt_address")}</Label>
          {/* The one field that made him stuck — it is what prints on the estimate. */}
          <Input id="qc-addr" autoComplete="street-address" value={newAddr} onChange={(e) => setNewAddr(e.target.value)} placeholder={t("qt_jobAddress")} />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={createAndAttach} disabled={pending}>{t("qt_btn_createAndAttach")}</Button>
          <Button size="sm" variant="outline" onClick={() => { setCreating(false); setError(null); }} disabled={pending}>{t("qt_btn_cancel")}</Button>
        </div>
        <p className="text-xs text-slate-400">{t("qt_restFromContact")}</p>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  if (editing) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Select
            value={value}
            onChange={(e) => pick(e.target.value)}
            disabled={pending}
            aria-label={t("qt_colCustomer")}
          >
            {/* Say what "none" MEANS when a lead is holding the document — clearing the customer
                doesn't blank the estimate, it leaves it made out to the lead. */}
            <option value="">{lead?.name?.trim() ? fillText(t("qt_noCustomerLeaveWithLead"), { name: lead.name.trim() }) : t("qt_noCustomer")}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.company_name ? ` (${c.company_name})` : ""}
              </option>
            ))}
          </Select>
          <button
            onClick={() => {
              setValue(customer?.id ?? "");
              setEditing(false);
              setError(null);
            }}
            disabled={pending}
            className="shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
            aria-label={t("qt_btn_cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <button
          onClick={() => { setCreating(true); setError(null); }}
          className="text-xs font-medium text-brand underline-offset-2 hover:underline"
        >
          {t("qt_btn_newCustomer")}
        </button>
        {pending && <p className="text-xs text-slate-400">{t("qt_btn_saving")}</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  // THE TWO ARE NOT THE SAME PERSON-SHAPED THING. A customer is somebody who has bought; a lead
  // is somebody who asked. An estimate is normally written for the second kind, and the win is
  // what mints the first — once. So this card names which one it is holding rather than measuring
  // a lead against a customer-shaped hole and reporting it empty.
  const leadName = lead?.name?.trim() || null;
  // THE LEAD'S ADDRESS IS THIS ESTIMATE'S JOB SITE until a job exists (lib/doc-place rowPlace, the
  // print page's pickSite), and it was shown nowhere on this page: Erik, 2026-11-10, read a half-typed
  // address on the PDF and "had to find the lead on the leads page to update the address there since
  // it wasnt accessible from anywhere else". So the card says the address, and Edit Lead opens the
  // lead's own form right here (one editor, a second door to it; Delete Lead stays on the Leads page).
  const leadRow = lead?.row ?? null;
  const leadSite = leadRow ? formatFullAddress(leadRow.address, leadRow.city, leadRow.state, leadRow.zip, leadRow.unit) : "";
  return (
    <div className="flex items-start justify-between gap-3">
      {customer ? (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("qt_colCustomer")}</p>
          <Link href={`/crm/${customer.id}`} className="flex items-center gap-3 hover:text-brand">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100">
              <User className="h-4 w-4 text-slate-500" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">{customer.name}</div>
              <div className="text-xs text-slate-400">
                {customer.email ?? customer.phone ?? customer.company_name ?? ""}
              </div>
            </div>
          </Link>
          {leadName && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2">
              <p className="text-xs text-slate-400">{fillText(t("qt_startedFromLead"), { name: leadName })}</p>
              {leadRow && <InquiryModal inquiry={leadRow} mode="edit" trigger="quiet" noDelete />}
            </div>
          )}
        </div>
      ) : leadName ? (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("qt_leadNotCustomerYet")}</p>
          <Link href={`/leads?focus=${lead?.id ?? ""}`} className="flex items-center gap-3 hover:text-brand">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-50">
              <Sprout className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <div className="text-sm font-medium text-slate-900">{leadName}</div>
              <div className="text-xs text-slate-400">
                {lead?.email ?? lead?.phone ?? lead?.company_name ?? ""}
              </div>
            </div>
          </Link>
          {leadRow && (
            <p className="mt-1.5 flex items-start gap-1 text-xs text-slate-600">
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              {leadSite ? <span>{leadSite}</span> : <span className="text-amber-700">{t("qt_leadNoAddress")}</span>}
            </p>
          )}
          <p className="mt-1.5 text-xs text-slate-500">
            {t("qt_madeOutToLead")}
          </p>
        </div>
      ) : (
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-400">{t("qt_preparedFor")}</p>
          <p className="text-sm text-slate-400">{t("qt_nobodyAttachedYet")}</p>
        </div>
      )}
      {/* With the lead's own door beside Attach Customer the two stack on a phone, so the card's words
          keep their width; from the small breakpoint up they sit in a row as before. */}
      <div className={!customer && leadRow ? "flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2" : "flex shrink-0 items-center gap-2"}>
        {saved && <span role="status" className="text-xs font-medium text-emerald-600">{t("qt_btn_saved")}</span>}
        <button
          onClick={() => setEditing(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          title={customer ? t("qt_changeCustomerTitle") : t("qt_attachCustomerTitle")}
        >
          <Pencil className="h-4 w-4 shrink-0" /> {customer ? t("qt_btn_change") : t("qt_btn_attachCustomer")}
        </button>
        {customer && <EditCustomerButton customer={customer} />}
        {!customer && leadRow && <InquiryModal inquiry={leadRow} mode="edit" trigger="quiet" noDelete />}
      </div>
    </div>
  );
}
