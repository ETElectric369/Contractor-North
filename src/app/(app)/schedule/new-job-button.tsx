"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useDraft } from "@/lib/use-draft";
import { useToast } from "@/components/toast";
import { createJob } from "./actions";

interface CustomerOption {
  id: string;
  name: string;
}

// The whole form as ONE serializable object so useDraft can mirror it.
interface JobForm {
  name: string;
  customer_id: string;
  new_customer: boolean;
  new_customer_name: string;
  new_customer_phone: string;
  new_customer_email: string;
  status: string;
  billing_type: string;
  address: string;
  scheduled_date: string;
  scheduled_time: string; // optional "HH:MM"; blank = all-day (default 8–4 window)
  description: string;
}

// The jobs page mounts this button TWICE (header + empty state); only the
// FIRST mounted instance may answer ?new=1 or two modals would stack.
let newParamClaimed = false;

export function NewJobButton({
  customers,
  defaultCustomerId,
}: {
  customers: CustomerOption[];
  defaultCustomerId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // "Auto pick a date for you" — default to today, still changeable.
  const today = (() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const emptyForm = (): JobForm => ({
    name: "",
    customer_id: defaultCustomerId ?? "",
    new_customer: false,
    new_customer_name: "",
    new_customer_phone: "",
    new_customer_email: "",
    status: "in_progress", // a hand-created job is usually already underway (Erik 2026-07)
    billing_type: "tm",
    address: "",
    scheduled_date: today,
    scheduled_time: "",
    description: "",
  });
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
  // jobs-page button don't share a draft.
  const draft = useDraft(
    "job-new:" + (defaultCustomerId ?? "all"),
    form,
    (f) => {
      setForm({ ...emptyForm(), ...f });
      setFormKey((k) => k + 1);
    },
  );
  // Dirty = the form differs from a fresh one (covers typed input AND a restored
  // draft; a restored-then-reset form correctly reads clean again).
  const initialSnap = useRef<string | null>(null);
  if (initialSnap.current === null) initialSnap.current = JSON.stringify(emptyForm());
  const dirty = JSON.stringify(form) !== initialSnap.current;

  // Open straight from the quick-add menu's "New job" (/jobs?new=1), then strip
  // the param so a refresh or back-button doesn't reopen the form.
  useEffect(() => {
    if (searchParams.get("new") !== "1") {
      newParamClaimed = false; // param gone → release for the next quick-add tap
      return;
    }
    if (newParamClaimed) return;
    newParamClaimed = true;
    setOpen(true);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

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
    setOpen(false);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    // Convert the local date to ISO here so the server never guesses the timezone.
    // A time is OPTIONAL (fragment-first): blank keeps the all-day 8 AM default;
    // an explicit "HH:MM" rides through as the job's real start time-of-day.
    const clock = /^\d{2}:\d{2}/.test(form.scheduled_time) ? form.scheduled_time.slice(0, 5) : "08:00";
    formData.set(
      "scheduled_start",
      form.scheduled_date ? new Date(`${form.scheduled_date}T${clock}:00`).toISOString() : "",
    );
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
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={openModal}>
        <Plus className="h-4 w-4" /> New Job
      </Button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={discard}
          title="New job"
          dirty={dirty}
          footer={
            <ModalActions
              onCancel={discard}
              submit
              saving={pending}
              saveLabel="Create Job"
            />
          }
        >
          <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div>
            <Label htmlFor="name">Job name *</Label>
            <Input
              id="name"
              name="name"
              required
              placeholder="e.g. Smith panel upgrade"
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="customer_id">Customer</Label>
                <button
                  type="button"
                  onClick={() => patch({ new_customer: !form.new_customer })}
                  className="text-xs font-medium text-brand hover:underline"
                >
                  {form.new_customer ? "Pick Existing" : "+ New Customer"}
                </button>
              </div>
              {form.new_customer ? (
                <Input
                  name="new_customer_name"
                  placeholder="New customer name"
                  autoFocus
                  value={form.new_customer_name}
                  onChange={(e) => patch({ new_customer_name: e.target.value })}
                />
              ) : (
                <Select
                  id="customer_id"
                  name="customer_id"
                  value={form.customer_id}
                  onChange={(e) => patch({ customer_id: e.target.value })}
                >
                  <option value="">— None —</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <div>
              <Label htmlFor="status">Status</Label>
              <Select
                id="status"
                name="status"
                value={form.status}
                onChange={(e) => patch({ status: e.target.value })}
              >
                <option value="in_progress">In progress</option>
                <option value="to_be_scheduled">To be scheduled</option>
                <option value="scheduled">Scheduled</option>
                <option value="on_hold">On hold</option>
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="billing_type">Billing</Label>
            <Select
              id="billing_type"
              name="billing_type"
              value={form.billing_type}
              onChange={(e) => patch({ billing_type: e.target.value })}
            >
              <option value="tm">Time &amp; Material</option>
              <option value="fixed">Fixed price</option>
            </Select>
            <p className="mt-1 text-xs text-slate-400">Time &amp; Material bills actual labor + materials; the estimate is a reference, not a cap.</p>
          </div>
          {form.new_customer && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="new_customer_phone">Customer phone</Label>
                <Input
                  id="new_customer_phone"
                  name="new_customer_phone"
                  placeholder="(optional)"
                  value={form.new_customer_phone}
                  onChange={(e) => patch({ new_customer_phone: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="new_customer_email">Customer email</Label>
                <Input
                  id="new_customer_email"
                  name="new_customer_email"
                  type="email"
                  placeholder="(optional)"
                  value={form.new_customer_email}
                  onChange={(e) => patch({ new_customer_email: e.target.value })}
                />
              </div>
            </div>
          )}
          <div>
            <Label htmlFor="address">Site address</Label>
            <AddressAutocomplete
              key={formKey}
              id="address"
              name="address"
              defaultValue={form.address}
              // Guard: onTextChange also fires on mount with the unchanged value;
              // patching then would plant a pristine "draft" just from opening.
              onTextChange={(v) => v !== form.address && patch({ address: v })}
              onResolved={(p) => {
                // Auto-fill the job name with "number + street" when empty.
                if (!form.name.trim() && p.line1) patch({ name: p.line1 });
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="scheduled_start">Scheduled date</Label>
              <Input
                id="scheduled_start"
                type="date"
                value={form.scheduled_date}
                onChange={(e) => patch({ scheduled_date: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="scheduled_time">Start time</Label>
              <Input
                id="scheduled_time"
                type="time"
                value={form.scheduled_time}
                onChange={(e) => patch({ scheduled_time: e.target.value })}
              />
              <p className="mt-1 text-xs text-slate-400">Optional — leave blank for all-day.</p>
            </div>
          </div>
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              name="description"
              rows={2}
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
