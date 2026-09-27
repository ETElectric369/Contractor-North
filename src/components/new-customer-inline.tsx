"use client";

import { useState, useTransition } from "react";
import { formatPhone } from "@/lib/utils";
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
 *
 * IT READS IN A NARROW COLUMN (bug report, Tahoe, 8/26): the hint used to sit beside the buttons,
 * where a narrow column squeezed it into a stack of tiny words, and the button changed width the
 * moment it started saving. Now Name and Phone stack whenever the box itself is narrow (a container
 * query - the viewport can be wide while the column is not), the hint has its own line under the
 * buttons, and the button keeps its width while saving ("Saving…" beside the spinner). Every tap
 * target is 44px.
 */
export function NewCustomerInline({
  onCreated,
  className,
  initialName = "",
  label = "New Customer",
}: {
  /** Called with the new row so the host can select/attach it immediately — creating without
   *  attaching is the same dead end one step later. */
  onCreated: (c: { id: string; name: string }) => void | Promise<void>;
  className?: string;
  /** What was typed where nothing matched (/billing's New Invoice): the name box starts with it. */
  initialName?: string;
  /** The closed button's words ("New Customer 'Tao Zhu'"). */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open)
    return (
      <button
        type="button"
        onClick={() => {
          setName((n) => n || initialName);
          setOpen(true);
        }}
        className={`inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand underline-offset-2 hover:underline ${className ?? ""}`}
      >
        <Plus className="h-3.5 w-3.5" /> {label}
      </button>
    );

  return (
    <div className={`@container space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2 ${className ?? ""}`}>
      <div className="grid grid-cols-1 gap-2 @sm:grid-cols-2">
        {/* DECLARED FIELDS, so the Mac's own Contacts can fill them. Erik watched Safari's
            AutoFill-from-Contacts offer the guy's real number here EXACTLY ONCE and never again:
            with no autocomplete/name/type, the browser has to GUESS which box is a phone, and it
            guesses inconsistently. Declared, the offer is reliable — no plugin, nothing to pay
            for; it's built into Safari (Settings → AutoFill → "info from my contacts"). */}
        <Input name="name" autoComplete="name" placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} className="h-11" autoFocus />
        <Input name="phone" type="tel" autoComplete="tel" placeholder="Phone" value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} inputMode="tel" className="h-11" />
      </div>
      {err && <p className="text-sm text-rose-600">{err}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="min-w-[9.5rem]"
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
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </>
          ) : (
            "Save Customer"
          )}
        </Button>
        <button type="button" onClick={() => setOpen(false)} className="inline-flex min-h-11 items-center px-2 text-sm text-slate-500 hover:underline">
          Cancel
        </button>
      </div>
      <p className="text-xs text-slate-400">Email and address go in later, on their contact page.</p>
    </div>
  );
}
