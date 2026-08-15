"use client";

import { useState, useTransition } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createCustomer } from "@/app/(app)/crm/actions";

/**
 * "+ NEW CUSTOMER", RIGHT WHERE THE PICKER IS — one control, every surface.
 *
 * Erik: "we want to be able to save a new customer whenever we need to and i noticed a few spots
 * i couldnt add a customer until i dug for it but shouldnt be required as we planned."
 *
 * The sweep found five pickers with no way to create what they pick: the estimate builder (the
 * FIRST screen of the whole flow), both invoice modals, the two recurring templates, and the
 * job-contacts linker — whose empty state literally instructed the user to leave ("Add a contact
 * to the book first… then link them here"). An instruction to go elsewhere is the workaround for
 * the missing button, written down.
 *
 * Three surfaces already had their own inline-create (appointments, new-job, job-edit) and cn-v677
 * fixed the saved-quote picker; this component is that same pattern extracted, so the NEXT picker
 * ships with it instead of instructions.
 *
 * IT GOES THROUGH createCustomer, NEVER A HAND-ROLLED INSERT. The sweep also found three older
 * surfaces inserting into `customers` directly, which skips phone/state/zip normalization — so a
 * phone typed 5551234567 stores unformatted on one path and formatted on another. This component
 * exists partly so that stops multiplying.
 *
 * Name + phone only. Everything else lives on the contact page; a modal that asks eight questions
 * to link one name is why people gave up and picked "None".
 */
export function NewCustomerInline({
  onCreated,
  className,
}: {
  /** Called with the new row so the host can select/attach it immediately — creating without
   *  attaching is the same dead end one step later. */
  onCreated: (c: { id: string; name: string }) => void | Promise<void>;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`inline-flex items-center gap-1 text-sm font-medium text-brand underline-offset-2 hover:underline ${className ?? ""}`}
      >
        <Plus className="h-3.5 w-3.5" /> New customer
      </button>
    );

  return (
    <div className={`space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2 ${className ?? ""}`}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Input placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <Input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" />
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || (!name.trim() && !phone.trim())}
          onClick={() =>
            start(async () => {
              setErr(null);
              const fd = new FormData();
              fd.set("name", name.trim());
              if (phone.trim()) fd.set("phone", phone.trim());
              const r = await createCustomer(fd);
              if (!r.ok || !r.id) return setErr(r.error ?? "Couldn't save the customer.");
              await onCreated({ id: r.id, name: name.trim() || phone.trim() });
              setOpen(false);
              setName("");
              setPhone("");
            })
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save customer"}
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-slate-500 hover:underline">
          Cancel
        </button>
        <span className="text-xs text-slate-400">Email and address go in later, on their contact page.</span>
      </div>
    </div>
  );
}
