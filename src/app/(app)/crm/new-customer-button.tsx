"use client";

import { useState, useRef, useTransition, useEffect } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, Contact } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { CustomerFields, customerFormValue, type CustomerFormValue } from "@/components/customer-fields";
import { DuplicateCustomerAsk } from "@/components/duplicate-customer-ask";
import { personValue } from "@/components/person-fields";
import type { CustomerMatch } from "@/lib/crm/duplicates";
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

export function NewCustomerButton() {
  const t = translator(useLang());
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // THE ONE CUSTOMER FORM (cn-v1171, components/customer-fields): its value lives here. The phone and
  // the street are uncontrolled inside the person block, so a filled-in card or a reset remounts the
  // fields (formKey) to show; the sheet itself is never remounted.
  const [form, setForm] = useState<CustomerFormValue>(() => customerFormValue());
  const [formKey, setFormKey] = useState(0);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  // ALREADY IN THE BOOK (cn-v1171): createCustomer made nothing and said who. The typed fields stay
  // on screen under the ask; Add Anyway posts the same form again with allow_duplicate=1.
  const [dup, setDup] = useState<{ match: CustomerMatch; sentence: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const addAnyway = useRef(false);

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
    setForm(customerFormValue());
    setImportMsg(null);
    setError(null);
    setDup(null);
    // Remount the fields ONLY when a previous session left content behind — remounting on every
    // open raced Safari's form scan (see the form-level note below).
    if (hadContent.current) setFormKey((k) => k + 1);
    hadContent.current = false;
    setOpen(true);
  }

  /** A typed change: there is content to clear next time, and an ask about the old words is stale. */
  function change(patch: Partial<CustomerFormValue>) {
    hadContent.current = true;
    setDup(null);
    setForm((f) => ({ ...f, ...patch }));
  }

  function applyContact(c: Partial<VCardContact>) {
    hadContent.current = true;
    setDup(null);
    setForm((f) => ({ ...f, ...personValue(c) }));
    setFormKey((k) => k + 1); // remount the fields so the phone and the street pick up
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
    if (addAnyway.current) formData.set("allow_duplicate", "1");
    addAnyway.current = false;
    startTransition(async () => {
      const res = await createCustomer(formData);
      if (!res.ok && res.duplicate) {
        setDup({ match: res.duplicate, sentence: res.error ?? "" });
        return;
      }
      setDup(null);
      if (!res.ok) {
        setError(res.error ?? t("cu_somethingWrong"));
        return;
      }
      setOpen(false);
      if (res.id) router.push(`/crm/${res.id}`);
    });
  }

  /** Add Anyway: the SAME form, as it stands on screen, posted again with allow_duplicate=1. */
  function submitAnyway() {
    addAnyway.current = true;
    formRef.current?.requestSubmit();
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
      <form ref={formRef} action={onSubmit} autoComplete="on">
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
            {dup && <DuplicateCustomerAsk match={dup.match} sentence={dup.sentence} onAddAnyway={submitAnyway} pending={pending} />}
            <CustomerFields key={formKey} mode="new" value={form} onChange={change} />
          </div>
        </Modal>
      </form>
    </>
  );
}
