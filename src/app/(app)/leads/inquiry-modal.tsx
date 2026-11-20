"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { useDraft } from "@/lib/use-draft";
import { INQUIRY_FORM_KEYS, InquiryFields, customerLeadFormValue, inquiryFormValue, type InquiryFormValue } from "./inquiry-fields";
import { createInquiry, updateInquiry, deleteInquiry } from "./actions";
import { readLeadSources } from "./lead-sources-actions";
import type { Inquiry } from "@/lib/types";
import { createParamClaim } from "@/lib/param-claim";
import { useLang } from "@/components/lang-provider";
import { translator } from "@/lib/i18n";

// The leads page mounts the "new" button TWICE (header + empty state); only the
// FIRST mounted instance may answer ?new=1 or two modals would stack.
// Named per holder (lib/param-claim), so a strip that died on a dropped connection can't
// leave this door shut for the rest of the session.
const newParam = createParamClaim();

/**
 * New-inquiry button, or (mode="edit") an edit trigger for an existing one.
 *
 * THE LEAD'S ONE FORM, OPENED WHERE THE LEAD IS READ (cn-v1157). Erik, 2026-11-10, after an estimate
 * printed a lead's half-typed address: "because it was a lead i had to find the lead on the leads page
 * to update the address there since it wasnt accessible from anywhere else". The estimate's card opens
 * this same form now (quotes/[id]/customer-select) — one editor, a second door to it. Whoever mounts it
 * hands it the WHOLE lead row: the save writes every field the form holds (leads/actions updateInquiry),
 * so a row read with a short select list would blank what it did not carry.
 *
 * A NEW LEAD FOR A CUSTOMER ALREADY ON FILE (cn-v1173). The owner, 2026-11-19: "i would like to
 * promote the workflow starting with new lead which could be an existing client with a new job but it
 * gets the information in the right place". The customer's page (crm/[id], its Requests tab) hands this
 * form the customer: a NEW form starts from them through the same person block (their street and town
 * are a suggestion: typing a different street drops their city, state and ZIP, as for a pick made in
 * this sitting; untouched, their place posts whole), posts their id so createInquiry links THAT
 * customer, and a save lands on the new lead's file, where Schedule is. That mount never answers the
 * Leads page's ?new=1, and keeps its draft apart from the Leads page's. Opened clean, it starts from the
 * customer as the page hands them NOW (an Edit Customer made on the same page is what it shows), and a
 * form nobody typed in is never kept as that customer's draft.
 */
export type LeadCustomer = {
  id: string;
  name: string | null;
  company_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export function InquiryModal({
  inquiry,
  mode = "new",
  trigger = "button",
  noDelete = false,
  customer,
}: {
  inquiry?: Inquiry;
  mode?: "new" | "edit";
  /** How the edit door is drawn: "quiet", a small named door beside the thing it edits (the
   *  estimate's lead card), or "details", the lead's Edit Details button among its doors (cn-v1170:
   *  "if Edit Details is the only option under the ... then just say Edit Details instead of ...").
   *  "button" is the New Lead button; an edit given it draws Edit Details. */
  trigger?: "button" | "quiet" | "details";
  /** True where the lead is corrected from another record's page: Delete Lead stays on the Leads
   *  page, behind its own warning, and never sits beside an estimate. */
  noDelete?: boolean;
  /** A new lead started from this customer's page: the form is seeded from them and posts their id. */
  customer?: LeadCustomer;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [confirmDel, setConfirmDel] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const toast = useToast();
  const t = translator(useLang());
  const editing = mode === "edit" && !!inquiry;
  /** The customer this new lead is for, or null (the Leads page's own New Lead, or an edit). */
  const forCustomer = !editing && customer ? customer : null;
  /** The form as it starts: the lead as it is, or (a customer's new lead) the customer in the person block. */
  const blank = (): InquiryFormValue => (forCustomer ? customerLeadFormValue(forCustomer) : inquiryFormValue(inquiry));

  const [form, setForm] = useState(blank);
  // Remount key for the fields block: phone + address are uncontrolled inside
  // their components and only read defaultValue on mount, so a restored draft
  // (or a reset) needs a remount to actually show.
  const [formKey, setFormKey] = useState(0);

  // Interruption recovery: a deploy reload / iOS killing the tab restores the
  // half-typed lead. Keyed per record when editing so two leads never share.
  const draft = useDraft(
    editing ? "lead-edit:" + inquiry!.id : forCustomer ? "lead-new:customer:" + forCustomer.id : "lead-new",
    form,
    (f) => {
      // Only the form's own keys: a draft kept by the older form (Kind, How Long) restores clean.
      const next = blank();
      for (const k of INQUIRY_FORM_KEYS) if (f && k in f) (next as unknown as Record<string, unknown>)[k] = (f as Partial<InquiryFormValue>)[k];
      setForm(next);
      setFormKey((k) => k + 1);
    },
  );

  // THE COMPANY'S LEAD SOURCES (cn-v1170), read when the form opens: once per opening, never per row.
  // A failed read is said under the select; the lead's own source is offered either way.
  const [sources, setSources] = useState<string[] | null>(null);
  const [sourcesFailed, setSourcesFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setSourcesFailed(false);
    readLeadSources()
      .then((r) => {
        if (!alive) return;
        if (r.ok) setSources(r.sources);
        else setSourcesFailed(true);
      })
      .catch(() => alive && setSourcesFailed(true));
    return () => {
      alive = false;
    };
  }, [open]);
  // Dirty = the form differs from a fresh one (covers typed input AND a
  // restored draft; a restored-then-reset form correctly reads clean again).
  const initialSnap = useRef<string | null>(null);
  if (initialSnap.current === null) initialSnap.current = JSON.stringify(blank());
  const dirty = JSON.stringify(form) !== initialSnap.current;

  // A CUSTOMER'S FORM NOBODY TYPED IN IS NEVER THEIR DRAFT (cn-v1173). Its fresh form is the customer
  // seeded, not blank, so the draft's mirror would keep the seed after every save, discard or re-seed,
  // and a later open would say a draft was restored for words nobody typed (and show an old copy of the
  // customer). This runs after the draft's own mirror, so a pristine form's pending write is dropped.
  // The first pass is skipped: the draft is being read back then, never written.
  const draftSeen = useRef(false);
  const clearDraft = draft.clear;
  const pristineForCustomer = !!forCustomer && !dirty;
  useEffect(() => {
    if (!draftSeen.current) {
      draftSeen.current = true;
      return;
    }
    if (pristineForCustomer) clearDraft();
  }, [form, pristineForCustomer, clearDraft]);

  // This instance's name on the ?new=1 claim; it lets go on unmount as well as below.
  const claimant = useId();
  useEffect(() => () => newParam.release(claimant), [claimant]);

  // Open straight from the quick-add menu's "New lead" (/leads?new=1), then
  // strip the param so a refresh or back-button doesn't reopen the form. A customer's own New Lead
  // never answers it: the claim is the Leads page's.
  useEffect(() => {
    if (editing || forCustomer) return;
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
  }, [searchParams, pathname, router, editing, forCustomer, claimant]);

  function openModal() {
    setConfirmDel(false);
    if (draft.restored && dirty) toast(t("ld_draftRestored"), "info");
    // OPENED CLEAN, IT STARTS FROM THE LEAD AS IT IS NOW (cn-v1157). The form kept the values it was
    // mounted with, and its save writes every field it holds — fine on the Leads page, which is asked
    // again after each change, but the estimate's card keeps this mounted for as long as the estimate
    // is open: a lead corrected elsewhere in the meantime would have been written back whole from the
    // old copy. Nothing typed is lost: a form with unsaved words (or a restored draft) is left alone.
    // The fields are re-seeded BEFORE the sheet opens; the sheet itself is never remounted.
    // A customer's New Lead the same way (cn-v1173): the customer as the page hands them now, so an
    // Edit Customer made on the same page is what the form starts from.
    if ((editing || forCustomer) && !dirty) {
      const fresh = blank();
      const snap = JSON.stringify(fresh);
      if (snap !== initialSnap.current) {
        initialSnap.current = snap;
        setForm(fresh);
        setFormKey((k) => k + 1);
      }
    }
    setOpen(true);
  }

  // Confirmed close (the Modal's two-tap guard has already asked when dirty) —
  // an explicit discard, so the stored draft goes too.
  function discard() {
    draft.clear();
    resetNew();
    setOpen(false);
  }

  /** A new form back to fresh, with its baseline: for a customer's form the fresh one is the customer
   *  as handed in now, so the baseline moves with it and the reset reads clean (never a draft). */
  function resetNew() {
    const fresh = blank();
    if (!editing) initialSnap.current = JSON.stringify(fresh);
    setForm(fresh);
    setFormKey((k) => k + 1);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    // Fragment-first: ANY of name / phone / message makes a valid lead (the
    // missed-call case is a bare phone number) — only a fully empty form blocks.
    if (!form.name.trim() && !form.phone.trim() && !form.message.trim()) {
      setError(t("ld_addSomethingToSave"));
      return;
    }
    start(async () => {
      const res = editing ? await updateInquiry(inquiry!.id, formData) : await createInquiry(formData);
      if (!res.ok) {
        setError(res.error ?? t("ld_somethingWrong"));
        return;
      }
      // NOTHING SILENT. When the lead recognised an existing customer and pulled their phone or
      // address across — or found two people with that name and deliberately linked NEITHER —
      // say so. A field that fills itself without explanation is how somebody stops trusting a
      // form, and a duplicate created in silence is exactly the friction this fixes.
      const note = (res as { note?: string }).note;
      if (note) toast(note, "success");
      // Saved — drop the draft and reset so reopening doesn't offer a duplicate.
      draft.clear();
      if (!editing) {
        resetNew();
      } else {
        // The saved values ARE the new baseline — reopening starts clean.
        initialSnap.current = JSON.stringify(form);
      }
      setOpen(false);
      // From a customer's page the next step is the lead's own file, where Schedule is.
      if (forCustomer && res.id) router.push(`/leads/${res.id}`);
      else router.refresh();
    });
  }

  return (
    <>
      {editing && trigger === "quiet" ? (
        <button
          type="button"
          onClick={openModal}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
        >
          <Pencil className="h-4 w-4 shrink-0" /> {t("ld_btn_editLead")}
        </button>
      ) : editing ? (
        // cn-v1170: every other edit door is Edit Details (the old outline Edit had no caller left).
        <Button variant="secondary" onClick={openModal}>
          {t("ld_btn_editDetails")}
        </Button>
      ) : (
        <Button onClick={openModal}>
          <Plus className="h-4 w-4" /> {t("ld_btn_newLead")}
        </Button>
      )}

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={discard}
          title={editing ? t("ld_btn_editLead") : t("ld_btn_newLead")}
          dirty={dirty}
          footer={
            <ModalActions
              onCancel={discard}
              submit
              saving={pending}
              saveLabel={editing ? t("ld_btn_saveChanges") : t("ld_btn_createLead")}
              // Delete lives on the EDIT lead (Alexa 2026-07-20: "how to delete leads?" —
              // the action existed but had no button). Two-tap confirm so a stray tap can't
              // drop a lead; deleteInquiry revalidates /leads + /planner.
              extra={
                editing && !noDelete ? (
                  <Button
                    type="button"
                    variant={confirmDel ? "destructive" : "outline"}
                    disabled={pending}
                    onClick={() => {
                      if (!confirmDel) { setConfirmDel(true); return; }
                      start(async () => {
                        const res = await deleteInquiry(inquiry!.id);
                        if (!res.ok) { setError(res.error ?? t("ld_couldntDelete")); setConfirmDel(false); return; }
                        toast(t("ld_leadDeleted"), "success");
                        setOpen(false);
                        router.refresh();
                      });
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> {confirmDel ? t("ld_btn_tapToConfirm") : t("ld_btn_deleteLead")}
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <div className="space-y-4">
            {forCustomer && <input type="hidden" name="customer_id" value={forCustomer.id} />}
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <InquiryFields key={formKey} value={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} sources={sources} sourcesFailed={sourcesFailed} seededTownIsSuggestion={!!forCustomer} />
          </div>
        </Modal>
      </form>
    </>
  );
}
