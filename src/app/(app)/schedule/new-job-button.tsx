"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useDraft } from "@/lib/use-draft";
import { useToast } from "@/components/toast";
import { formatCityStateZip, unitLine } from "@/lib/utils";
import {
  addressPrefillOnCustomerPick,
  defaultJobName,
  statusFromDate,
  streetHasUnits,
  type NewJobCustomerOption,
} from "@/lib/schedule-options";
import { createJob } from "./actions";
import { createParamClaim } from "@/lib/param-claim";

/** "08:00" → "8:00 AM", for the Start Time line (blank = from the company's start, two hours). */
function clockWords(hm: string): string {
  const m = /^(\d{2}):(\d{2})/.exec(hm);
  if (!m) return hm;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
}

/** The phone's own today, only when the page didn't hand over the company's. */
function deviceToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const BILLING_WORDS: Record<string, string> = { tm: "Time & Material", fixed: "Fixed Price" };

/**
 * THE CUSTOMER PICKER, one for New Job and Edit Job (W1-22): the book as a list, or "+ New Customer",
 * which swaps it for a Name and a Phone (Optional). Whatever is typed goes through the server's one
 * match-then-insert door (lib/crm/new-customer), so a name or number already in the book links to
 * that customer instead of making a twin. Controlled: the form owns the values.
 */
export function CustomerPicker({
  idPrefix,
  customers,
  customerId,
  onCustomerId,
  isNew,
  onIsNew,
  newName,
  onNewName,
  newPhone,
  onNewPhone,
}: {
  idPrefix: string;
  customers: { id: string; name: string }[];
  customerId: string;
  onCustomerId: (id: string) => void;
  isNew: boolean;
  onIsNew: (v: boolean) => void;
  newName: string;
  onNewName: (v: string) => void;
  newPhone: string;
  onNewPhone: (v: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label htmlFor={isNew ? `${idPrefix}-new-name` : `${idPrefix}-customer`}>Customer</Label>
        <button
          type="button"
          onClick={() => onIsNew(!isNew)}
          className="inline-flex min-h-11 items-center px-1 text-xs font-medium text-brand hover:underline"
        >
          {isNew ? "Pick Existing" : "+ New Customer"}
        </button>
      </div>
      {isNew ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {/* The mode travels with the form, so a phone typed with no name is refused in words on the
              server ("Type the new customer's name, or tap Pick Existing."), never dropped. */}
          <input type="hidden" name="new_customer" value="1" />
          <Input
            id={`${idPrefix}-new-name`}
            name="new_customer_name"
            placeholder="Name"
            aria-label="New Customer's Name"
            required
            autoFocus
            value={newName}
            onChange={(e) => onNewName(e.target.value)}
          />
          <Input
            id={`${idPrefix}-new-phone`}
            name="new_customer_phone"
            type="tel"
            autoComplete="tel"
            placeholder="Phone (Optional)"
            aria-label="Phone (Optional)"
            value={newPhone}
            onChange={(e) => onNewPhone(e.target.value)}
          />
        </div>
      ) : (
        <Select id={`${idPrefix}-customer`} name="customer_id" value={customerId} onChange={(e) => onCustomerId(e.target.value)}>
          <option value="">— None —</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
    </div>
  );
}

// The whole form as ONE serializable object so useDraft can mirror it.
interface JobForm {
  customer_id: string;
  new_customer: boolean;
  new_customer_name: string;
  new_customer_phone: string;
  billing_type: string;
  address: string;
  /** The dwelling — typed, never resolved: a picker returns a street, not an apartment. */
  unit: string;
  /** The resolved parts from the picker. Absent for typed input — see 0177: a guessed city is
   *  worse than a blank one, so these stay empty unless a suggestion was actually chosen. */
  city: string;
  state: string;
  zip: string;
  /** YYYY-MM-DD, or "" for Not Scheduled Yet. */
  scheduled_date: string;
  /** Optional "HH:MM"; blank = all day from the company's work-day start. */
  scheduled_time: string;
  description: string;
}
const FORM_KEYS: (keyof JobForm)[] = [
  "customer_id", "new_customer", "new_customer_name", "new_customer_phone", "billing_type", "address", "unit",
  "city", "state", "zip", "scheduled_date", "scheduled_time", "description",
];

// The jobs page mounts this button TWICE (header + empty state); only the
// FIRST mounted instance may answer ?new=1 or two modals would stack.
// Named per holder (lib/param-claim), so a strip that died on a dropped connection can't
// leave this door shut for the rest of the session.
const newParam = createParamClaim();

/**
 * NEW JOB IN FOUR FIELDS (W1-22): Customer, Address, Date, Description, and one closed More Options
 * row (Unit / Apt, Start Time, Billing) that opens itself when a restored draft has something inside.
 *
 *   No Job Name field: a live line says "It'll Be Called: 1871 Apache Ct" (the street number and
 *   name, " #56" with a unit; no street, the customer as written), and the server builds the same
 *   name (lib/schedule-options defaultJobName) since none is sent.
 *   No Status field: the server sets it from the date, on the company's today (today or earlier In
 *   Progress, later Scheduled, none To Be Scheduled). It is never On Hold (createJob refuses that).
 *   The day and the time go to the server as they were picked; the instant is built there on the
 *   company's clock, and a blank time is the company's work-day start (workDay); the form asks no
 *   length, so a dated job lands as two hours (lib/schedule/job-block DEFAULT_JOB_MINUTES).
 *   Billing starts at the kind most of this company's jobs use (usualBilling), else Time & Material.
 *   Picking a customer fills the address (never over one that was typed); the address picker stores
 *   the street, and the city, state and zip it resolved are sent hidden and shown on one grey line.
 *   When another job at that street has a unit, the line suggests More Options.
 */
export function NewJobButton({
  customers,
  defaultCustomerId,
  workDay = { start: "08:00", end: "16:00" },
  todayStr,
  usualBilling = "tm",
  unitStreets = [],
}: {
  customers: NewJobCustomerOption[];
  defaultCustomerId?: string;
  /** The company's work-day window (workDayWindowHm): a blank Start Time starts at its start. */
  workDay?: { start: string; end: string };
  /** The company's today (YYYY-MM-DD); the phone's own day only when it isn't handed over. */
  todayStr?: string;
  /** The kind of billing most of this company's jobs use (lib/schedule-options usualBillingKind). */
  usualBilling?: "tm" | "fixed";
  /** Street keys of the jobs that carry a unit (unitStreetKeys). */
  unitStreets?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [moreOpen, setMoreOpen] = useState(false);
  const today = todayStr && /^\d{4}-\d{2}-\d{2}$/.test(todayStr) ? todayStr : deviceToday();
  const option = (id: string) => customers.find((c) => c.id === id);
  // The picked customer's site-address prefill: the street, and the parts that go with it.
  const customerStreet = (id: string) => {
    const c = option(id);
    return (c?.street ?? c?.address ?? "") || "";
  };
  const emptyForm = (): JobForm => {
    const c = defaultCustomerId ? option(defaultCustomerId) : undefined;
    return {
      customer_id: defaultCustomerId ?? "",
      new_customer: false,
      new_customer_name: "",
      new_customer_phone: "",
      billing_type: usualBilling,
      // A launch-context customer (the customer-page button) prefills too — still editable.
      address: defaultCustomerId ? customerStreet(defaultCustomerId) : "",
      unit: "",
      city: c?.city ?? "",
      state: c?.state ?? "",
      zip: c?.zip ?? "",
      scheduled_date: today,
      scheduled_time: "",
      description: "",
    };
  };
  const [form, setForm] = useState<JobForm>(emptyForm);
  // Remount key for the uncontrolled AddressAutocomplete so a restored draft's
  // address actually shows (it only reads defaultValue on mount).
  const [formKey, setFormKey] = useState(0);
  const patch = (p: Partial<JobForm>) => setForm((f) => ({ ...f, ...p }));
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const toast = useToast();

  // Interruption recovery: a deploy reload / iOS killing the tab restores the
  // half-typed job. Keyed by launch context so the customer-page button and the
  // jobs-page button don't share a draft. Only this form's own fields come back (a draft saved by
  // the older form carried a name and a status this one no longer asks).
  const draft = useDraft("job-new:" + (defaultCustomerId ?? "all"), form, (f) => {
    const back = emptyForm() as unknown as Record<string, unknown>;
    for (const k of FORM_KEYS) if (k in (f as object)) back[k] = (f as unknown as Record<string, unknown>)[k];
    const restored = back as unknown as JobForm;
    setForm(restored);
    setFormKey((k) => k + 1);
    // More Options opens itself when something inside it was filled.
    if (restored.unit.trim() || restored.scheduled_time.trim() || restored.billing_type !== usualBilling) setMoreOpen(true);
  });
  // Dirty = the form differs from a fresh one (covers typed input AND a restored
  // draft; a restored-then-reset form correctly reads clean again).
  const initialSnap = useRef<string | null>(null);
  if (initialSnap.current === null) initialSnap.current = JSON.stringify(emptyForm());
  const dirty = JSON.stringify(form) !== initialSnap.current;

  // This instance's name on the ?new=1 claim; it lets go on unmount as well as below.
  const claimant = useId();
  useEffect(() => () => newParam.release(claimant), [claimant]);

  // Open straight from the quick-add menu's "New job" (/jobs?new=1), then strip
  // the param so a refresh or back-button doesn't reopen the form.
  useEffect(() => {
    if (searchParams.get("new") !== "1") {
      newParam.release(claimant); // param gone → release for the next quick-add tap
      return;
    }
    if (!newParam.take(claimant)) return;
    setOpen(true);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router, claimant]);

  function openModal() {
    if (draft.restored && dirty) toast("Draft restored — pick up where you left off", "info");
    setOpen(true);
  }

  // Confirmed close (the Modal's two-tap guard has already asked when dirty) —
  // an explicit discard, so the stored draft goes too.
  function discard() {
    draft.clear();
    setForm(emptyForm());
    setFormKey((k) => k + 1);
    setMoreOpen(false);
    setOpen(false);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await createJob(formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      // Saved — drop the draft and reset so reopening doesn't offer a duplicate.
      draft.clear();
      setForm(emptyForm());
      setFormKey((k) => k + 1);
      setMoreOpen(false);
      setOpen(false);
      router.refresh();
    });
  }

  function pickCustomer(cid: string) {
    // Prefill the site address from the picked customer — only while the field is empty or still
    // holds the previous pick's prefill, so it never clobbers typed input (addressPrefillOnCustomerPick).
    const prefill = addressPrefillOnCustomerPick(form.address, customerStreet(form.customer_id), customerStreet(cid));
    if (prefill === null) {
      patch({ customer_id: cid });
      return;
    }
    const c = option(cid);
    patch({ customer_id: cid, address: prefill, city: prefill ? (c?.city ?? "") : "", state: prefill ? (c?.state ?? "") : "", zip: prefill ? (c?.zip ?? "") : "" });
    // Uncontrolled AddressAutocomplete only reads defaultValue on mount.
    setFormKey((k) => k + 1);
  }

  const picked = form.new_customer ? { name: form.new_customer_name } : (option(form.customer_id) ?? null);
  const willBeCalled = defaultJobName({ customer: picked, street: form.address, unit: form.unit, todayStr: today });
  const storedLine = formatCityStateZip(form.city, form.state, form.zip);
  const unitHint = !form.unit.trim() && streetHasUnits(form.address, unitStreets);
  const statusWords =
    statusFromDate(form.scheduled_date, today) === "in_progress" ? "In Progress" : form.scheduled_date ? "Scheduled" : "To Be Scheduled";
  const moreSummary = [BILLING_WORDS[form.billing_type] ?? BILLING_WORDS.tm, form.unit.trim() ? unitLine(form.unit) : null, form.scheduled_time ? clockWords(form.scheduled_time) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <Button onClick={openModal}>
        <Plus className="h-4 w-4" /> New Job
      </Button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={discard}
          title="New Job"
          dirty={dirty}
          footer={<ModalActions onCancel={discard} submit saving={pending} saveLabel="Create Job" />}
        >
          <div className="space-y-4">
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

            <CustomerPicker
              idPrefix="nj"
              customers={customers}
              customerId={form.customer_id}
              onCustomerId={pickCustomer}
              isNew={form.new_customer}
              onIsNew={(v) => patch({ new_customer: v })}
              newName={form.new_customer_name}
              onNewName={(v) => patch({ new_customer_name: v })}
              newPhone={form.new_customer_phone}
              onNewPhone={(v) => patch({ new_customer_phone: v })}
            />

            <div>
              <Label htmlFor="nj-address">Address</Label>
              <AddressAutocomplete
                key={formKey}
                id="nj-address"
                name="address"
                defaultValue={form.address}
                // Guard: onTextChange also fires on mount with the unchanged value;
                // patching then would plant a pristine "draft" just from opening.
                // Typing over a picked address DROPS its parts: they describe the old line, and a
                // city left behind from a different street is exactly the false value 0177 forbids.
                onTextChange={(v) => v !== form.address && patch({ address: v, city: "", state: "", zip: "" })}
                // STREET ONLY: the street goes in the box and the city, state and zip into their own
                // columns (hidden below), never one blob line. The street is patched here too, so the
                // text change that follows a pick is not read as typing over it (which would drop the
                // parts the pick just resolved).
                streetOnly
                onResolved={(p) => patch({ address: p.line1, city: p.city ?? "", state: p.state ?? "", zip: p.zip ?? "" })}
              />
              {/* What was stored with the street, on one grey line. */}
              {storedLine && <p className="mt-1 text-xs text-slate-500">{storedLine}</p>}
              {unitHint && (
                <p className="mt-1 text-xs text-slate-500">
                  Another job at this address has a unit.{" "}
                  <button type="button" onClick={() => setMoreOpen(true)} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">
                    Add It In More Options
                  </button>
                </p>
              )}
              <input type="hidden" name="city" value={form.city} />
              <input type="hidden" name="state" value={form.state} />
              <input type="hidden" name="zip" value={form.zip} />
            </div>

            <div>
              <Label htmlFor="nj-date">Date</Label>
              {form.scheduled_date ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="nj-date"
                    type="date"
                    value={form.scheduled_date}
                    onChange={(e) => patch({ scheduled_date: e.target.value })}
                    className="w-auto"
                  />
                  <button
                    type="button"
                    onClick={() => patch({ scheduled_date: "" })}
                    className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-brand hover:underline"
                  >
                    Not Scheduled Yet
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-slate-700">Not Scheduled Yet</span>
                  <button
                    type="button"
                    onClick={() => patch({ scheduled_date: today })}
                    className="inline-flex min-h-11 items-center px-1 text-sm font-medium text-brand hover:underline"
                  >
                    Pick A Day
                  </button>
                </div>
              )}
              <input type="hidden" name="scheduled_date" value={form.scheduled_date} />
              <p className="mt-1 text-xs text-slate-500">It starts as {statusWords}.</p>
            </div>

            <div>
              <Label htmlFor="nj-description">Description</Label>
              <Textarea
                id="nj-description"
                name="description"
                rows={2}
                value={form.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500">The scope. It prints on the customer&apos;s invoice.</p>
            </div>

            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
              It&apos;ll Be Called: <span className="font-medium text-slate-900">{willBeCalled}</span>
            </p>

            {/* MORE OPTIONS, closed: Unit / Apt, Start Time and Billing. Their values are always
                sent (hidden inputs below), open or not. */}
            <div className="rounded-lg border border-slate-200">
              <button
                type="button"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((v) => !v)}
                className="flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm font-medium text-slate-700"
              >
                <span>More Options</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs font-normal text-slate-500">
                  <span className="truncate">{moreSummary}</span>
                  <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${moreOpen ? "rotate-180" : ""}`} />
                </span>
              </button>
              {moreOpen && (
                <div className="space-y-3 border-t border-slate-100 px-3 pb-3 pt-2">
                  <div>
                    <Label htmlFor="nj-unit">
                      Unit / Apt <span className="font-normal text-slate-400">(optional)</span>
                    </Label>
                    <Input id="nj-unit" value={form.unit} onChange={(e) => patch({ unit: e.target.value })} placeholder="e.g. 224, Apt B" maxLength={24} />
                  </div>
                  <div>
                    <Label htmlFor="nj-time">Start Time</Label>
                    <Input id="nj-time" type="time" value={form.scheduled_time} onChange={(e) => patch({ scheduled_time: e.target.value })} className="w-auto" />
                    {/* The truth about the default (lib/schedule/job-block): no length on this form,
                        so a dated job lands as two hours, never the rest of the day. */}
                    <p className="mt-1 text-xs text-slate-500">
                      Blank starts at {clockWords(workDay.start)}. It goes down as 2 hours; change the length on the job.
                    </p>
                  </div>
                  <div>
                    <Label htmlFor="nj-billing">Billing</Label>
                    <Select id="nj-billing" value={form.billing_type} onChange={(e) => patch({ billing_type: e.target.value })}>
                      <option value="tm">Time &amp; Material</option>
                      <option value="fixed">Fixed Price</option>
                    </Select>
                    <p className="mt-1 text-xs text-slate-500">Time &amp; Material bills the hours and materials; the estimate is a guide, not a cap.</p>
                  </div>
                </div>
              )}
              <input type="hidden" name="unit" value={form.unit} />
              <input type="hidden" name="scheduled_time" value={form.scheduled_time} />
              <input type="hidden" name="billing_type" value={form.billing_type} />
            </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
