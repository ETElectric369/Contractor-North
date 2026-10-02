"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { formatCityStateZip } from "@/lib/utils";
import { CustomerPicker } from "../../schedule/new-job-button";
import { MANAGE_ROW_CLS } from "./job-manage-menu";
import { updateJob } from "../actions";
import type { Job } from "@/lib/types";

/**
 * EDIT JOB IN FIVE FIELDS (W1-22): Job Name, Customer (New Job's own picker; + New Customer is a
 * Name and a Phone, through the one match-then-insert door), Address (the street picker, with what
 * it stored on a grey line under it), Unit / Apt, and Billing (starting at the job's own). The
 * job-code template stays exactly as it was, only when Job Codes is on and templates exist.
 *
 * What left, to its one editor on the Overview: the dates (Scheduled), the description (its box) and
 * the crew (the crew chips). updateJob writes a column only when its field is sent, so saving this
 * short form can never clear the job's dates, its scope or its crew, or push an empty schedule to
 * Google.
 */
export function JobEditButton({
  job,
  customers,
  templates = [],
  menuItem = false,
}: {
  job: Job;
  customers: { id: string; name: string }[];
  templates?: { id: string; name: string }[];
  /** Render the trigger as a Manage-menu row instead of a standalone button. */
  menuItem?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [customerId, setCustomerId] = useState(job.customer_id ?? "");
  const [newCust, setNewCust] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [street, setStreet] = useState(job.address ?? "");
  const [city, setCity] = useState(job.city ?? "");
  const [state, setState] = useState(job.state ?? "");
  const [zip, setZip] = useState(job.zip ?? "");
  const [formKey, setFormKey] = useState(0);
  const router = useRouter();

  function reset() {
    setCustomerId(job.customer_id ?? "");
    setNewCust(false);
    setNewName("");
    setNewPhone("");
    setStreet(job.address ?? "");
    setCity(job.city ?? "");
    setState(job.state ?? "");
    setZip(job.zip ?? "");
    setFormKey((k) => k + 1);
    setError(null);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    start(async () => {
      const res = await updateJob(job.id, formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  const storedLine = formatCityStateZip(city, state, zip);

  return (
    <>
      {menuItem ? (
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(true);
          }}
          className={MANAGE_ROW_CLS}
        >
          <Pencil className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Edit Job
        </button>
      ) : (
        <Button
          variant="outline"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          <Pencil className="h-4 w-4" /> Edit Job
        </Button>
      )}

      {/* portal + a form-INSIDE-the-modal (submitted by id) so this opens correctly even though the
          trigger lives in the glass Manage menu — whose backdrop-filter would otherwise trap the
          overlay. See Modal's `portal` prop. */}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit Job"
        portal
        footer={<ModalActions onCancel={() => setOpen(false)} submit formId="job-edit-form" saving={pending} saveLabel="Save Changes" />}
      >
        <form id="job-edit-form" action={onSubmit} className="space-y-4">
          {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

          <div>
            <Label htmlFor="ej-name">Job Name *</Label>
            <Input id="ej-name" name="name" required defaultValue={job.name} />
          </div>

          <CustomerPicker
            idPrefix="ej"
            customers={customers}
            customerId={customerId}
            onCustomerId={setCustomerId}
            isNew={newCust}
            onIsNew={setNewCust}
            newName={newName}
            onNewName={setNewName}
            newPhone={newPhone}
            onNewPhone={setNewPhone}
          />

          <div>
            <Label htmlFor="ej-address">Address</Label>
            <AddressAutocomplete
              key={formKey}
              id="ej-address"
              name="address"
              streetOnly
              defaultValue={street}
              // Typing over the street DROPS the old city, state and zip: they describe the old line
              // (a city left behind from a different street is the false value 0177 forbids).
              onTextChange={(v) => {
                if (v === street) return;
                setStreet(v);
                setCity("");
                setState("");
                setZip("");
              }}
              onResolved={(p) => {
                // The street too, so the text change that follows a pick is not read as typing over it.
                setStreet(p.line1);
                setCity(p.city ?? "");
                setState(p.state ?? "");
                setZip(p.zip ?? "");
              }}
            />
            {storedLine && <p className="mt-1 text-xs text-slate-500">{storedLine}</p>}
            <input type="hidden" name="city" value={city} />
            <input type="hidden" name="state" value={state} />
            <input type="hidden" name="zip" value={zip} />
          </div>

          <div>
            {/* THE DWELLING. Four Alder Ridge jobs share 300 W Garnet Blvd and the number lived
                only inside the job NAME, so every document named the building. The address picker
                never fills it: Google returns a street, not somebody's apartment. */}
            <Label htmlFor="ej-unit">
              Unit / Apt <span className="font-normal text-slate-400">(optional)</span>
            </Label>
            <Input id="ej-unit" name="unit" defaultValue={job.unit ?? ""} placeholder="e.g. 224, Apt B" maxLength={24} />
          </div>

          <div>
            <Label htmlFor="ej-billing">Billing</Label>
            {/* The job's own kind, read the way the money math reads it (computeJobProgress: anything
                but "tm" is fixed), so re-saving never flips how a job bills as a side effect. */}
            <Select id="ej-billing" name="billing_type" defaultValue={(job as { billing_type?: string | null }).billing_type === "tm" ? "tm" : "fixed"}>
              <option value="tm">Time &amp; Material</option>
              <option value="fixed">Fixed Price</option>
            </Select>
            <p className="mt-1 text-xs text-slate-400">Time &amp; Material bills the hours and materials; the estimate is a guide, not a cap.</p>
          </div>

          {templates.length > 0 && (
            <div>
              <Label htmlFor="ej-template">Job-Code Template</Label>
              <Select id="ej-template" name="code_template_id" defaultValue={(job as { code_template_id?: string | null }).code_template_id ?? ""}>
                <option value="">All codes</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-400">Limits the crew&apos;s clock-in/out code picker to this job&apos;s codes.</p>
            </div>
          )}
        </form>
      </Modal>
    </>
  );
}
