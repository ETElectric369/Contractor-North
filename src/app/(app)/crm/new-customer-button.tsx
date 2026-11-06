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
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";

/** Words with one piece of markup inside: the words split at the slot, the piece between them. */
function aroundSlot(words: string, slot: string, piece: React.ReactNode) {
  const [before, after = ""] = words.split(slot);
  return (
    <>
      {before}
      {piece}
      {after}
    </>
  );
}

const EMPTY = { name: "", company_name: "", email: "", phone: "", address: "" };

export function NewCustomerButton() {
  const t = translator(useLang());
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

  // Open straight from a link to /crm?new=1 (the + no longer has New Customer: a customer is made
  // inside New Job, New Estimate and New Invoice, and this is Customers' own Add; the deep link still
  // works), then strip the param so a refresh or back-button doesn't reopen the form. Keyed to
  // searchParams, not mount: already ON /crm, a link only changes the query string — the
  // mount-once version had already run, so the link silently did nothing.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    openFresh();
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const hadContent = useRef(false);
  function openFresh() {
    setPrefill(EMPTY);
    setCity("");
    setState("");
    setZip("");
    setImportMsg(null);
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
    setImportMsg(c.name ? fillText(t("cu_filledIn"), { name: c.name }) : null);
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
        setImportMsg(t("cu_cantReadCard"));
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
        setError(res.error ?? t("cu_somethingWrong"));
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/crm/${res.id}`);
    });
  }

  return (
    <>
      <Button onClick={openFresh}>
        <Plus className="h-4 w-4" /> {t("cu_btn_newCustomer")}
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
          title={t("cu_btn_newCustomer")}
          footer={
            <ModalActions
              onCancel={() => setOpen(false)}
              submit
              saving={pending}
              saveLabel={t("cu_btn_createCustomer")}
            />
          }
        >
          {/* KISS (Erik, after the drag-drop froze Safari solid): no drop targets, no
              coaching machinery, no wrestling the browser. The declared fields quietly power
              whatever autofill each platform natively offers; the picker button appears only
              where the real Contact Picker API exists; the full native-sheet experience waits
              for the native shell, where CNContactPicker does it properly. */}
          <div className="space-y-4">
            {/* THE PHONE'S OWN CONTACTS, by whichever door this platform actually opens.
                Erik, on the old dashed box: "archaic ... it should be a contact picker."
                · Where the Contact Picker API exists (Android Chrome; Safari the browser), the
                  button opens the real address book.
                · Inside an INSTALLED iOS web app, Apple hides that API — but the keyboard doesn't:
                  with the fields declared (autocomplete name/tel/email), focusing Name or Phone
                  puts the person's contact right on the QuickType bar. So there, the guidance IS
                  the feature, one quiet line — not a dashed ritual box explaining a .vcf safari. */}
            <div className="flex flex-wrap items-center gap-2">
              {hasPicker && (
                <Button type="button" size="sm" variant="outline" onClick={importContact}>
                  <Contact className="h-4 w-4 shrink-0" /> {t("cu_btn_addFromMyContacts")}
                </Button>
              )}
              <button type="button" onClick={() => fileRef.current?.click()} className="text-[11px] text-slate-400 underline-offset-2 hover:text-brand hover:underline">
                {t("cu_importVcf")}
              </button>
              {importMsg && <span className="text-[11px] font-medium text-emerald-600">{importMsg}</span>}
            </div>
            {/* One line, no machinery — Erik reached the full card panel twice by typing, so the
                gesture is real; it just needed saying once. */}
            <p className="text-[11px] leading-snug text-slate-400">
              {aroundSlot(t("cu_autofillTip"), "{autofill}", <span className="font-medium text-slate-500">{t("cu_autofill")}</span>)}
            </p>
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
                <Label htmlFor="name">{t("cu_nameRequired")}</Label>
                <Input id="name" name="name" autoComplete="name" required placeholder={t("cu_namePlaceholder")} defaultValue={prefill.name} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="company_name">{t("cu_company")}</Label>
                <Input id="company_name" name="company_name" autoComplete="organization" placeholder={t("cu_optional")} defaultValue={prefill.company_name} />
              </div>
              <div>
                <Label htmlFor="type">{t("cu_type")}</Label>
                <Select id="type" name="type" defaultValue="residential">
                  <option value="residential">{t("cu_btn_typeResidential")}</option>
                  <option value="commercial">{t("cu_btn_typeCommercial")}</option>
                  <option value="industrial">{t("cu_btn_typeIndustrial")}</option>
                  <option value="contractor">{t("cu_btn_typeContractor")}</option>
                <option value="subcontractor">{t("cu_btn_typeSubcontractor")}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="status">{t("cu_status")}</Label>
                <Select id="status" name="status" defaultValue="active">
                  <option value="active">{t("cu_btn_statusActive")}</option>
                  <option value="inactive">{t("cu_btn_statusInactive")}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="email">{t("cu_email")}</Label>
                <Input id="email" name="email" type="email" autoComplete="email" defaultValue={prefill.email} />
              </div>
              <div>
                <Label htmlFor="phone">{t("cu_phone")}</Label>
                <PhoneInput id="phone" name="phone" autoComplete="tel" defaultValue={prefill.phone} />
              </div>
              <div className="col-span-2">
                <Label htmlFor="address">{t("cu_address")}</Label>
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
                <Label htmlFor="city">{t("cu_city")}</Label>
                <Input id="city" name="city" autoComplete="address-level2" value={city} onChange={(e) => setCity(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="state">{t("cu_state")}</Label>
                  <StateSelect id="state" name="state" value={state} onChange={setState} />
                </div>
                <div>
                  <Label htmlFor="zip">{t("cu_zip")}</Label>
                  <Input id="zip" name="zip" autoComplete="postal-code" value={zip} onChange={(e) => setZip(e.target.value)} />
                </div>
              </div>
              <div className="col-span-2">
                <Label htmlFor="notes">{t("cu_notes")}</Label>
                <Textarea id="notes" name="notes" rows={2} />
              </div>
            </div>
          </div>
        </Modal>
      </form>
    </>
  );
}
