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
  const [coach, setCoach] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

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

  const hadContent = useRef(false);
  function openFresh() {
    setPrefill(EMPTY);
    setCity("");
    setState("");
    setZip("");
    setImportMsg(null);
    setCoach(null);
    setError(null);
    // Remount the defaultValue fields ONLY when a previous session left content behind —
    // remounting on every open raced Safari's form scan (see the form-level note below).
    if (hadContent.current) setFormKey((k) => k + 1);
    hadContent.current = false;
    setOpen(true);
  }

  function applyContact(c: Partial<VCardContact>) {
    hadContent.current = true;
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
        <Plus className="h-4 w-4" /> New Customer
      </Button>

      {/* autoComplete="on" declared on the FORM: Safari's contact matching keys off the form's
          declared shape, and the modal's fields remounting mid-scan (formKey) is the likeliest
          culprit for weeks of "glitchy popup" — the blue button attaching to a half-scanned form,
          occasionally winning the race ("worked that one time"). The remount now happens only
          when a card actually fills the fields, never on plain open. */}
      <form action={onSubmit} autoComplete="on">
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="New customer"
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              submit
              saving={pending}
              saveLabel="Create Customer"
            />
          }
        >
          <div
            className={`space-y-4 rounded-xl transition-shadow ${dragging ? "ring-2 ring-brand ring-offset-2" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              /* CONTACTS.APP IS THE PICKER. On the Mac, dragging a person out of Contacts drags a
                 .vcf — ⌘Space their name, drag the card here, the whole form fills. Deterministic
                 where Safari's autofill matcher is moody, zero setup, one contact at a time, and
                 nothing personal ever stored — the answer to the synced-book idea Erik rightly
                 killed ("nobody wants all of their contacts in their business folder"). */
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f && /\.vcf$|vcard/i.test(f.name + f.type)) {
                f.text().then((t) => {
                  const rows = parseVCards(t);
                  if (rows[0]) { applyContact(rows[0]); setImportMsg("Filled from the card — review and save."); }
                  else setImportMsg("Couldn't read that card.");
                });
                return;
              }
              const txt = e.dataTransfer.getData("text/vcard") || e.dataTransfer.getData("text/plain");
              if (txt && /BEGIN:VCARD/i.test(txt)) {
                const rows = parseVCards(txt);
                if (rows[0]) { applyContact(rows[0]); setImportMsg("Filled from the card — review and save."); }
              }
            }}
          >
            {/* THE PHONE'S OWN CONTACTS, by whichever door this platform actually opens.
                Erik, on the old dashed box: "archaic ... it should be a contact picker."
                · Where the Contact Picker API exists (Android Chrome; Safari the browser), the
                  button opens the real address book.
                · Inside an INSTALLED iOS web app, Apple hides that API — but the keyboard doesn't:
                  with the fields declared (autocomplete name/tel/email), focusing Name or Phone
                  puts the person's contact right on the QuickType bar. So there, the guidance IS
                  the feature, one quiet line — not a dashed ritual box explaining a .vcf safari. */}
            {/* ONE OBVIOUS BUTTON, whichever door this platform opens. Erik found the iOS
                keyboard flow himself (AutoFill Contact → Other Contact… → the full native picker,
                per-field checkboxes and all, INSIDE the installed app) — "but it wasnt obvious."
                A grey hint line is not a feature. The button is:
                  · real Contact Picker API (Android Chrome, Safari the browser) → opens it
                  · iPhone/iPad installed app → focuses Name and points at the AutoFill Contact
                    bar now sitting one inch away above the keyboard
                  · Mac → focuses Name and says the Mac's gesture: type the name, matching
                    contacts drop down ("it doesnt do that on the computer" — different door,
                    same book). */}
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setImportMsg(null);
                    if (hasPicker) { importContact(); return; }
                    /* NO programmatic focus — Safari arms its contact matching most reliably off
                       the user's OWN click into the field, and stealing that click was part of
                       why the Mac flow that "worked that one time" stopped working. */
                    setCoach(
                      navigator.maxTouchPoints > 0
                        ? "Now tap “AutoFill Contact” above the keyboard → “Other Contact…” and pick them."
                        : /* THE MAC'S REAL MECHANISM, decoded by Erik: "something was telling
                             that little blue button to catch what was being typed." Exactly —
                             Safari matches the letters typed in Name against Contacts and
                             re-targets the blue card to THAT person; that is what worked the one
                             time. It is also moody under a 2,000-contact book (it served S-names
                             for "Jeff"), so the deterministic door is the drag: Contacts.app IS
                             the picker, and this form catches the card. */
                          "Click into Name and type the first letters of THEIR name — when their card pops up, choose it. Or open Contacts and drag their card anywhere onto this form.",
                    );
                  }}
                >
                  <Contact className="h-4 w-4 shrink-0" /> Add from my Contacts
                </Button>
                <button type="button" onClick={() => fileRef.current?.click()} className="text-[11px] text-slate-400 underline-offset-2 hover:text-brand hover:underline">
                  or import a .vcf
                </button>
              </div>
              {coach && (
                <p className="rounded-lg bg-brand-light/50 px-2.5 py-1.5 text-xs font-medium text-brand">{coach}</p>
              )}
              {importMsg && <p className="text-[11px] font-medium text-emerald-600">{importMsg}</p>}
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
                <Input id="name" name="name" autoComplete="name" required placeholder="Customer or contact name" defaultValue={prefill.name} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="company_name">Company</Label>
                <Input id="company_name" name="company_name" autoComplete="organization" placeholder="(optional)" defaultValue={prefill.company_name} />
              </div>
              <div>
                <Label htmlFor="type">Type</Label>
                <Select id="type" name="type" defaultValue="residential">
                  <option value="residential">Residential</option>
                  <option value="commercial">Commercial</option>
                  <option value="industrial">Industrial</option>
                  <option value="contractor">Contractor</option>
                <option value="subcontractor">Subcontractor</option>
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
                <Input id="email" name="email" type="email" autoComplete="email" defaultValue={prefill.email} />
              </div>
              <div>
                <Label htmlFor="phone">Phone</Label>
                <PhoneInput id="phone" name="phone" autoComplete="tel" defaultValue={prefill.phone} />
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
                <Input id="city" name="city" autoComplete="address-level2" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="state">State</Label>
                  <StateSelect id="state" name="state" value={state} onChange={setState} />
                </div>
                <div>
                  <Label htmlFor="zip">Zip</Label>
                  <Input id="zip" name="zip" autoComplete="postal-code" value={zip} onChange={(e) => setZip(e.target.value)} />
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
