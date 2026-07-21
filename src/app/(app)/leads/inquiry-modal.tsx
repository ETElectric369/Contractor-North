"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Modal, ModalActions } from "@/components/ui/modal";
import { useToast } from "@/components/toast";
import { useDraft } from "@/lib/use-draft";
import { InquiryFields, inquiryFormValue } from "./inquiry-fields";
import { createInquiry, updateInquiry, deleteInquiry } from "./actions";
import type { Inquiry } from "@/lib/types";

// The leads page mounts the "new" button TWICE (header + empty state); only the
// FIRST mounted instance may answer ?new=1 or two modals would stack.
let newParamClaimed = false;

/** New-inquiry button, or (mode="edit") an edit trigger for an existing one. */
export function InquiryModal({ inquiry, mode = "new" }: { inquiry?: Inquiry; mode?: "new" | "edit" }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [confirmDel, setConfirmDel] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const toast = useToast();
  const editing = mode === "edit" && !!inquiry;

  const [form, setForm] = useState(() => inquiryFormValue(inquiry));
  // Remount key for the fields block: phone + address are uncontrolled inside
  // their components and only read defaultValue on mount, so a restored draft
  // (or a reset) needs a remount to actually show.
  const [formKey, setFormKey] = useState(0);

  // Interruption recovery: a deploy reload / iOS killing the tab restores the
  // half-typed lead. Keyed per record when editing so two leads never share.
  const draft = useDraft(
    editing ? "lead-edit:" + inquiry!.id : "lead-new",
    form,
    (f) => {
      setForm({ ...inquiryFormValue(inquiry), ...f });
      setFormKey((k) => k + 1);
    },
  );
  // Dirty = the form differs from a fresh one (covers typed input AND a
  // restored draft; a restored-then-reset form correctly reads clean again).
  const initialSnap = useRef<string | null>(null);
  if (initialSnap.current === null) initialSnap.current = JSON.stringify(inquiryFormValue(inquiry));
  const dirty = JSON.stringify(form) !== initialSnap.current;

  // Open straight from the quick-add menu's "New lead" (/leads?new=1), then
  // strip the param so a refresh or back-button doesn't reopen the form.
  useEffect(() => {
    if (editing) return;
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
  }, [searchParams, pathname, router, editing]);

  function openModal() {
    setConfirmDel(false);
    if (draft.restored && dirty) toast("Draft restored — pick up where you left off", "info");
    setOpen(true);
  }

  // Confirmed close (the Modal's two-tap guard has already asked when dirty) —
  // an explicit discard, so the stored draft goes too.
  function discard() {
    draft.clear();
    setForm(inquiryFormValue(inquiry));
    setFormKey((k) => k + 1);
    setOpen(false);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    // Fragment-first: ANY of name / phone / message makes a valid lead (the
    // missed-call case is a bare phone number) — only a fully empty form blocks.
    if (!form.name.trim() && !form.phone.trim() && !form.message.trim()) {
      setError("Add a name, phone number, or note to save this lead.");
      return;
    }
    start(async () => {
      const res = editing ? await updateInquiry(inquiry!.id, formData) : await createInquiry(formData);
      if (!res.ok) {
        setError(res.error ?? "Something went wrong.");
        return;
      }
      // Saved — drop the draft and reset so reopening doesn't offer a duplicate.
      draft.clear();
      if (!editing) {
        setForm(inquiryFormValue());
        setFormKey((k) => k + 1);
      } else {
        // The saved values ARE the new baseline — reopening starts clean.
        initialSnap.current = JSON.stringify(form);
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      {editing ? (
        <Button size="sm" variant="outline" onClick={openModal}>
          <Pencil className="h-4 w-4" /> Edit
        </Button>
      ) : (
        <Button onClick={openModal}>
          <Plus className="h-4 w-4" /> New Lead
        </Button>
      )}

      <form action={onSubmit}>
        <Modal
          open={open}
          onClose={discard}
          title={editing ? "Edit lead" : "New lead"}
          dirty={dirty}
          footer={
            <ModalActions
              onCancel={discard}
              submit
              saving={pending}
              saveLabel={editing ? "Save Changes" : "Create Lead"}
              // Delete lives on the EDIT lead (Alexa 2026-07-20: "how to delete leads?" —
              // the action existed but had no button). Two-tap confirm so a stray tap can't
              // drop a lead; deleteInquiry revalidates /leads + /planner.
              extra={
                editing ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={confirmDel ? "destructive" : "outline"}
                    disabled={pending}
                    onClick={() => {
                      if (!confirmDel) { setConfirmDel(true); return; }
                      start(async () => {
                        const res = await deleteInquiry(inquiry!.id);
                        if (!res.ok) { setError(res.error ?? "Couldn't delete."); setConfirmDel(false); return; }
                        toast("Lead deleted.", "success");
                        setOpen(false);
                        router.refresh();
                      });
                    }}
                  >
                    <Trash2 className="h-4 w-4" /> {confirmDel ? "Tap to confirm" : "Delete"}
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <div className="space-y-4">
            {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <InquiryFields key={formKey} value={form} onChange={(p) => setForm((f) => ({ ...f, ...p }))} />
          </div>
        </Modal>
      </form>
    </>
  );
}
