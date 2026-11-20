"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast, type ToastAction } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { translator, fillText } from "@/lib/i18n";
import { convertInquiry } from "../actions";

type Toast = (message: string, kind?: "success" | "error" | "info", action?: ToastAction) => void;
type Words = (key: string) => string;
const ENGLISH: Words = translator("en");
type Convert = (id: string) => Promise<{ ok: boolean; id?: string; error?: string; redirect?: string; contact?: { id: string; name: string; existing: boolean } }>;

/**
 * START AN ESTIMATE (cn-v1170). Erik kept "an estimate without a visit" but took it off the row: this
 * is its home. convertInquiry(id, "quote") makes the estimate and answers where it is; we follow it,
 * as the row's old Estimate verb did. A refusal is said as the server said it.
 */
export async function startLeadEstimate(
  lead: { id: string },
  deps: { convert: Convert; open: (href: string) => void; toast: Toast; t?: Words },
): Promise<void> {
  const t = deps.t ?? ENGLISH;
  const res = await deps.convert(lead.id);
  if (res.ok && res.redirect) {
    deps.open(res.redirect);
    return;
  }
  deps.toast(res.error ?? t("ld_file_couldntStartEstimate"), "error");
}

export function StartEstimateButton({ inquiryId }: { inquiryId: string }) {
  const t = translator(useLang());
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(() => startLeadEstimate({ id: inquiryId }, { convert: (id) => convertInquiry(id, "quote"), open: (href) => router.push(href), toast, t }))
      }
    >
      <FileText className="h-4 w-4" /> {pending ? t("ld_btn_fileStarting") : t("ld_btn_fileStartEstimate")}
    </Button>
  );
}

/**
 * SAVE AS CONTACT, named and on purpose (W2-07, moved from the row's old panel). convertInquiry(id,
 * "customer") checks the book first and never closes the lead; the toast says which happened and
 * offers Open. Nothing navigates on its own.
 */
export async function saveLeadAsContact(
  lead: { id: string; name: string },
  deps: { convert: Convert; toast: Toast; open: (href: string) => void; refresh: () => void; t?: Words },
): Promise<void> {
  const t = deps.t ?? ENGLISH;
  const res = await deps.convert(lead.id);
  if (!res.ok || !res.id) {
    deps.toast(res.error ?? t("ld_file_couldntMakeContact"), "error");
    return;
  }
  const id = res.id;
  const card = res.contact;
  deps.toast(
    card?.existing ? fillText(t("ld_file_linkedTo"), { name: card.name }) : fillText(t("ld_file_savedAsContact"), { name: card?.name || lead.name }),
    "success",
    { label: t("ld_btn_fileOpen"), onClick: () => deps.open(`/crm/${id}`) },
  );
  deps.refresh();
}

export function SaveAsContactButton({ inquiryId, name }: { inquiryId: string; name: string }) {
  const t = translator(useLang());
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(() =>
          saveLeadAsContact(
            { id: inquiryId, name },
            { convert: (id) => convertInquiry(id, "customer", {}), toast, open: (href) => router.push(href), refresh: () => router.refresh(), t },
          ),
        )
      }
    >
      <UserPlus className="h-4 w-4" /> {t("ld_btn_fileSaveAsContact")}
    </Button>
  );
}
