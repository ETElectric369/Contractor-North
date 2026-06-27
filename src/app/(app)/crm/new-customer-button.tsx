"use client";

import { useState, useRef, useTransition, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, Contact } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { StateSelect } from "@/components/ui/state-select";
import { parseVCards, type VCardContact } from "@/lib/vcard";
import { createCustomer } from "./actions";

const EMPTY = { name: "", company_name: "", email: "", phone: "", address: "" };

export function NewCustomerButton() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // City/state/zip are controlled (the address autocomplete fills them); the rest prefill
  // via defaultValue + a remount key so importing a contact populates the whole form.
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [prefill, setPrefill] = useState(EMPTY);
  const [formKey, setFormKey] = useState(0);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [hasPicker, setHasPicker] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // The native Contact Picker (Android/Chrome mobile) lets you tap one contact; iOS Safari
  // doesn't support it, so there we fall back to a shared .vcf card. Detect client-side.
  useEffect(() => {
    setHasPicker(
      typeof navigator !== "undefined" &&
        "contacts" in navigator &&
        typeof (navigator as unknown as { contacts?: { select?: unknown } }).contacts?.select === "function",
    );
  }, []);

  // Open straight from the quick-add menu's "New customer" (/crm?new=1), then strip
  // the param so a refresh or back-button doesn't reopen the form.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    openFresh();
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openFresh() {
    setPrefill(EMPTY);
    setCity("");
    setState("");
    setZip("");
    setImportMsg(null);
    setError(null);
    setFormKey((k) => k + 1);
    setOpen(true);
  }

  function applyContact(c: Partial<VCardContact>) {
    setPrefill({
      name: c.name ?? "",
      company_name: c.company_name ?? "",
      email: c.email ?? "",
      phone: c.phone ?? "",
      address: c.address ?? "",
    });
    setCity(c.city ?? "");
    setState(c.state ?? "");
    setZip(c.zip ?? "");
    setFormKey((k) => k + 1); // remount the fields so defaultValues pick up
    setImportMsg(c.name ? `Filled in ${c.name} — review and save.` : null);
  }

  async function importContact() {
    setImportMsg(null);
    if (hasPicker) {
      try {
        const nav = navigator as unknown as {
          contacts: { select: (props: string[], opts: { multiple: boolean }) => Promise<any[]> };
        };
        const sel = await nav.contacts.select(["name", "tel", "email", "address"], { multiple: false });
        if (!sel?.length) return;
        const c = sel[0];
        const first = (v: unknown) => (Array.isArray(v) ? v[0] : v) ?? "";
        const adr = Array.isArray(c.address) ? c.address[0] : c.address;
        applyContact({
          name: String(first(c.name)),
          email: String(first(c.email)),
          phone: String(first(c.tel)),
          address: adr?.addressLine?.join(" ") ?? "",
          city: adr?.city ?? "",
          state: adr?.region ?? "",
          zip: adr?.postalCode ?? "",
        });
      } catch {
        // user cancelled, or the picker isn't really available — fall back to a contact card
        fileRef.current?.click();
      }
      return;
    }
    fileRef.current?.click();
  }

  function onVcfFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = parseVCards(String(reader.result ?? ""));
      if (!rows.length) {
        setImportMsg("Couldn't read a contact from that card. Make sure it's a .vcf you shared from Contacts.");
        return;
      }
      applyContact(rows[0]);
    };
    reader.readAsText(f);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await createCustomer(formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/crm/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={openFresh}>
        <Plus className="h-4 w-4" /> New customer
      </Button>

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="New customer"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              submit
              saving={pending}
              saveLabel="Create customer"
            />
          }
        >
          <div className="space-y-4">
            {/* Import ONE contact from the phone, right into the form. */}
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/60 px-3 py-2.5">
              <button
                type="button"
                onClick={importContact}
                className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:text-brand-dark"
              >
                <Contact className="h-4 w-4" /> Import 1 contact from my phone
              </button>
              <p className="mt-1 text-[11px] leading-snug text-slate-400">
                {hasPicker
                  ? "Pick one contact — we'll fill in the form below, you review and save."
                  : "iPhone: open a contact → Share → Save to Files, then pick the .vcf here. We'll fill in the form below."}
              </p>
              {importMsg && <p className="mt-1 text-[11px] font-medium text-emerald-600">{importMsg}</p>}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".vcf,text/vcard,text/x-vcard"
              className="hidden"
              onChange={onVcfFile}
            />

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                {error}
              </div>
            )}
            <div key={formKey} className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="name">Name *</Label>
                <Input id="name" name="name" required placeholder="Customer or contact name" defaultValue={prefill.name} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="company_name">Company</Label>
                <Input id="company_name" name="company_name" placeholder="(optional)" defaultValue={prefill.company_name} />
              </div>
              <div>
                <Label htmlFor="type">Type</Label>
                <Select id="type" name="type" defaultValue="residential">
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                  <option value="industrial">Industrial</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="status">Status</Label>
                <Select id="status" name="status" defaultValue="active">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" defaultValue={prefill.email} />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <PhoneInput id="phone" name="phone" defaultValue={prefill.phone} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="address">Address</Label>
                <AddressAutocomplete
                  id="address"
                  name="address"
                  streetOnly
                  defaultValue={prefill.address}
                  onResolved={(p) => {
                    setCity(p.city);
                    setState(p.state);
                    setZip(p.zip);
                  }}
                />
              </div>
              <div>
                <Label htmlFor="city">City</Label>
                <Input id="city" name="city" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="state">State</Label>
                  <StateSelect id="state" name="state" value={state} onChange={setState} />
                </div>
                <div>
                  <Label htmlFor="zip">Zip</Label>
                  <Input id="zip" name="zip" value={zip} onChange={(e) => setZip(e.target.value)} />
                </div>
              </div>
              <div className="col-span-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" name="notes" rows={2} />
              </div>
            </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
